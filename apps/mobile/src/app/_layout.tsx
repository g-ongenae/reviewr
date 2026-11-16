import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { ServerStatus } from '@/components/ServerStatus';
import { draftsOf } from '@/lib/appDrafts';
import { createQueryClient } from '@/lib/queryClient';
import { useTheme } from '@/lib/theme';

export default function RootLayout() {
  const theme = useTheme();
  const [queryClient] = useState(createQueryClient);

  // Going to the background saves every open document at once: the system may stop the app there.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') draftsOf(queryClient).flushAll();
    });
    return () => subscription.remove();
  }, [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.background },
          headerTintColor: theme.accent,
          headerTitleStyle: { color: theme.text },
          contentStyle: { backgroundColor: theme.background },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Reviewr' }} />
        <Stack.Screen name="documents/[id]/index" options={{ title: '' }} />
        <Stack.Screen name="documents/[id]/history" options={{ title: 'History' }} />
      </Stack>
      <ServerStatus />
    </QueryClientProvider>
  );
}
