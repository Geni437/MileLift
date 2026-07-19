import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { Field } from '../Field';
import { TextButton } from '../TextButton';
import { EmptyState } from '../EmptyState';
import { SectionCard } from './SectionCard';
import type { LocalProfileHealth, Sex } from '../../db/types';

const SEX_OPTIONS: { label: string; value: Sex }[] = [
  { label: 'Female', value: 'female' },
  { label: 'Male', value: 'male' },
  { label: 'Intersex', value: 'intersex' },
  { label: 'Other', value: 'other' },
  { label: 'Prefer not to say', value: 'prefer_not_to_say' },
];

const DOB_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CM_PER_INCH = 2.54;

type Props = {
  hasHealthConsent: boolean;
  profileHealth: LocalProfileHealth | null;
  unitDistance: 'km' | 'mi';
  onRequestConsent: () => void;
  onSave: (fields: { sex?: Sex | null; dateOfBirth?: string | null; heightCm?: number | null }) => Promise<void>;
};

/**
 * screens-phase-0.md §F.4. Collapsed by default; consent-gated (both in the
 * UI here AND enforced at the DB level by `enforce_health_consent` — this
 * component's gate is a UX convenience, not the actual security boundary).
 */
export function HealthDetailsSection({ hasHealthConsent, profileHealth, unitDistance, onRequestConsent, onSave }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [dobInput, setDobInput] = useState(profileHealth?.dateOfBirth ?? '');
  const [dobError, setDobError] = useState<string | null>(null);
  const [heightInput, setHeightInput] = useState(profileHealth?.heightCm != null ? String(profileHealth.heightCm) : '');
  const [heightError, setHeightError] = useState<string | null>(null);

  if (!hasHealthConsent) {
    return (
      <SectionCard title="Health details (optional)">
        <EmptyState
          title="Add height, sex, or date of birth"
          body="Optional. Add these only if you want more accurate calorie and recovery estimates — they&apos;re stored privately and never shown to anyone."
          actionLabel="Connect health data"
          onAction={onRequestConsent}
        />
      </SectionCard>
    );
  }

  if (!expanded) {
    return (
      <SectionCard title="Health details (optional)">
        <Text style={[theme.type.body, { color: theme.color.text.secondary }]}>
          Optional. Add these only if you want more accurate calorie and recovery estimates — they&apos;re stored privately and
          never shown to anyone.
        </Text>
        <TextButton label="Add details" onPress={() => setExpanded(true)} />
      </SectionCard>
    );
  }

  const handleDobBlur = async () => {
    const trimmed = dobInput.trim();
    if (trimmed.length === 0) {
      setDobError(null);
      if (profileHealth?.dateOfBirth) await onSave({ dateOfBirth: null });
      return;
    }
    if (!DOB_PATTERN.test(trimmed) || Number.isNaN(Date.parse(trimmed))) {
      setDobError('Use the format YYYY-MM-DD.');
      return;
    }
    const date = new Date(trimmed);
    const now = new Date();
    const minDate = new Date(now.getFullYear() - 120, now.getMonth(), now.getDate());
    if (date > now || date < minDate) {
      setDobError('Enter a realistic date of birth.');
      return;
    }
    setDobError(null);
    await onSave({ dateOfBirth: trimmed });
  };

  const handleHeightBlur = async () => {
    const trimmed = heightInput.trim();
    if (trimmed.length === 0) {
      setHeightError(null);
      if (profileHealth?.heightCm != null) await onSave({ heightCm: null });
      return;
    }
    const value = Number(trimmed);
    if (!Number.isFinite(value) || value <= 0 || value >= 300) {
      setHeightError('Enter a height in centimeters between 1 and 300.');
      return;
    }
    setHeightError(null);
    await onSave({ heightCm: value });
  };

  const heightCmValue = Number(heightInput);
  const heightHelper =
    unitDistance === 'mi' && Number.isFinite(heightCmValue) && heightCmValue > 0
      ? `≈ ${(heightCmValue / CM_PER_INCH / 12).toFixed(0)} ft ${Math.round((heightCmValue / CM_PER_INCH) % 12)} in`
      : 'Centimeters';

  return (
    <SectionCard title="Health details (optional)">
      <View style={styles.sexRow}>
        <Text style={[theme.type.label, { color: theme.color.text.secondary }]}>Sex</Text>
        <View style={styles.sexOptions} accessibilityRole="radiogroup">
          {SEX_OPTIONS.map((option) => {
            const selected = profileHealth?.sex === option.value;
            return (
              <Pressable
                key={option.value}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                accessibilityLabel={option.label}
                onPress={() => onSave({ sex: selected ? null : option.value })}
                style={[
                  styles.chip,
                  {
                    borderColor: theme.color.border.default,
                    backgroundColor: selected ? theme.color.bg.inset : 'transparent',
                  },
                ]}
              >
                <Text style={[theme.type.label, { color: theme.color.text.primary }]}>{option.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <Field
        label="Date of birth"
        value={dobInput}
        onChangeText={setDobInput}
        onBlur={handleDobBlur}
        errorText={dobError}
        helperText={!dobError ? 'YYYY-MM-DD' : undefined}
        keyboardType="numbers-and-punctuation"
        placeholder="1990-05-14"
      />

      <Field
        label="Height"
        value={heightInput}
        onChangeText={setHeightInput}
        onBlur={handleHeightBlur}
        errorText={heightError}
        helperText={!heightError ? heightHelper : undefined}
        keyboardType="decimal-pad"
      />

      <TextButton label="Collapse" onPress={() => setExpanded(false)} />
    </SectionCard>
  );
}

const styles = StyleSheet.create({
  sexRow: {
    gap: theme.space.xs,
  },
  sexOptions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.space.xs,
  },
  chip: {
    minHeight: theme.touchTarget.min,
    borderRadius: theme.radius.pill,
    borderWidth: theme.border.hairline,
    paddingHorizontal: theme.space.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
