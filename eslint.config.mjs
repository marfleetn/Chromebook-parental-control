// ESLint flat config. Catches real mistakes (undefined names, unused vars,
// unreachable code) across the server, core, console and extension without
// imposing a style guide. Run: npm run lint
import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';

const common = {
  ...js.configs.recommended.rules,
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
  'no-console': 'off',
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-control-regex': 'off',
};

export default [
  { ignores: ['node_modules/**', 'web/dist/**', 'extension/vendor/**', 'e2e-artifacts/**', 'badges/**'] },

  // Node: core, server, scripts
  {
    files: ['core/**/*.{js,mjs}', 'server/**/*.{js,mjs}', 'scripts/**/*.{js,mjs}', 'eslint.config.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
    rules: common,
  },
  // The e2e scripts run code inside the browser / extension via page.evaluate().
  {
    files: ['scripts/e2e-*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser, chrome: 'readonly' } },
  },

  // Chrome extension (service worker + pages)
  {
    files: ['extension/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.browser, ...globals.serviceworker, chrome: 'readonly' } },
    rules: common,
  },

  // React console (JSX; the react plugin marks JSX-referenced identifiers as used)
  {
    files: ['web/src/**/*.{js,jsx}', 'web/vite.config.js'],
    plugins: { react },
    languageOptions: {
      ecmaVersion: 2024, sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...common,
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error',
      'react/jsx-key': 'error',
      'react/no-danger': 'error',
    },
  },
];
