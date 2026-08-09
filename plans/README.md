# Animation plans

| #   | Plan                                                                  | Severity | Status | Depends on                 |
| --- | --------------------------------------------------------------------- | -------- | ------ | -------------------------- |
| 001 | [Animate the shared modal arrival](001-animate-modal-arrival.md)      | LOW      | DONE   | —                          |
| 002 | [Explain the Files panel arrival](002-animate-files-panel-arrival.md) | LOW      | DONE   | 001 motion-token placement |
| 003 | [Animate the outcome notice lifecycle](003-animate-outcome-notice.md) | LOW      | DONE   | 001 `--ease-out` token     |

## Recommended execution order

1. **001** establishes the shared strong ease-out token and improves every modal call site.
2. **003** uses that token and adds the only retained exit lifecycle in this batch.
3. **002** adds the drawer curve and right-edge Files-panel entrance without touching layout timing.

The plans may be implemented in one branch, but each must keep its stated scope and verification
criteria. After all three land, run the repository-wide `pnpm verify` gate and perform the three
reduced-motion feel checks together.
