/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './index.html',
    './index.tsx',
    './App.tsx',
    './components/**/*.{ts,tsx}',
    './hooks/**/*.{ts,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        app:            'var(--bg-app)',
        panel:          'var(--bg-panel)',
        'panel-head':   'var(--bg-panel-head)',
        subtle:         'var(--border-subtle)',
        primary:        'var(--text-primary)',
        secondary:      'var(--text-secondary)',
        accent:         'var(--accent)',
        'accent-contrast': 'var(--accent-contrast)',
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};
