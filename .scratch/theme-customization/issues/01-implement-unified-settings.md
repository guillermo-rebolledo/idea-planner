# Implement unified Settings and appearance customization

Status: resolved

Spec: `.scratch/theme-customization/spec.md`

Implement the validated Variant A design in production, including persistence, contrast-safe custom
palette derivation, the consolidated Harnesses surface, and focused verification.

## Answer

Implemented Variant A as the production Settings surface. General and Harnesses now share the large
sidebar dialog with Appearance; custom colors persist across restart, derive a contrast-safe palette
from the real background, and remain a draft until explicitly applied. The custom editor is removed
from the accessibility and interaction tree when a preset is selected and slides/fades in from the
right only for Custom.

Verification: formatting, lint, prototype compilation, application typecheck/build, and all 592 unit
tests pass. Electron shell tests cannot launch in this environment because its Electron executable
rejects Playwright's injected `--remote-debugging-port=0` argument; all 33 launch-dependent tests fail
at the same pre-application boundary.
