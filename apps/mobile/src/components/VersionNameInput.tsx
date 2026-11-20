import { revisionNameMaxLength } from '@reviewr/shared';
import { StyleSheet, TextInput, type TextInputProps } from 'react-native';
import { useTheme } from '@/lib/theme';

export const VersionNameInput = (
  props: Pick<TextInputProps, 'value' | 'onChangeText' | 'placeholder' | 'editable' | 'onSubmitEditing'>,
) => {
  const theme = useTheme();
  return (
    <TextInput
      {...props}
      accessibilityLabel="Version name"
      autoFocus
      maxLength={revisionNameMaxLength}
      placeholderTextColor={theme.muted}
      returnKeyType="done"
      style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.background }]}
    />
  );
};

const styles = StyleSheet.create({
  input: { minHeight: 44, borderWidth: 1, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 8, fontSize: 16 },
});
