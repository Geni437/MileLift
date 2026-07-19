import React, { useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { theme } from '../theme';
import { SecondaryButton } from './SecondaryButton';
import { signInWithOAuth, type OAuthProvider } from '../lib/oauth';
import type { AuthErrorResult } from '../lib/authErrors';

type Props = {
  disabled?: boolean;
  onError: (error: AuthErrorResult) => void;
};

/**
 * "Continue with Apple" / "Continue with Google" — screens-phase-0.md §B.
 * Apple is offered on iOS per Apple's own presentation requirement when an
 * Apple sign-in option is shown at all; Google is offered everywhere.
 */
export function OAuthRow({ disabled, onError }: Props) {
  const [loadingProvider, setLoadingProvider] = useState<OAuthProvider | null>(null);

  const handlePress = async (provider: OAuthProvider) => {
    setLoadingProvider(provider);
    const result = await signInWithOAuth(provider);
    setLoadingProvider(null);
    if (!result.ok && !('cancelled' in result)) {
      onError(result.error);
    }
    // A user-initiated cancel is not an error state — no banner, they just land back on the form.
  };

  const anyLoading = loadingProvider !== null;

  return (
    <View style={styles.container}>
      {Platform.OS === 'ios' && (
        <SecondaryButton
          label="Continue with Apple"
          onPress={() => handlePress('apple')}
          loading={loadingProvider === 'apple'}
          disabled={disabled || (anyLoading && loadingProvider !== 'apple')}
        />
      )}
      <SecondaryButton
        label="Continue with Google"
        onPress={() => handlePress('google')}
        loading={loadingProvider === 'google'}
        disabled={disabled || (anyLoading && loadingProvider !== 'google')}
      />
    </View>
  );
}

export function OrDivider() {
  return (
    <View style={styles.dividerRow}>
      <View style={[styles.dividerLine, { backgroundColor: theme.color.border.subtle }]} />
      <Text style={[styles.dividerLabel, { color: theme.color.text.tertiary }]}>OR</Text>
      <View style={[styles.dividerLine, { backgroundColor: theme.color.border.subtle }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: theme.space.sm,
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.sm,
  },
  dividerLine: {
    flex: 1,
    height: theme.border.hairline,
  },
  dividerLabel: {
    ...theme.type.overline,
  },
});
