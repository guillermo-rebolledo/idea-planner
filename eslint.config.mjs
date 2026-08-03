// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import eslintReact from '@eslint-react/eslint-plugin'
import reactHooks from 'eslint-plugin-react-hooks'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import effect from '@effect/eslint-plugin'
import vitest from '@vitest/eslint-plugin'
import playwright from 'eslint-plugin-playwright'
import prettier from 'eslint-config-prettier/flat'
import globals from 'globals'

/**
 * One flat config for the whole repo.
 *
 * `app/` is the real product and gets type-aware strict linting plus the
 * process-boundary rules that keep the Electron architecture and ADR 0001
 * honest. `prototypes/` is throwaway design evidence and is linted without
 * type-aware rules.
 *
 * Formatting is Prettier's job alone: `eslint-config-prettier` is applied last
 * so no lint rule ever fights the formatter.
 */

/** Effect is confined to the Core process — see docs/adr/0001-adopt-effect-in-core.md. */
const noEffectOutsideCore = {
  name: 'effect',
  message:
    'Effect is confined to the Core process (docs/adr/0001-adopt-effect-in-core.md). Keep this module promise-based, or amend the ADR first.'
}

const noNodeInSandbox = {
  group: ['node:*', 'electron'],
  message:
    'The sandboxed Renderer and the shared contract must not reach Node or Electron. Go through the Preload surface in @shared/contract.'
}

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/out/**',
      '**/dist/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '**/coverage/**',
      // Generated from the installed Codex binary; regenerated, never edited.
      'app/src/core/harness/codex-protocol/**',
      // Vendored from assistant-ui's shadcn registry, kept diffable (ticket 13).
      'app/src/renderer/src/components/ui/model-selector.tsx'
    ]
  },

  js.configs.recommended,

  // The product: type-aware, strict.
  {
    name: 'app/typescript',
    files: ['app/**/*.{ts,tsx,mts,cts}'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    plugins: { '@effect': effect },
    languageOptions: {
      parserOptions: {
        // The app deliberately has one tsconfig per process boundary and no
        // root tsconfig.json, so the projects are listed rather than
        // discovered.
        project: [
          './app/tsconfig.node.json',
          './app/tsconfig.web.json',
          './app/tsconfig.test.json'
        ],
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // Surfacing an unused value is a real signal; an intentionally ignored
      // one is spelled with a leading underscore.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' }
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@effect/no-import-from-barrel-package': 'error',

      // `onClick={() => setOpen(true)}` is the ordinary way to write a React
      // handler; only non-shorthand void confusion is worth flagging.
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      // Numbers in template literals are unambiguous.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // The app reads index signatures (frontmatter, process.env) with bracket
      // notation, which `noPropertyAccessFromIndexSignature` now requires.
      '@typescript-eslint/dot-notation': ['error', { allowIndexSignaturePropertyAccess: true }]
    }
  },

  // Node-side processes.
  {
    name: 'app/node-processes',
    files: ['app/src/{main,preload,core}/**/*.ts', 'app/*.config.ts', 'app/tests/**/*.ts'],
    languageOptions: { globals: globals.node }
  },

  // Main and Preload stay promise-based under ADR 0001.
  {
    name: 'app/effect-boundary',
    files: ['app/src/{main,preload}/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { paths: [noEffectOutsideCore] }]
    }
  },

  // The sandboxed Renderer and the shared contract reach neither Node,
  // Electron, nor Effect.
  {
    name: 'app/sandbox-boundary',
    files: ['app/src/renderer/**/*.{ts,tsx}', 'app/src/shared/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { paths: [noEffectOutsideCore], patterns: [noNodeInSandbox] }
      ]
    }
  },

  // React, everywhere there is JSX. `eslint-plugin-react` 7.x calls APIs that
  // ESLint 10 removed, so the maintained ESLint React plugin replaces it; the
  // React Compiler rules come from eslint-plugin-react-hooks v7.
  {
    name: 'react',
    files: ['**/*.tsx'],
    extends: [
      reactHooks.configs.flat['recommended-latest'],
      jsxA11y.flatConfigs.recommended,
      eslintReact.configs['disable-conflict-eslint-plugin-react-hooks']
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } }
    }
  },
  {
    name: 'react/app',
    files: ['app/**/*.tsx'],
    extends: [eslintReact.configs['recommended-type-checked']]
  },
  {
    name: 'react/prototypes',
    files: ['prototypes/**/*.tsx'],
    extends: [eslintReact.configs.recommended]
  },

  // Source-owned shadcn primitives are pass-through wrappers around native
  // elements: they cannot declare their own label association, so the rule is
  // enforced at the call sites (which are linted) instead.
  {
    name: 'react/ui-primitives',
    files: ['app/src/renderer/src/components/ui/**/*.tsx'],
    rules: { 'jsx-a11y/label-has-associated-control': 'off' }
  },

  // Unit tests.
  {
    name: 'vitest',
    files: ['app/src/**/*.test.ts'],
    extends: [vitest.configs.recommended],
    rules: {
      'vitest/expect-expect': 'error',
      'vitest/no-focused-tests': 'error',
      'vitest/no-disabled-tests': 'warn'
    }
  },

  // Playwright shell tests.
  {
    name: 'playwright',
    files: ['app/tests/**/*.spec.ts'],
    extends: [playwright.configs['flat/recommended']]
  },

  // Throwaway design evidence: lint it, but do not hold it to the product's
  // type-aware bar.
  {
    name: 'prototypes',
    files: ['prototypes/**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommended, tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.browser },
    rules: {
      // Interaction polish and hook naming belong to the real app. A
      // prototype exists to answer a design question and is then discarded.
      'jsx-a11y/no-autofocus': 'off',
      '@eslint-react/use-state': 'off'
    }
  },

  // Repo-level config files, and the maintenance scripts beside them.
  {
    name: 'repo/config-files',
    files: ['*.mjs', '*.js', 'scripts/**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node }
  },

  // Must stay last: turns off every rule Prettier owns.
  prettier
)
