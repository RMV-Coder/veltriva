// @ts-check
import { builtinModules } from 'node:module';

import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const SQLITE =
  'Only the data worker (src/data) may use SQLite: a statement blocks the thread that runs it ' +
  '(ADR-0004, spike S5). Main talks to it through src/main/persistence.';
/** Part of every area's ban below: flat config replaces a rule's options, it doesn't merge them. */
const SQLITE_PATHS = [
  { name: 'better-sqlite3', message: SQLITE },
  { name: 'node:sqlite', message: SQLITE },
];
const SQLITE_PATTERNS = [{ group: ['better-sqlite3/*'], message: SQLITE }];

/**
 * `no-restricted-imports` options that ban Node built-ins (`fs`, `node:fs`, ...), SQLite and,
 * optionally, `electron`.
 *
 * @param {string} message
 * @param {{ electron?: boolean }} [options]
 */
function bannedImports(message, { electron = false } = {}) {
  const builtins = builtinModules.filter((name) => !name.startsWith('node:'));
  return {
    paths: [
      ...SQLITE_PATHS,
      ...builtins.map((name) => ({ name, message })),
      ...(electron ? [{ name: 'electron', message }] : []),
    ],
    patterns: [
      ...SQLITE_PATTERNS,
      { group: ['node:*'], message },
      ...(electron ? [{ group: ['electron/*'], message }] : []),
    ],
  };
}

const RAW_HTML = 'Never render raw HTML: the shell displays untrusted titles and URLs (ADR-0002).';

export default defineConfig(
  globalIgnores([
    'out/',
    'release/',
    'dist/',
    'coverage/',
    'playwright-report/',
    'test-results/',
    'spikes/',
  ]),

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Async lifecycle code must never drop a promise or hand one to a void callback.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },

  // Plain JavaScript (this file, scripts/) is outside every tsconfig.
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  // Test-only preloads are plain CommonJS: a sandboxed preload can only `require('electron')`.
  {
    files: ['tests/**/*.cjs'],
    languageOptions: { globals: { require: 'readonly' } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },

  // No raw-HTML sinks anywhere.
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: RAW_HTML },
        { selector: "Property[key.name='dangerouslySetInnerHTML']", message: RAW_HTML },
        {
          selector:
            'AssignmentExpression > MemberExpression.left[property.name=/^(innerHTML|outerHTML)$/]',
          message: RAW_HTML,
        },
        {
          selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
          message: RAW_HTML,
        },
        {
          selector:
            "CallExpression[callee.object.name='document'][callee.property.name=/^writeln?$/]",
          message: RAW_HTML,
        },
      ],
    },
  },

  // src/core and src/shared are pure: no Electron and no Node, so they run in any process.
  {
    files: ['src/core/**/*.ts', 'src/shared/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        bannedImports('src/core and src/shared must stay pure: no Electron or Node imports.', {
          electron: true,
        }),
      ],
    },
  },

  // Main (and its tests, and the E2E specs) never touch SQLite. Main starts the data worker by file
  // name and imports nothing from src/data, so the worker's code can't end up on main's thread.
  {
    files: ['src/main/**/*.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: SQLITE_PATHS,
          patterns: [
            ...SQLITE_PATTERNS,
            {
              regex: '^(\\.\\./)+data(/|$)',
              message: 'Main starts the data worker by file; it never imports src/data (ADR-0004).',
            },
          ],
        },
      ],
    },
  },

  // The sandboxed preload can't load Node built-ins at runtime.
  {
    files: ['src/preload/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        bannedImports('The shell preload is sandboxed: only `electron` is available.'),
      ],
    },
  },

  // The shell renderer has no Node and no Electron; it reaches main only through window.veltriva.
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        bannedImports('The shell renderer has no Node or Electron; use window.veltriva.', {
          electron: true,
        }),
      ],
    },
  },
);
