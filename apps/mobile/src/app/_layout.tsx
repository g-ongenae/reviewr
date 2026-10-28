import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { useTheme } from '@/lib/theme';

export default function RootLayout() {
  const theme = useTheme();
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1 } } }));

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
    </QueryClientProvider>
  );
}
