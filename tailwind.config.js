/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,jsx,ts,tsx}",
    "./components/**/*.{js,jsx,ts,tsx}",
    "./pages/**/*.{js,jsx,ts,tsx}",
  ],
  darkMode: ['class'],
  theme: {
    extend: {
      colors: {
        // Doncaster/Mighty Knights inspired
        'dk-navy':   '#0A1A2F',
        'mk-red':    '#B10F2E',
        'mk-crimson':'#8F0D25',
        'mk-gold':   '#E8C170',
        'pitch-green':'#F4F8F5',
      },
      boxShadow: {
        soft: '0 1px 2px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.06)',
        card: '0 10px 30px rgba(10,26,47,0.07)',
      },
      borderRadius: {
        '2xl': '1.25rem',
        '3xl': '1.75rem',
      },
      fontFamily: {
        ui: ['Inter', 'system-ui', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
        mono: ['ui-monospace','SFMono-Regular','Menlo','Monaco','Consolas','monospace']
      },
    },
  },
  plugins: [],
}
