import { createTheme, type MantineColorsTuple } from '@mantine/core';

/** Identité PAGINITY : bleu nuit, or, argent. */
const or: MantineColorsTuple = ['#fff8e6', '#fdedc9', '#f9d991', '#f5c355', '#f1b12a', '#e8a93a', '#c98a1c', '#a06d12', '#7a530d', '#553907'];
const nuit: MantineColorsTuple = ['#e8edf5', '#c9d3e3', '#a3b3cc', '#7c92b4', '#5a759d', '#3f5a82', '#2c4466', '#1d3049', '#13213a', '#0b1626'];

export const theme = createTheme({
  primaryColor: 'or',
  primaryShade: { light: 7, dark: 5 },
  colors: { or, nuit, dark: ['#e6eaf0', '#c1c8d4', '#94a0b4', '#6b7891', '#3b4a63', '#26354d', '#1a2740', '#121e33', '#0e1829', '#0b1626'] },
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  headings: { fontWeight: '700' },
  defaultRadius: 'md',
  cursorType: 'pointer',
  components: {
    Button: { defaultProps: { radius: 'xl' } },
  },
});
