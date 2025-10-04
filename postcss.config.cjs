module.exports = {
  plugins: {
    // 1. Tailwind CSS plugin: Reads the Tailwind directives from src/index.css 
    //    and replaces them with the massive CSS utility library.
    tailwindcss: {},
    
    // 2. Autoprefixer plugin: Automatically adds vendor prefixes (-webkit-, -moz-, etc.) 
    //    to ensure cross-browser compatibility.
    autoprefixer: {},
  },
};
