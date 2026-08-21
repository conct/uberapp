import { useColorScheme } from 'react-native';

export interface Theme {
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  textMuted: string;
  textFaint: string;
  accent: string;
  accentText: string;
  success: string;
  warning: string;
  danger: string;
  mono: string;
}

const light: Theme = {
  bg: '#f6f7f9',
  surface: '#ffffff',
  surfaceAlt: '#eef0f4',
  border: '#dfe3ea',
  text: '#12151a',
  textMuted: '#5b6472',
  textFaint: '#8b95a5',
  accent: '#1f6feb',
  accentText: '#ffffff',
  success: '#1a7f37',
  warning: '#9a6700',
  danger: '#cf222e',
  mono: '#0b1020',
};

const dark: Theme = {
  bg: '#0d1117',
  surface: '#161b22',
  surfaceAlt: '#1f252d',
  border: '#2a313c',
  text: '#e6edf3',
  textMuted: '#9aa4b2',
  textFaint: '#6e7781',
  accent: '#4493f8',
  accentText: '#04101f',
  success: '#3fb950',
  warning: '#d29922',
  danger: '#f85149',
  mono: '#010409',
};

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}

/** Status colours for supervisord states. */
export function serviceStateColor(state: string, theme: Theme): string {
  switch (state) {
    case 'RUNNING':
      return theme.success;
    case 'STARTING':
    case 'STOPPING':
    case 'BACKOFF':
      return theme.warning;
    case 'FATAL':
      return theme.danger;
    default:
      return theme.textFaint;
  }
}

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
} as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
