import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import 'react-native-get-random-values';
import * as aesjs from 'aes-js';

/**
 * Secure storage adapter for the Supabase Auth session (access + refresh
 * tokens), per mobile-architecture-standards: "Auth tokens ... platform
 * secure storage ... never a plain key-value store, never plain SQLite
 * columns."
 *
 * `expo-secure-store` alone (iOS Keychain / Android Keystore-backed) has a
 * ~2048-byte per-item limit on some Android configurations, and a Supabase
 * session object (access token + refresh token + user metadata) can exceed
 * that. The standard pattern (documented by Supabase for Expo) is:
 *   - Generate a random AES key per storage key, store THAT key in
 *     SecureStore (small, fits the Keychain/Keystore comfortably).
 *   - Encrypt the actual session payload with it and store the ciphertext in
 *     AsyncStorage.
 * The session value itself never touches AsyncStorage in plaintext — only
 * ciphertext does, and the decryption key never leaves platform secure
 * storage. This satisfies the "never a plain key-value store" rule while
 * working around the item-size limit.
 */
class SecureSessionStorage {
  private async encrypt(key: string, value: string): Promise<string> {
    const encryptionKey = crypto.getRandomValues(new Uint8Array(32));
    const cipher = new aesjs.ModeOfOperation.ctr(encryptionKey, new aesjs.Counter(1));
    const encryptedBytes = cipher.encrypt(aesjs.utils.utf8.toBytes(value));

    await SecureStore.setItemAsync(this.keyName(key), aesjs.utils.hex.fromBytes(encryptionKey));

    return aesjs.utils.hex.fromBytes(encryptedBytes);
  }

  private async decrypt(key: string, value: string): Promise<string | null> {
    const encryptionKeyHex = await SecureStore.getItemAsync(this.keyName(key));
    if (!encryptionKeyHex) {
      // No key means we can't have produced this ciphertext (or it was
      // cleared) — treat as absent rather than throwing, so a corrupted/
      // partial state degrades to "logged out," not a crash.
      return null;
    }

    const cipher = new aesjs.ModeOfOperation.ctr(aesjs.utils.hex.toBytes(encryptionKeyHex), new aesjs.Counter(1));
    const decryptedBytes = cipher.decrypt(aesjs.utils.hex.toBytes(value));
    return aesjs.utils.utf8.fromBytes(decryptedBytes);
  }

  private keyName(key: string): string {
    // SecureStore keys must match [A-Za-z0-9._-]+ — Supabase's storage keys
    // already do, but this keeps us defensive against a future key format.
    return `mllift_${key.replace(/[^A-Za-z0-9._-]/g, '_')}`;
  }

  async getItem(key: string): Promise<string | null> {
    try {
      const encrypted = await AsyncStorage.getItem(key);
      if (!encrypted) return null;
      return await this.decrypt(key, encrypted);
    } catch {
      // A corrupted encrypted blob (e.g. app data partially restored from a
      // backup) must never crash session bootstrap — fail into "no session,"
      // which the auth layer already treats as a first-class logged-out state.
      return null;
    }
  }

  async setItem(key: string, value: string): Promise<void> {
    const encrypted = await this.encrypt(key, value);
    await AsyncStorage.setItem(key, encrypted);
  }

  async removeItem(key: string): Promise<void> {
    await AsyncStorage.removeItem(key);
    await SecureStore.deleteItemAsync(this.keyName(key));
  }
}

export const secureSessionStorage = new SecureSessionStorage();
