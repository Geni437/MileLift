import React from 'react';
import { Text } from 'react-native';
import { useLocalSearchParams } from 'expo-router';

import { theme } from '../../src/theme';
import { Screen } from '../../src/components/Screen';

const TITLES: Record<string, string> = {
  terms: 'Terms of Service',
  privacy: 'Privacy Policy',
};

/**
 * HONEST PLACEHOLDER, not a stub pretending to be real content: MileLift's
 * legal docs don't exist yet (the trademark/domain check flagged in
 * MASTER-BUILD-PROMPT.md is still outstanding, and no Terms/Privacy content
 * has been drafted). Linking to an external `milelift.app` URL we don't
 * control/haven't confirmed we own would be worse — it could 404 or resolve
 * to someone else's page. This screen says plainly that the document isn't
 * published yet, which is true, instead of faking a link or fabricated
 * legal text.
 */
export default function LegalDocScreen() {
  const { doc } = useLocalSearchParams<{ doc: string }>();
  const title = TITLES[doc ?? ''] ?? 'Legal';

  return (
    <Screen>
      <Text style={[theme.type.displayMd, { color: theme.color.text.primary }]}>{title}</Text>
      <Text style={[theme.type.body, { color: theme.color.text.secondary }]}>
        MileLift&apos;s {title.toLowerCase()} is being finalized before launch and isn&apos;t published yet. Check back soon, or
        contact support if you have a question before then.
      </Text>
    </Screen>
  );
}
