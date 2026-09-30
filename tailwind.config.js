/** @type {import('tailwindcss').Config} */
// Brand system mirrored from the SignBit platform: Bitcoin-orange accent, semantic
// surface/ink/line tokens, Epilogue + IBM Plex Mono, squared-off corners. Kept in
// sync with the platform's brand tokens so the companion signer reads as one product.
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      screens: {
        xs: '475px',
      },
      colors: {
        // Brand accent — Bitcoin orange family. Used sparingly for trust + emphasis.
        brand: {
          50: '#fff7ed',
          100: '#ffedd5',
          200: '#fed7aa',
          300: '#fdba74',
          400: '#fb923c',
          500: '#f7931a', // primary Bitcoin orange
          600: '#ea7c0c',
          700: '#c2620a',
          800: '#9a4f10',
          900: '#7c4211',
        },
        // Semantic tokens driven by CSS variables so light/dark share component classes.
        surface: 'rgb(var(--surface) / <alpha-value>)',
        'surface-2': 'rgb(var(--surface-2) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        'ink-muted': 'rgb(var(--ink-muted) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'fade-in-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'scale-in': {
          '0%': { opacity: '0', transform: 'scale(0.96)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        // Subtle horizontal shake for error feedback (e.g. passphrases don't match).
        shake: {
          '0%, 100%': { transform: 'translateX(0)' },
          '20%, 60%': { transform: 'translateX(-4px)' },
          '40%, 80%': { transform: 'translateX(4px)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.5s ease-out both',
        'fade-in-up': 'fade-in-up 0.6s cubic-bezier(0.22, 1, 0.36, 1) both',
        'scale-in': 'scale-in 0.45s cubic-bezier(0.22, 1, 0.36, 1) both',
        shake: 'shake 0.4s cubic-bezier(0.36, 0.07, 0.19, 0.97) both',
      },
      transitionTimingFunction: {
        smooth: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
      boxShadow: {
        soft: '0 1px 2px rgb(0 0 0 / 0.04), 0 4px 16px -4px rgb(0 0 0 / 0.08)',
        lift: '0 2px 4px rgb(0 0 0 / 0.06), 0 12px 28px -6px rgb(0 0 0 / 0.16)',
      },
      fontFamily: {
        sans: ['"Epilogue Variable"', 'Epilogue', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
        wordmark: ['"Sabre Shark"', '"Epilogue Variable"', 'Epilogue', 'sans-serif'],
      },
      // Squared-off corners (matches the platform): rectangular radii collapse to 0;
      // `full` stays for circular elements (dots, pills).
      borderRadius: {
        none: '0',
        sm: '0',
        DEFAULT: '0',
        md: '0',
        lg: '0',
        xl: '0',
        '2xl': '0',
        '3xl': '0',
        full: '9999px',
      },
    },
  },
  plugins: [],
}
