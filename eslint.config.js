/**
 * ESLint flat configuration (ESLint v9+).
 *
 * This replaces the legacy `.eslintrc.cjs`, which ESLint v9 no longer reads.
 * It mirrors the previous setup — `eslint:recommended` plus
 * `@typescript-eslint/recommended` — applied to all TypeScript sources.
 *
 * Linting is intentionally *non-type-aware* (no `parserOptions.project`) so
 * that the check is fast and does not depend on the whole program typechecking
 * cleanly; type safety is enforced separately by `tsc`.
 */
const js = require('@eslint/js');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');

module.exports = [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.js', '*.cjs'],
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'commonjs',
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      // TypeScript already enforces undefined/redeclared identifiers at compile
      // time; disabling these avoids false positives against express+node globals
      // and keeps ESLint responsible for stylistic/type-annotation hygiene only.
      'no-undef': 'off',
      'no-redeclare': 'off',
    },
  },
  // Jest globals for test files.
  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**/*.ts', '**/*.pact.test.ts'],
    languageOptions: {
      globals: {
        ...require('globals').jest,
      },
    },
  },
];