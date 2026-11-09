import { isServerUnreachable } from '@reviewr/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, queryKeys, reachability } from '@/lib/api';
import { useTheme } from '@/lib/theme';

/**
 * Shows a single "Server unreachable" notification while the API can't be reached, checks in the background whether
 * it is back, then reloads whatever failed in the meantime.
 */
export const ServerStatus = () => {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const unreachable = useSyncExternalStore(reachability.subscribe, reachability.isUnreachable);

  useQuery({
    queryKey: queryKeys.health,
    queryFn: () => api.health(),
    enabled: unreachable,
    refetchInterval: 5000,
    retry: false,
  });

  useEffect(() => {
    if (!unreachable) {
      void queryClient.invalidateQueries({ predicate: (query) => isServerUnreachable(query.state.error) });
    }
  }, [unreachable, queryClient]);

  if (!unreachable) {
    return null;
  }

  return (
    <View style={[styles.region, { bottom: insets.bottom + 16 }]} accessibilityLiveRegion="polite">
      <View
        accessibilityRole="alert"
        style={[
          styles.toast,
          { backgroundColor: theme.background, borderColor: theme.border, borderLeftColor: theme.accent },
        ]}
      >
        <Text style={[styles.title, { color: theme.text }]}>Server unreachable</Text>
        <Text style={{ color: theme.muted }}>Keep writing, we’ll reconnect on our own.</Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  region: { position: 'absolute', left: 16, right: 16, pointerEvents: 'none' },
  toast: {
    gap: 2,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: 3,
    borderRadius: 10,
    boxShadow: '0 10px 30px -12px rgba(0, 0, 0, 0.25)',
  },
  title: { fontSize: 16, fontWeight: '600' },
});
