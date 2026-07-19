import React from 'react';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { PrimaryButton } from '../PrimaryButton';
import { SecondaryButton } from '../SecondaryButton';
import type { RecordingStatus } from '../../db/types';

type Props = {
  status: 'ready' | RecordingStatus;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onFinish: () => void;
  starting?: boolean;
};

/**
 * RecordControl — the record/pause/resume/finish cluster (CORE-01). Finish
 * is deliberately reachable ONLY from Paused (design doc: "you cannot end a
 * run with one stray tap mid-stride"). Every control is
 * `touchTarget.comfortable` — gloved/cold-hands/mid-stride use.
 */
export function RecordControl({ status, onStart, onPause, onResume, onFinish, starting }: Props) {
  if (status === 'ready') {
    return (
      <View style={styles.container}>
        <PrimaryButton label="Start" onPress={onStart} loading={starting} testID="record-start-button" />
      </View>
    );
  }

  if (status === 'recording') {
    return (
      <View style={styles.container}>
        <PrimaryButton label="Pause" onPress={onPause} testID="record-pause-button" />
      </View>
    );
  }

  return (
    <View style={[styles.container, styles.row]}>
      <View style={styles.half}>
        <PrimaryButton label="Resume" onPress={onResume} testID="record-resume-button" />
      </View>
      <View style={styles.half}>
        <SecondaryButton label="Finish" onPress={onFinish} testID="record-finish-button" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  row: {
    flexDirection: 'row',
    gap: theme.space.sm,
  },
  half: {
    flex: 1,
  },
});
