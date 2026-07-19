import { Stack } from 'expo-router';

export default function OnboardingLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, gestureEnabled: true }}>
      <Stack.Screen name="welcome" />
      <Stack.Screen name="balance" />
      <Stack.Screen name="profile-setup" />
    </Stack>
  );
}
