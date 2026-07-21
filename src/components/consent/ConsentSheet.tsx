import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '../../theme';
import { MeridianMark } from '../MeridianMark';
import { LockGlyph } from '../LockGlyph';
import { PrimaryButton } from '../PrimaryButton';
import { SecondaryButton } from '../SecondaryButton';
import { CONSENT_CONTENT } from './consentContent';
import type { ConsentCategory } from '../../db/types';

type Props = {
  visible: boolean;
  category: ConsentCategory;
  loading?: boolean;
  onAllow: () => void;
  onDecline: () => void;
};

/**
 * The priming sheet that precedes the OS permission prompt
 * (screens-phase-0.md §E rule 5). Per-category, never bundled; two
 * equal-weight buttons (rule 4); states what MileLift won't do (rule 3).
 */
export function ConsentSheet({ visible, category, loading, onAllow, onDecline }: Props) {
  const content = CONSENT_CONTENT[category];

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDecline} statusBarTranslucent>
      <View style={[styles.scrim, { backgroundColor: theme.color.bg.overlay }]}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onDecline}
          accessibilityLabel="Dismiss"
          accessibilityRole="button"
        />
        <SafeAreaView edges={['bottom']} style={styles.sheetWrap}>
          <View
            style={[styles.sheet, { backgroundColor: theme.color.bg.raised }]}
            accessibilityViewIsModal
            accessibilityRole="none"
          >
            <View style={[styles.header, category === 'body_image' && { backgroundColor: theme.color.bg.inset, padding: theme.space.sm, borderRadius: theme.radius.md, alignSelf: 'flex-start' }]}>
              {category === 'body_image' ? <LockGlyph size={28} /> : <MeridianMark variant="glyph" size={40} />}
            </View>

            <Text style={[styles.title, { color: theme.color.text.primary }]} maxFontSizeMultiplier={2}>
              {content.title}
            </Text>

            <Text style={[styles.purpose, { color: theme.color.text.primary }]} maxFontSizeMultiplier={2}>
              {content.purpose}
            </Text>

            <View style={[styles.wontDoRow, { borderColor: theme.color.border.subtle }]}>
              <Text style={[styles.wontDoLabel, { color: content.accentColor }]} maxFontSizeMultiplier={2}>
                What MileLift won’t do
              </Text>
              <Text style={[styles.wontDoBody, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
                {content.wontDo}
              </Text>
            </View>

            <View style={styles.actions}>
              <PrimaryButton label={content.allowLabel} onPress={onAllow} loading={loading} />
              <SecondaryButton label={content.declineLabel} onPress={onDecline} disabled={loading} />
            </View>

            <Text style={[styles.footnote, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
              {content.footnote}
            </Text>
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
  header: {
    alignItems: 'flex-start',
  },
  title: {
    ...theme.type.title,
  },
  purpose: {
    ...theme.type.bodyLg,
  },
  wontDoRow: {
    borderTopWidth: theme.border.hairline,
    paddingTop: theme.space.md,
    gap: theme.space.xxs,
  },
  wontDoLabel: {
    ...theme.type.label,
    textTransform: 'uppercase',
  },
  wontDoBody: {
    ...theme.type.body,
  },
  actions: {
    gap: theme.space.sm,
  },
  footnote: {
    ...theme.type.caption,
  },
});
