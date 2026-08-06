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

/** Effect stays behind transport and presentation seams — see ADR 0001. */
const noEffectAtTransportOrUi = {
  group: ['effect', 'effect/*'],
  message:
    'Effect is confined to Core and Main product behavior (docs/adr/0001-adopt-effect-in-core.md). Keep shared contracts, Preload, and Renderer Effect-free.'
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
      // Scratch space for issues, specs, and design handoff bundles — never
      // product code.
      '.scratch/**',
      // Generated from the installed Codex binary; regenerated, never edited.
      'app/src/core/harness/codex-protocol/**',
      // Vendored from assistant-ui's shadcn registry and trimmed by hand;
      // kept close to its source so it stays diffable (ticket 13).
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

  // Electron, IPC, and Preload adapters stay promise-based under ADR 0001.
  {
    name: 'app/effect-boundary',
    files: [
      'app/src/preload/**/*.ts',
      'app/src/main/index.ts',
      'app/src/main/core-client.ts',
      'app/src/main/mcp-proxy.ts'
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: [noEffectAtTransportOrUi] }]
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
        { patterns: [noEffectAtTransportOrUi, noNodeInSandbox] }
      ]
    }
  },

  // Every value a component uses comes from the token layer in `styles.css`
  // (ticket 15). A palette colour or a bracketed size written into a class is
  // a value that no theme can reach, so it is a design question rather than a
  // lint annoyance: add the role you need to the token layer instead.
  {
    name: 'app/design-tokens',
    files: ['app/src/renderer/**/*.tsx'],
    // The provider marks are the providers' own colours, not this app's, and
    // there is no theme in which Anthropic's orange should become something
    // else.
    ignores: ['app/src/renderer/src/components/ui/logos.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'Literal[value=/(^|\\s)(bg|text|border|ring|fill|stroke|from|via|to|shadow|outline|divide|caret|decoration|p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|w|h|size|gap|min-w|min-h|max-w|max-h|rounded|leading|tracking|duration|delay)-(\\[|(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-)/]',
          message:
            'Use a semantic token from styles.css, not a raw value or a palette colour: a theme cannot reach this.'
        },
        {
          selector:
            'Literal[value=/#[0-9a-fA-F]{3}\\b|#[0-9a-fA-F]{6}\\b|rgba?\\(|hsla?\\(|oklch\\(/]',
          message:
            'Colours belong to the token layer in styles.css, where every theme can restate them.'
        }
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
