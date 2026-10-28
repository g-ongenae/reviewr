import { useColorScheme } from 'react-native';

const light = {
  accent: '#db2777',
  background: '#ffffff',
  surface: '#f4f4f5',
  border: '#e4e4e7',
  text: '#18181b',
  muted: '#71717a',
  danger: '#dc2626',
  warning: '#fef3c7',
};

export type Theme = typeof light;

const dark: Theme = {
  ...light,
  background: '#18181b',
  surface: '#27272a',
  border: '#3f3f46',
  text: '#f4f4f5',
  muted: '#a1a1aa',
  warning: '#422006',
};

export const useTheme = (): Theme => (useColorScheme() === 'dark' ? dark : light);
