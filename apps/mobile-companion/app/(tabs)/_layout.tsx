// Spec 011 parity (references 01/02/03): the bottom tab bar is GONE.
//
// One main screen — the list (`index`) — with the source switcher, the ⋯ menu and the floating
// composer doing the navigation the tabs used to do. Settings is pushed from the ⋯ menu, and the old
// `conversations` route redirects to the list so any stale push still resolves.

import { Stack } from 'expo-router';

import { useTheme } from '../../src/ui/theme';

export default function AppStackLayout() {
  const { colors } = useTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        // Themed chrome: no white flash between screens.
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="conversations" />
    </Stack>
  );
}
