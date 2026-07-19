import React, { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { Field } from '../Field';
import { SyncStatusPill } from '../SyncStatusPill';
import { SectionCard } from './SectionCard';
import { runSync } from '../../sync/syncEngine';
import type { LocalProfile } from '../../db/types';

type Props = {
  profile: LocalProfile;
  email: string | null;
  onSave: (fields: { displayName?: string | null; username?: string | null }) => Promise<void>;
};

/**
 * Identity section (screens-phase-0.md §F.1). Avatar upload is intentionally
 * NOT wired to real storage: Supabase Storage buckets for photos are
 * explicitly Phase 2+ scope (architecture §6 "Storage ... Phase 2+ but the
 * boundary is stated now") and were not part of the "verified working"
 * Phase 0 backend (only profiles/profile_health/user_consents/
 * timeline_events). Rather than fake an upload against a bucket that
 * doesn't exist, tapping the avatar says so honestly.
 */
export function IdentitySection({ profile, email, onSave }: Props) {
  const [displayName, setDisplayName] = useState(profile.displayName ?? '');
  const [username, setUsername] = useState(profile.username ?? '');

  const handleAvatarPress = () => {
    Alert.alert('Coming soon', 'Profile photo uploads arrive in a later phase, once photo storage is built.');
  };

  const handleDisplayNameBlur = async () => {
    if (displayName === (profile.displayName ?? '')) return;
    await onSave({ displayName: displayName.trim() || null });
    void runSync('post-write');
  };

  const handleUsernameBlur = async () => {
    if (username === (profile.username ?? '')) return;
    await onSave({ username: username.trim() || null });
    void runSync('post-write');
  };

  return (
    <SectionCard title="Identity">
      <View style={styles.avatarRow}>
        <Pressable
          onPress={handleAvatarPress}
          accessibilityRole="button"
          accessibilityLabel="Change profile photo"
          style={[styles.avatar, { backgroundColor: theme.color.bg.inset, borderColor: theme.color.border.default }]}
        >
          <Text style={[theme.type.heading, { color: theme.color.text.secondary }]}>
            {(profile.displayName || profile.username || email || '?').charAt(0).toUpperCase()}
          </Text>
        </Pressable>
        <View style={styles.identityMeta}>
          <Text style={[theme.type.title, { color: theme.color.text.primary }]}>
            {profile.displayName || 'Add your name'}
          </Text>
          <Text style={[theme.type.body, { color: theme.color.text.secondary }]}>
            {profile.username ? `@${profile.username}` : 'No username yet'}
          </Text>
        </View>
        <SyncStatusPill status={profile.syncStatus} onRetry={() => void runSync('manual')} />
      </View>

      <Field label="Display name" value={displayName} onChangeText={setDisplayName} onBlur={handleDisplayNameBlur} autoCapitalize="words" />
      <Field label="Username" value={username} onChangeText={setUsername} onBlur={handleUsernameBlur} autoCapitalize="none" />
    </SectionCard>
  );
}

const styles = StyleSheet.create({
  avatarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.sm,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: theme.radius.pill,
    borderWidth: theme.border.hairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  identityMeta: {
    flex: 1,
    gap: theme.space.xxs,
  },
});
