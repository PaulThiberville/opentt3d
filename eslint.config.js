import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'release/**',
      'node_modules/**',
      'coverage/**',
      'engine/upstream/**',
      'engine/build/**',
      'engine/build-host/**',
      'engine/.cache/**',
      'public/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off',
    },
  },
  {
    files: ['engine/scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        URL: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
  {
    files: ['electron/**/*.cjs', 'build/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        Buffer: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
        __dirname: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        module: 'writable',
        process: 'readonly',
        require: 'readonly',
        setTimeout: 'readonly',
      },
    },
    rules: {
      // CommonJS est imposé par Electron pour le processus principal et le preload sandboxé.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  prettier,
);
