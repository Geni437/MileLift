import 'react-native-get-random-values';

/**
 * RFC 4122 v4 UUID generator. Used for every client-generated primary key
 * that doubles as an idempotency key (architecture §3.4) — currently
 * `user_consents.id`. Hermes does not implement `crypto.randomUUID()`, so we
 * build a v4 UUID from `crypto.getRandomValues` (polyfilled by
 * react-native-get-random-values) instead of depending on an API that may
 * not exist on-device.
 */
export function generateUuidV4(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));

  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
