# Research T3 Code executable discovery

Type: research
Status: resolved

## Question

How does the official T3 Code Electron app discover and verify locally installed Codex and Claude executables on macOS, and which parts of that approach fit this product's stricter security boundary?

## Answer

T3 Code performs no hardcoded-directory or whole-disk scan. It reconstructs PATH with bounded login-shell environment capture, falls back to `launchctl`, merges inherited PATH, accepts explicit binary overrides, and probes providers through their native version or protocol surfaces. Adopt the no-scan, argument-vector, capability-probe pattern, but require one-time consent before login-shell hydration because it executes user shell startup files; keep explicit binary selection verified and sandboxed.

Full evidence: [T3 Code executable discovery](../research/t3-code-executable-discovery.md).
