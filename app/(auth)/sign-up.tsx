import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Link, router } from 'expo-router';

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

const MIN_PASSWORD_LENGTH = 12;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type ScreenState =
  | { kind: 'form' }
  | { kind: 'confirm-email'; email: string };

export default function SignUpScreen() {
  const { signUp } = useAuth();
  const { isOnline } = useNetworkStatus();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<AuthErrorResult | null>(null);
  const [screenState, setScreenState] = useState<ScreenState>({ kind: 'form' });

  const emailValid = EMAIL_PATTERN.test(email.trim());
  const passwordValid = password.length >= MIN_PASSWORD_LENGTH;
  const canSubmit = emailValid && passwordValid && !submitting;

  const emailFieldError = emailTouched && !emailValid ? 'Enter a valid email address.' : null;
  const passwordFieldError = passwordTouched && !passwordValid ? `At least ${MIN_PASSWORD_LENGTH} characters.` : null;

  const handleOAuthError = (error: AuthErrorResult) => {
    setServerError(error);
  };

  const handleSubmit = async () => {
    setEmailTouched(true);
    setPasswordTouched(true);
    if (!emailValid || !passwordValid) return;

    setSubmitting(true);
    setServerError(null);
    const result = await signUp(email.trim(), password);
    setSubmitting(false);

    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    if (result.requiresEmailConfirmation) {
      setScreenState({ kind: 'confirm-email', email: email.trim() });
    }
    // Otherwise: AuthContext's session state flips, and the root layout's
    // Stack.Protected guards route to onboarding automatically.
  };

  if (screenState.kind === 'confirm-email') {
    return <ConfirmEmailNotice email={screenState.email} />;
  }

  return (
    <Screen>
      <View style={styles.header}>
        <MeridianMark variant="lockup" size={40} />
      </View>

      <View style={styles.hero}>
        <Text style={[theme.type.displayMd, styles.headline, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
          One log. The miles and the lifts.
        </Text>
        <Text style={[theme.type.body, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
          Everything you track, in one history — not five apps that never talk.
        </Text>
      </View>

      {!isOnline && (
        <InlineBanner
          tone="warning"
          message="You're offline. Creating an account needs a connection — your login will work offline once you're set up."
        />
      )}

      {serverError && <ServerErrorBanner error={serverError} />}

      <OAuthRow disabled={submitting} onError={handleOAuthError} />
      <OrDivider />

      <View style={styles.form}>
        <Field
          label="Email"
          value={email}
          onChangeText={setEmail}
          onBlur={() => setEmailTouched(true)}
          errorText={
            emailFieldError ??
            (serverError?.kind === 'email_in_use'
              ? 'An account already uses this email.'
              : null)
          }
          helperText={undefined}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          textContentType="emailAddress"
          testID="signup-email"
        />
        {serverError?.kind === 'email_in_use' && (
          <View style={styles.inlineRecovery}>
            <Link href="/(auth)/log-in" asChild>
              <TextButton label="Log in instead" onPress={() => {}} />
            </Link>
          </View>
        )}

        <Field
          label="Password"
          value={password}
          onChangeText={setPassword}
          onBlur={() => setPasswordTouched(true)}
          isPassword
          errorText={passwordFieldError}
          helperText={!passwordFieldError ? `At least ${MIN_PASSWORD_LENGTH} characters` : undefined}
          autoCapitalize="none"
          autoComplete="new-password"
          textContentType="newPassword"
          testID="signup-password"
        />
      </View>

      <PrimaryButton label="Create account" onPress={handleSubmit} loading={submitting} disabled={!canSubmit} testID="signup-submit" />

      <LegalLine />

      <View style={styles.footer}>
        <Text style={[theme.type.body, { color: theme.color.text.secondary }]}>Already have an account? </Text>
        <Link href="/(auth)/log-in" asChild>
          <TextButton label="Log in" onPress={() => {}} />
        </Link>
      </View>
    </Screen>
  );
}

function ServerErrorBanner({ error }: { error: AuthErrorResult }) {
  if (error.kind === 'email_in_use') return null; // shown as a field error instead
  if (error.kind === 'network_offline') {
    return <InlineBanner tone="warning" message="You're offline. Check your connection and try again." />;
  }
  if (error.kind === 'weak_password') {
    return <InlineBanner tone="danger" message={`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`} />;
  }
  if (error.kind === 'rate_limited') {
    return <InlineBanner tone="danger" message="Too many attempts. Wait a moment and try again." />;
  }
  return <InlineBanner tone="danger" message="Something went wrong on our end. Try again in a moment." />;
}

function ConfirmEmailNotice({ email }: { email: string }) {
  return (
    <Screen>
      <View style={styles.header}>
        <MeridianMark variant="glyph" size={40} />
      </View>
      <View style={styles.hero}>
        <Text style={[theme.type.displayMd, { color: theme.color.text.primary }]}>Check your inbox</Text>
        <Text style={[theme.type.body, { color: theme.color.text.secondary }]}>
          We sent a confirmation link to {email}. Confirm your email to finish creating your account.
        </Text>
      </View>
      <Link href="/(auth)/log-in" asChild>
        <PrimaryButton label="Go to log in" onPress={() => {}} />
      </Link>
    </Screen>
  );
}

function LegalLine() {
  return (
    <Text style={[theme.type.caption, styles.legal, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
      By creating an account you agree to our{' '}
      <Text style={styles.legalLink} accessibilityRole="link" onPress={() => router.push('/legal/terms')}>
        Terms
      </Text>{' '}
      and{' '}
      <Text style={styles.legalLink} accessibilityRole="link" onPress={() => router.push('/legal/privacy')}>
        Privacy Policy
      </Text>
      . This doesn&apos;t cover health, location, or camera access — those are separate, specific choices you make when you use them.
    </Text>
  );
}

const styles = StyleSheet.create({
  header: {
    alignItems: 'flex-start',
  },
  hero: {
    gap: theme.space.xs,
  },
  headline: {},
  form: {
    gap: theme.space.md,
  },
  inlineRecovery: {
    alignItems: 'flex-start',
    marginTop: -theme.space.xs,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  legal: {
    textAlign: 'left',
  },
  legalLink: {
    textDecorationLine: 'underline',
  },
});
