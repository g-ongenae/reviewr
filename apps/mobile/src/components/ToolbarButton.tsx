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
  /**
   * Makes the button a toggle that shows or hides a part of the screen, drawn as the web's borderless icon button:
   * muted, in the accent colour while the part is shown. Screen readers hear whether it is expanded.
   */
  expanded?: boolean;
};

const colors = (theme: Theme, kind: ToolbarButtonKind, pressed: boolean, expanded: boolean | undefined) => {
  if (expanded !== undefined) {
    const background = pressed ? theme.border : 'transparent';
    return { background, border: background, content: expanded ? theme.accent : pressed ? theme.text : theme.muted };
  }
  if (kind === 'primary') {
    const fill = pressed ? theme.accentDark : theme.accent;
    return { background: fill, border: fill, content: '#fff' };
  }
  // Pressed as the web's hovered icon button: the border colour fills it and its outline darkens.
  return {
    background: pressed ? theme.border : theme.background,
    border: pressed ? theme.muted : theme.border,
    content: kind === 'danger' ? theme.danger : theme.text,
  };
};

/** A toolbar action: at least 44×44 pt to touch, drawn as the web's smaller button inside it. */
export const ToolbarButton = ({
  label,
  onPress,
  icon: IconOf,
  text,
  kind = 'neutral',
  disabled = false,
  expanded,
}: Props) => {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, expanded }}
      // The same state as an ARIA prop, which React Native Web also passes on.
      aria-expanded={expanded}
      // TalkBack offers "expand" or "collapse" on a button with an expanded state: either one toggles it.
      accessibilityActions={expanded === undefined ? undefined : [{ name: expanded ? 'collapse' : 'expand' }]}
      onAccessibilityAction={
        expanded === undefined
          ? undefined
          : ({ nativeEvent: { actionName } }) => {
              if ((actionName === 'expand' && !expanded) || (actionName === 'collapse' && expanded)) onPress();
            }
      }
      disabled={disabled}
      onPress={onPress}
      style={styles.target}
    >
      {({ pressed }) => {
        const { background, border, content } = colors(theme, kind, pressed && !disabled, expanded);
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

/**
 * The actions at the right of a screen's header, in the web's order. The gap keeps a tap that misses one button from
 * landing on its neighbour (Delete is next to Save version). Four buttons take 4 × 44 + 3 × 6 = 194 pt.
 */
export const ToolbarActions = ({ children }: { children: ReactNode }) => <View style={styles.actions}>{children}</View>;

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  target: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  box: {
    minWidth: 36,
    // A minimum, not a height: a label in a large system font makes the button taller instead of being clipped.
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 6,
  },
  withText: { paddingHorizontal: 12, paddingVertical: 6 },
  text: { fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.5 },
});
