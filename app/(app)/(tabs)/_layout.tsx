import { Tabs } from 'expo-router';
import { Text } from 'react-native';

import { theme } from '../../../src/theme';

/**
 * Tab bar. Phase 1 added Activity; Phase 2 adds Lift; Phase 3 adds Food
 * (screens-phase-3.md §B: "Tabs become: Home · Activity · Lift · Food ·
 * Profile — five text labels, no new icon set" — the discipline carries
 * forward again, chosen over a branded coinage like "Fuel" per that doc's
 * §Decisions D1). "Lift" is kept as the brand's own word rather than
 * renaming "Activity" for symmetry, per screens-phase-2.md §Decisions item 2.
 */
export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.color.accent.primary,
        tabBarInactiveTintColor: theme.color.text.tertiary,
        tabBarStyle: {
          backgroundColor: theme.color.bg.surface,
          borderTopColor: theme.color.border.subtle,
        },
        tabBarLabelStyle: { ...theme.type.label },
      }}
    >
      <Tabs.Screen
        name="home"
        options={{
          title: 'Home',
          tabBarLabel: ({ color }) => <Text style={{ color, ...theme.type.label }}>Home</Text>,
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          title: 'Activity',
          tabBarLabel: ({ color }) => <Text style={{ color, ...theme.type.label }}>Activity</Text>,
        }}
      />
      <Tabs.Screen
        name="lift"
        options={{
          title: 'Lift',
          tabBarLabel: ({ color }) => <Text style={{ color, ...theme.type.label }}>Lift</Text>,
        }}
      />
      <Tabs.Screen
        name="food"
        options={{
          title: 'Food',
          tabBarLabel: ({ color }) => <Text style={{ color, ...theme.type.label }}>Food</Text>,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarLabel: ({ color }) => <Text style={{ color, ...theme.type.label }}>Profile</Text>,
        }}
      />
    </Tabs>
  );
}
