# 09 — Readiness rework and the launch gate

**What to build:** On launch the app checks whether any Harness is actually usable, and if none is, it says so plainly and shows how to fix it. The app is unusable without a Harness, and that is the accepted deal — there is no capture-only fallback in this product.

**Usable** means executable, compatible, *and* authenticated. Gating on mere presence is not enough: a Harness on `PATH` but not logged in is the more common failure, and it produces exactly the "I typed my first message and nothing worked" experience the gate exists to prevent.

Two dimensions change meaning. `skills` stops blocking anything — skills are optional per [ADR 0003](../../../docs/adr/0003-harness-native-permissions.md) and the old required set named planning skills that no longer exist. It becomes informational and feeds the nudge in ticket 11. `sandbox` retires entirely, since containment now belongs to the Harness.

Guidance stays copyable and is never executed by the app.

## One probe to re-judge

Readiness still probes macOS Seatbelt — Codex through its own `sandbox` subcommand, Claude by checking `/usr/bin/sandbox-exec` exists. The app stopped using Seatbelt itself in ticket 02, so this now gates the app on a facility only the Harness uses. Decide whether that is still the app's business: Codex genuinely needs it for its own sandbox, while for Claude it may now be nothing to do with us.

Readiness copy changed in 05a: "Not usable — capture still works" became "Not usable yet", because capture no longer exists and the old string promised something untrue. This ticket decides what an unusable Harness actually leaves a person able to do, and says that instead.

Ticket 05b removed the last place readiness was restated before a Run could start: the capture form said "Ready Harnesses: …" immediately before saving. The composer does not, because a gate is a better answer than a restatement — this ticket is that gate.

**Blocked by:** 05a

**Status:** done

- [x] Readiness reports executable, compatibility, and authentication per Harness, independently repairable
- [x] The app blocks use unless at least one Harness is usable, and explains which are missing what
- [x] Recovery is possible without restarting: fix the problem, re-check, continue
- [x] `skills` is informational and blocks nothing; the planning-era required-skill set is gone
- [x] The `sandbox` dimension is removed
- [x] Install and login guidance is copyable and never executed
- [x] Harness discovery still avoids filesystem scans and asks consent before login-shell startup files
- [x] `pnpm verify` passes

## Answer — the Seatbelt probe

Both Seatbelt probes are gone: Codex's `sandbox` subcommand and Claude's check for `/usr/bin/sandbox-exec`.

The counter-argument in this ticket is that Codex genuinely needs Seatbelt for its own sandbox. It does — and that is the reason to stop probing it here, not to keep it. The app stopped using Seatbelt itself in ticket 02, so what the probe gated was a Harness's own containment, and it gated the *whole Harness*: a machine where `codex sandbox` failed was told Codex was unusable, even for work that never touches that mode. When Codex cannot sandbox, Codex is the thing that knows, at the moment it matters, in its own words — and a Run that fails for that reason now reports what Codex said rather than what this app guessed a launch earlier.

The Claude side was weaker still: checking that a macOS binary exists said nothing about Claude, which does not use it.

## Answer — what "usable" leaves you able to do

Nothing, in this app, if it is the only Harness — which is why the gate exists rather than a warning. The two questions are now answered separately, because they have different answers: **usable** stays Readiness's three checks and is what the person repairs, while the gate asks whether any Harness can actually run a Session. A Codex that is installed, compatible, and signed in is usable and still cannot run a Session here, so its card says both.
