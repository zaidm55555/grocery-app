import { Platform } from '../services/storage';

// Exact token set ported from the Grocery Order Optimizer web app
// (src/App.css :root) so both products share one visual language.
export const colors = {
  bgDark: '#0b0f19',
  bgCard: 'rgba(18, 26, 44, 0.7)',
  bgCardSolid: '#121a2c',
  bgCardHover: 'rgba(26, 37, 62, 0.85)',
  bgTile: 'rgba(11, 15, 25, 0.55)',
  border: 'rgba(255, 255, 255, 0.08)',
  borderGlow: 'rgba(99, 102, 241, 0.4)',

  textPrimary: '#f8fafc',
  textSecondary: '#94a3b8',
  textMuted: '#64748b',

  accentPrimary: '#6366f1',
  accentSecondary: '#8b5cf6',
  emerald: '#10b981',
  emeraldDark: '#059669',
  emeraldStepper: '#0e9f6e',
  rose: '#f43f5e',
  discountRed: '#d92d20',
  amber: '#f59e0b',

  imageBg: '#f8fafc',

  glassBg: 'rgba(15, 23, 42, 0.75)',
  glassBorder: 'rgba(255, 255, 255, 0.1)',

  // Ambient radial-gradient corner washes from the reference body background
  ambientPurple: 'rgba(139, 61, 255, 0.12)',
  ambientOrange: 'rgba(252, 128, 25, 0.12)',
  ambientBlue: 'rgba(40, 116, 240, 0.10)',
};

interface PlatformTheme {
  name: string;
  tagline: string;
  etaBadge: string;
  color: string;
  textColor: string;
  gradient: [string, string];
  bgLight: string;
  borderColor: string;
}

export const platformThemes: Record<Platform, PlatformTheme> = {
  swiggy: {
    name: 'Instamart',
    tagline: 'Swiggy Instamart',
    etaBadge: '15 MINS',
    color: '#FC8019',
    textColor: '#FFFFFF',
    gradient: ['#FC8019', '#E26302'],
    bgLight: 'rgba(252, 128, 25, 0.1)',
    borderColor: 'rgba(252, 128, 25, 0.4)',
  },
  blinkit: {
    name: 'Blinkit',
    tagline: 'Blinkit · delivered in 10 mins',
    etaBadge: '10 MINS',
    color: '#F8CB46',
    textColor: '#000000',
    gradient: ['#F8CB46', '#E0B424'],
    bgLight: 'rgba(248, 203, 70, 0.1)',
    borderColor: 'rgba(248, 203, 70, 0.4)',
  },
};

export const PLATFORM_ORDER: Platform[] = ['blinkit', 'swiggy'];

export const fonts = {
  heading: 'Outfit_600SemiBold',
  headingBold: 'Outfit_700Bold',
  body: 'Inter_400Regular',
  bodyMedium: 'Inter_500Medium',
  bodySemiBold: 'Inter_600SemiBold',
  bodyBold: 'Inter_700Bold',
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 999,
};

export const theme = { colors, platformThemes, fonts, radius, PLATFORM_ORDER };
