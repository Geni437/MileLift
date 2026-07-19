import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Link } from 'expo-router';

import { theme } from '../../src/theme';
import { Screen } from '../../src/components/Screen';
import { MeridianMark } from '../../src/components/MeridianMark';
import { Field } from '../../src/components/Field';
import { PrimaryButton } from '../../src/components/PrimaryButton';
import { TextButton } from '../../src/components/TextButton';
import { InlineBanner } from '../../src/components/InlineBanner';
import { OAuthRow, OrDivider } from '../../src/components/OAuthRow';
import { useAuth } from '../../src/state/AuthContext';
import { useNetworkStatus } from '../../src/hooks/useNetworkStatus';
import type { AuthErrorResult } from '../../src/lib/authErrors';

export default function LogInScreen() {
  const { signIn, resendVerificationEmail, requestPasswordReset } = useAuth();
  const { isOnline } = useNetworkStatus();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendSent, setResendSent] = useState(false);
  const [error, setError] = useState<AuthErrorResult | null>(null);
  const [resetState, setResetState] = useState<'idle' | 'needs-email' | 'sending' | 'sent'>('idle');

  const canSubmit = email.trim().length > 0 && password.length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    setResendSent(false);
    const result = await signIn(email.trim(), password);
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error);
    }
    // On success, AuthContext's session flips and Stack.Protected redirects.
  };

  const handleResend = async () => {
    setResending(true);
    const result = await resendVerificationEmail(email.trim());
    setResending(false);
    setResendSent(result.ok);
  };

  const handleForgotPassword = async () => {
    if (email.trim().length === 0) {
      setResetState('needs-email');
      return;
    }
    setResetState('sending');
    await requestPasswordReset(email.trim());
    // Deliberately show the same confirmation whether or not the email is
    // registered (account-enumeration guard, same rule as the wrong-password
    // banner below never revealing which field was wrong).
    setResetState('sent');
  };

  return (
    <Screen>
      <View style={styles.header}>
        <MeridianMark variant="lockup" size={40} />
      </View>

      <Text style={[theme.type.title, { color: theme.color.text.primary }]}>Welcome back.</Text>

      {!isOnline && (
        <InlineBanner
          tone="warning"
          message="You're offline. We'll log you in as soon as you're connected. If you're already signed in on this device, you can keep using your saved data."
        />
      )}

      {error?.kind === 'invalid_credentials' && (
        <InlineBanner tone="danger" message="Email or password doesn't match. Try again or reset your password." />
      )}
      {error?.kind === 'unverified_email' && (
        <InlineBanner
          tone="warning"
          message={
            resendSent
              ? `Confirmation link resent to ${email.trim()}.`
              : resending
                ? 'Sending...'
                : `Confirm your email to finish signing in. We sent a link to ${email.trim()}.`
          }
          actionLabel={resendSent || resending ? undefined : 'Resend'}
          onAction={resendSent || resending ? undefined : handleResend}
        />
      )}
      {error?.kind === 'network_offline' && (
        <InlineBanner tone="warning" message="You're offline. Check your connection and try again." />
      )}
      {error?.kind === 'rate_limited' && (
        <InlineBanner tone="danger" message="Too many attempts. Wait a moment and try again." />
      )}
      {error?.kind === 'unknown' && (
        <InlineBanner tone="danger" message="Something went wrong on our end. Try again in a moment." />
      )}

      <OAuthRow disabled={submitting} onError={setError} />
      <OrDivider />

      <View style={styles.form}>
        <Field
          label="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          textContentType="emailAddress"
          testID="login-email"
        />
        <Field
          label="Password"
          value={password}
          onChangeText={setPassword}
          isPassword
          autoCapitalize="none"
          autoComplete="password"
          textContentType="password"
          testID="login-password"
        />
      </View>

      <PrimaryButton label="Log in" onPress={handleSubmit} loading={submitting} disabled={!canSubmit} testID="login-submit" />

      {resetState === 'needs-email' && (
        <InlineBanner tone="info" message="Enter your email above first, then tap Forgot password? again." />
      )}
      {resetState === 'sent' && (
        <InlineBanner tone="success" message={`If an account exists for ${email.trim()}, we've sent a password reset link.`} />
      )}
      <TextButton
        label="Forgot password?"
        onPress={handleForgotPassword}
        disabled={resetState === 'sending'}
      />

      <View style={styles.footer}>
        <Text style={[theme.type.body, { color: theme.color.text.secondary }]}>New here? </Text>
        <Link href="/(auth)/sign-up" asChild>
          <TextButton label="Create account" onPress={() => {}} />
        </Link>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    alignItems: 'flex-start',
  },
  form: {
    gap: theme.space.md,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
