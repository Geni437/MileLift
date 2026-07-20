import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '../theme';
import { PrimaryButton } from './PrimaryButton';
import { TextButton } from './TextButton';

type Props = {
  visible: boolean;
  /** e.g. "Discard this recording?" / "Delete this activity?" — a question, not a verb. */
  title: string;
  /** Names the specific consequence in the user's terms (destructive-action rule, screens-phase-0.md §F). */
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Themed destructive-confirm bottom sheet — replaces OS `Alert.alert` for
 * any irreversible action (discard a recording, delete an activity, etc.).
 * `Alert.alert` renders as an unstyled native dialog that breaks dark
 * theme/typography/radius entirely; this reuses the same Modal/scrim/sheet
 * shell as `ConsentSheet` so destructive confirms match the rest of the
 * app. `feedback.dangerSolid` (via `PrimaryButton tone="danger"`) is used
 * only on the confirming action, never the entry point — per
 * screens-phase-0.md §F's destructive-action rule.
 */
export function ConfirmSheet({ visible, title, body, confirmLabel, cancelLabel = 'Cancel', loading, onConfirm, onCancel }: Props) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel} statusBarTranslucent>
      <View style={[styles.scrim, { backgroundColor: theme.color.bg.overlay }]}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={loading ? undefined : onCancel}
          accessibilityLabel="Dismiss"
          accessibilityRole="button"
        />
        <SafeAreaView edges={['bottom']} style={styles.sheetWrap}>
          <View
            style={[styles.sheet, { backgroundColor: theme.color.bg.raised }]}
            accessibilityViewIsModal
            accessibilityRole="none"
          >
            <Text style={[theme.type.title, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>
              {title}
            </Text>
            <Text style={[theme.type.body, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
              {body}
            </Text>
            <View style={styles.actions}>
              <PrimaryButton tone="danger" label={confirmLabel} onPress={onConfirm} loading={loading} />
              <TextButton label={cancelLabel} onPress={onCancel} disabled={loading} />
            </View>
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheetWrap: {
    width: '100%',
  },
  sheet: {
    borderTopLeftRadius: theme.radius.xl,
    borderTopRightRadius: theme.radius.xl,
    padding: theme.space.lg,
    gap: theme.space.md,
  },
  actions: {
    gap: theme.space.sm,
  },
});
