# Code style and checks

## Before you finish

Run `pnpm verify` from the repo root. It is the whole gate:

```
pnpm verify   # prettier --check → eslint → prototype build → app typecheck + unit + shell tests
```

Individual steps: `pnpm lint`, `pnpm lint:fix`, `pnpm format`, `pnpm format:check`.

## Git hooks

Husky installs these on `pnpm install` (via the `prepare` script):

- **pre-commit** (~5s) — `lint-staged` formats and lints only the staged files,
  then the app typecheck and Core unit tests run. Formatting fixes are applied
  and restaged automatically; a lint error aborts the commit and leaves your
  work untouched.
- **pre-push** — the full `pnpm verify`, including the prototype build and the
  packaged-shell acceptance tests.

`--no-verify` skips a hook. Use it for a genuine emergency, not to get a red
change past the gate — pre-push exists precisely so broken code does not leave
the machine.

## Formatting is not a judgement call

Prettier owns every formatting decision (`prettier.config.mjs`: no semicolons,
single quotes, 100 columns, no trailing commas, sorted Tailwind classes). Never
hand-format to taste and never argue with the formatter — run `pnpm format`.
`eslint-config-prettier` is applied last in the ESLint config, so no lint rule
can conflict with it.

`.scratch/` is deliberately not formatted: the issue-tracker skills own the
layout of those files.

## Linting

`eslint.config.mjs` is one flat config for the repo:

- `app/` is type-aware linted with `typescript-eslint` strict + stylistic,
  the ESLint React plugin, React Compiler rules from `eslint-plugin-react-hooks`,
  `jsx-a11y`, Vitest rules for `*.test.ts`, and Playwright rules for `tests/`.
- `prototypes/` is throwaway design evidence. It is linted for real mistakes
  only, without type-aware rules.

Type-aware rules need every app file to belong to one of the three tsconfigs
listed in the config. A new source directory must be added to
`tsconfig.node.json` or `tsconfig.web.json`, or ESLint will refuse to parse it.

## Enforced architecture boundaries

Two `no-restricted-imports` rules encode decisions that are otherwise easy to
erode. Treat a violation as a design question, not a lint annoyance:

- **Effect stays behind product-behavior seams.** Core and Main product behavior
  may import `effect`; `src/preload`, `src/shared`, and `src/renderer` may not
  (ADR `docs/adr/0001-adopt-effect-in-core.md`). Effect values must be unwrapped
  before Electron callbacks, IPC, shared contracts, or presentation state.
- **The sandbox holds.** `src/renderer` and `src/shared` may not import
  `node:*` or `electron`. Renderer capabilities go through the Preload surface
  declared in `@shared/contract`.

## When a rule is wrong

Disable it at the narrowest scope with a comment saying why — a line-level
`eslint-disable-next-line` for a one-off, a scoped block in
`eslint.config.mjs` for a whole category. Do not turn a rule off globally, and
do not delete a rule to make a red build green.
