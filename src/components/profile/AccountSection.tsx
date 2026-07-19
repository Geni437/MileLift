import React, { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { SectionCard } from './SectionCard';
import { PrimaryButton } from '../PrimaryButton';
import { SecondaryButton } from '../SecondaryButton';
import { TextButton } from '../TextButton';
import { InlineBanner } from '../InlineBanner';
import { Field } from '../Field';

type Props = {
  email: string | null;
  signInMethods: string[];
  onLogOut: () => Promise<void>;
  onRequestDeletion: () => Promise<void>;
};

const DELETE_CONFIRM_PHRASE = 'DELETE';

/** screens-phase-0.md §F.6 + the Export/Delete rows from §F.5's bottom. */
export function AccountSection({ email, signInMethods, onLogOut, onRequestDeletion }: Props) {
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deletionRequested, setDeletionRequested] = useState(false);

  const handleExport = () => {
    Alert.alert(
      'Not available yet',
      "Data export isn't built yet — it's planned for a later phase. Contact support if you need your data before then."
    );
  };

  const handleConfirmDelete = async () => {
    if (deleteConfirmText.trim().toUpperCase() !== DELETE_CONFIRM_PHRASE) return;
    setDeleting(true);
    await onRequestDeletion();
    setDeleting(false);
    setDeleteConfirmVisible(false);
    setDeletionRequested(true);
  };

  return (
    <SectionCard title="Account">
      <View style={styles.row}>
        <Text style={[theme.type.label, { color: theme.color.text.secondary }]}>Email</Text>
        <Text style={[theme.type.body, { color: theme.color.text.primary }]}>{email ?? '—'}</Text>
      </View>
      <View style={styles.row}>
        <Text style={[theme.type.label, { color: theme.color.text.secondary }]}>Signed in with</Text>
        <Text style={[theme.type.body, { color: theme.color.text.primary }]}>{signInMethods.join(', ') || 'Email'}</Text>
      </View>

      <SecondaryButton label="Log out" onPress={() => void onLogOut()} />

      <View style={styles.divider} />

      <TextButton label="Export my data" onPress={handleExport} />

      {deletionRequested ? (
        <InlineBanner
          tone="warning"
          message="Account deletion requested. Your account and data will be permanently deleted in 30 days."
        />
      ) : !deleteConfirmVisible ? (
        <TextButton label="Delete account" danger onPress={() => setDeleteConfirmVisible(true)} />
      ) : (
        <View style={styles.deleteConfirm}>
          <Text style={[theme.type.bodyStrong, { color: theme.color.feedback.danger }]}>
            This permanently deletes your account and everything in it — activities, nutrition, workouts, photos — within
            30 days. This can&apos;t be undone.
          </Text>
          <Text style={[theme.type.caption, { color: theme.color.text.secondary }]}>
            Type {DELETE_CONFIRM_PHRASE} to confirm.
          </Text>
          <Field
            label="Confirmation"
            value={deleteConfirmText}
            onChangeText={setDeleteConfirmText}
            autoCapitalize="characters"
            autoCorrect={false}
          />
          <View style={styles.deleteActions}>
            <PrimaryButton
              tone="danger"
              label="Delete my account"
              onPress={handleConfirmDelete}
              loading={deleting}
              disabled={deleteConfirmText.trim().toUpperCase() !== DELETE_CONFIRM_PHRASE}
            />
            <TextButton label="Cancel" onPress={() => setDeleteConfirmVisible(false)} disabled={deleting} />
          </View>
        </View>
      )}
    </SectionCard>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: theme.touchTarget.min,
  },
  divider: {
    height: theme.border.hairline,
    backgroundColor: theme.color.border.subtle,
  },
  deleteConfirm: {
    gap: theme.space.sm,
  },
  deleteActions: {
    gap: theme.space.xs,
    alignItems: 'center',
  },
});
