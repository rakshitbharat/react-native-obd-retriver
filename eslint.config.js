// eslint.config.js
// @ts-check  (Add this comment for better editor type checking of this config file)

const eslint = require('@eslint/js');
const tseslint = require('typescript-eslint');
const importPlugin = require('eslint-plugin-import');

const projectRoot = __dirname;

/** @type {import('eslint').Linter.FlatConfig[]} */
module.exports = tseslint.config(
  // Global ignores
  {
    ignores: [
      'node_modules/**',
      'lib/**',
      'dist/**',
      'coverage/**',
      'build/**',
      '**/*.config.js', // Ignore config files by default unless explicitly included
      '**/*.config.mjs',
      '**/*.config.cjs',
    ],
  },

  // Base recommended rules
  eslint.configs.recommended,

  // TypeScript specific configurations
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    // Apply TypeScript parser and plugins ONLY to TS/TSX files
    languageOptions: {
      parser: tseslint.parser,
      globals: {
        console: 'readonly',
        setTimeout: 'readonly',
        Buffer: 'readonly',
      },
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: projectRoot,
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      import: importPlugin,
    },
    // Settings for eslint-plugin-import
    settings: {
      'import/parsers': {
        '@typescript-eslint/parser': ['.ts', '.tsx'],
      },
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true, // always try to resolve types under `<root>@types` directory even it doesn't contain any source code, like `@types/unist`
          project: './tsconfig.json',
        },
        node: true,
      },
    },
    rules: {
      // ----- Start with Strong TypeScript Presets -----
      // Apply strict rules that require type information
      ...tseslint.configs.strictTypeChecked.rules,
      // Apply stylistic rules that require type information
      ...tseslint.configs.stylisticTypeChecked.rules,

      // ----- Apply Import Plugin Rules -----
      ...importPlugin.configs.recommended.rules,
      ...importPlugin.configs.typescript.rules, // Adjusts recommended rules for TS

      // ----- Customize/Override Rules for Maximum Robustness -----

      // ** Essential Core ESLint Rules (Error Severity) **
      'no-console': ['error', { allow: ['warn', 'error', 'info', 'debug'] }], // Allow informative console levels, forbid console.log
      'no-unused-expressions': 'error',
      'no-undef': 'error', // Redundant with TS checker, but good fallback
      'no-throw-literal': 'error', // Only throw Error objects
      'no-unused-labels': 'error',
      'no-useless-return': 'error',
      'no-var': 'error', // Use let/const
      'prefer-const': 'error', // Enforce const where possible
      'no-extra-bind': 'error',
      'no-template-curly-in-string': 'error', // Catch potential template literal bugs
      'no-caller': 'error',
      'no-eval': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }], // Enforce ===, allow == null check
      'no-promise-executor-return': 'error', // Avoid returning values from Promise executors
      'no-unreachable-loop': 'error',
      'no-unsafe-optional-chaining': 'error', // Prevent unsafe optional chaining on non-nullish values
      'require-atomic-updates': 'error', // Prevent race conditions due to await/yield
      'no-loss-of-precision': 'error',
      'prefer-object-spread': 'error', // Use {...} instead of Object.assign

      // ** Essential TypeScript Rules (Error Severity) **
      '@typescript-eslint/no-explicit-any': 'error', // Critical: Avoid 'any'
      '@typescript-eslint/no-unused-vars': [
        'error', // Critical: Clean up unused variables
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }, // Allow underscore prefix for unused args/vars
      ],
      '@typescript-eslint/no-shadow': 'error', // Prevents shadowing, important for clarity
      // Rules enabled by strict-type-checked (keeping for emphasis, ensure they are 'error')
      '@typescript-eslint/no-floating-promises': [
        'error',
        { ignoreVoid: true, ignoreIIFE: true }, // Require handling of Promises, allow `void promise()` and IIFEs
      ],
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: false }, // Check for promises in places not expecting them (e.g., if conditions), allow functions returning void promises in callbacks
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'error', // Require explicit types for exported functions/methods
      '@typescript-eslint/explicit-function-return-type': 'off', // Can be noisy; module boundaries are often sufficient. Enable if desired.
      '@typescript-eslint/no-unsafe-assignment': 'error', // Prevent assigning 'any' to typed variables
      '@typescript-eslint/no-unsafe-call': 'error', // Prevent calling 'any' typed values
      '@typescript-eslint/no-unsafe-member-access': 'error', // Prevent accessing members on 'any' typed values
      '@typescript-eslint/no-unsafe-return': 'error', // Prevent returning 'any' from typed functions
      '@typescript-eslint/no-non-null-assertion': 'error', // Forbid `!` non-null assertions (use type guards or checks)
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ], // Enforce `import type`
      '@typescript-eslint/no-import-type-side-effects': 'error', // Enforce `import type` for type-only imports (via consistent-type-imports)
      '@typescript-eslint/prefer-readonly': 'error', // Encourage immutable types where applicable
      '@typescript-eslint/switch-exhaustiveness-check': 'error', // Ensure switch statements on unions are exhaustive

      // ** Import Plugin Rules (Customization) **
      'import/order': [
        // Enforce a consistent import order
        'error',
        {
          groups: [
            'builtin', // Node.js built-in modules
            'external', // npm dependencies
            'internal', // Aliased internal modules (if you use paths/aliases)
            'parent', // Relative parent imports
            'sibling', // Relative sibling imports
            'index', // Relative index imports
            'object', // Object imports (e.g., `import { foo } from './bar'`) - stylistic
            'type', // Type imports (`import type ...`)
          ],
          'newlines-between': 'always', // Add newlines between import groups
          alphabetize: {
            order: 'asc', // Sort imports alphabetically within groups
            caseInsensitive: true,
          },
        },
      ],
      'import/no-cycle': 'error', // Prevent import cycles
      'import/no-default-export': 'warn', // Encourage named exports for better tree-shaking and clarity (set to 'error' for super strictness)
      'import/no-useless-path-segments': ['error', { noUselessIndex: true }], // Clean up ../../ paths
      'import/newline-after-import': 'error', // Enforce newline after imports
      'import/no-duplicates': 'error', // Prevent duplicate imports
    },
  },
);
