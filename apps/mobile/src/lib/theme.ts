import { useColorScheme } from 'react-native';

const light = {
  accent: '#db2777',
  /** The accent of a pressed primary button, as the web's hover. */
  accentDark: '#be185d',
  background: '#ffffff',
  surface: '#f4f4f5',
  /** A card over the background, as the web's writing stats panel. */
  card: '#ffffff',
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
  card: '#202024',
  border: '#3f3f46',
  text: '#f4f4f5',
  muted: '#a1a1aa',
  warning: '#422006',
};

export const useTheme = (): Theme => (useColorScheme() === 'dark' ? dark : light);
