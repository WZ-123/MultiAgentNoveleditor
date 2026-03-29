/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    "./node_modules/@heroui/theme/dist/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'vscode-bg': '#1e1e1e',
        'vscode-sidebar': '#252526',
        'vscode-activity-bar': '#333333',
        'vscode-status-bar': '#007acc',
        'vscode-editor-bg': '#1e1e1e',
        'vscode-panel-border': '#2b2b2b',
        'vscode-text': '#cccccc',
        'vscode-active-item': '#37373d'
      }
    },
  },
  plugins: [require("@heroui/theme").heroui()],
}
