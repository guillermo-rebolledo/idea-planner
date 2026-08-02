# 09 — Readiness rework and the launch gate

**What to build:** On launch the app checks whether any Harness is actually usable, and if none is, it says so plainly and shows how to fix it. The app is unusable without a Harness, and that is the accepted deal — there is no capture-only fallback in this product.

**Usable** means executable, compatible, *and* authenticated. Gating on mere presence is not enough: a Harness on `PATH` but not logged in is the more common failure, and it produces exactly the "I typed my first message and nothing worked" experience the gate exists to prevent.

Two dimensions change meaning. `skills` stops blocking anything — skills are optional per [ADR 0003](../../../docs/adr/0003-harness-native-permissions.md) and the old required set named planning skills that no longer exist. It becomes informational and feeds the nudge in ticket 11. `sandbox` retires entirely, since containment now belongs to the Harness.

Guidance stays copyable and is never executed by the app.

## One probe to re-judge

Readiness still probes macOS Seatbelt — Codex through its own `sandbox` subcommand, Claude by checking `/usr/bin/sandbox-exec` exists. The app stopped using Seatbelt itself in ticket 02, so this now gates the app on a facility only the Harness uses. Decide whether that is still the app's business: Codex genuinely needs it for its own sandbox, while for Claude it may now be nothing to do with us.

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] Readiness reports executable, compatibility, and authentication per Harness, independently repairable
- [ ] The app blocks use unless at least one Harness is usable, and explains which are missing what
- [ ] Recovery is possible without restarting: fix the problem, re-check, continue
- [ ] `skills` is informational and blocks nothing; the planning-era required-skill set is gone
- [ ] The `sandbox` dimension is removed
- [ ] Install and login guidance is copyable and never executed
- [ ] Harness discovery still avoids filesystem scans and asks consent before login-shell startup files
- [ ] `pnpm verify` passes
