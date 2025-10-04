/** @type {import('tailwindcss').Config} */
export default {
  // CRITICAL: Tells Tailwind which files to scan for utility classes.
  content: [
    "./index.html",
    // Scans all JavaScript/JSX files inside the src directory
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      // Custom fonts or themes can go here
      fontFamily: {
        // Ensures 'Inter' is the default if loaded via index.html
        sans: ['Inter', 'Arial', 'Helvetica', 'sans-serif'], 
      },
    },
  },
  plugins: [],
}
