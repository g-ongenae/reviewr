import type { ComponentType, ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { IconProps } from '@/components/ToolbarIcons';
import { type Theme, useTheme } from '@/lib/theme';

/** As on the web: a bordered button, its icon in the text colour or in red, or filled with the accent colour. */
export type ToolbarButtonKind = 'neutral' | 'danger' | 'primary';

type Props = {
  /** What screen readers say; also the action's name when the button shows only its icon. */
  label: string;
  onPress: () => void;
  icon?: ComponentType<IconProps>;
  /** Shown beside the icon, where an icon alone would not say what the button does. */
  text?: string;
  kind?: ToolbarButtonKind;
  disabled?: boolean;
};

const colors = (theme: Theme, kind: ToolbarButtonKind, pressed: boolean) => {
  if (kind === 'primary') {
    const fill = pressed ? theme.accentDark : theme.accent;
    return { background: fill, border: fill, content: '#fff' };
  }
  return {
    background: pressed ? theme.surface : theme.background,
    border: theme.border,
    content: kind === 'danger' ? theme.danger : theme.text,
  };
};

/** A toolbar action: at least 44×44 pt to touch, drawn as the web's smaller button inside it. */
export const ToolbarButton = ({ label, onPress, icon: IconOf, text, kind = 'neutral', disabled = false }: Props) => {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={styles.target}
    >
      {({ pressed }) => {
        const { background, border, content } = colors(theme, kind, pressed && !disabled);
        return (
          <View
            style={[
              styles.box,
              text !== undefined && styles.withText,
              { backgroundColor: background, borderColor: border },
              disabled && styles.disabled,
            ]}
          >
            {IconOf !== undefined && <IconOf color={content} />}
            {text !== undefined && <Text style={[styles.text, { color: content }]}>{text}</Text>}
          </View>
        );
      }}
    </Pressable>
  );
};

/** The actions at the right of a screen's header, in the web's order. */
export const ToolbarActions = ({ children }: { children: ReactNode }) => (
  <View style={styles.actions}>{children}</View>
);

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', alignItems: 'center' },
  target: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  box: {
    minWidth: 36,
    height: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 6,
  },
  withText: { paddingHorizontal: 12 },
  text: { fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.5 },
});
