---
target: the app as a whole (renderer)
total_score: 29
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 2
timestamp: 2026-08-03T23-02-16Z
slug: src-renderer-src
---
# Critique — Argos renderer (whole app)

Method: dual-agent (A: a9e77052b6edec088 · B: a6ebde8ccc34c35ee). Browser overlay skipped: Electron renderer not running/reachable as a URL.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 4 | Live indicator, elapsed time, status dots; only lag is 750ms polling |
| 2 | Match System / Real World | 2 | Harness/Checkout/Run/Standing Approval used before ever being taught |
| 3 | User Control and Freedom | 3 | Undo is single-shot; Remove Project has no confirm and no undo |
| 4 | Consistency and Standards | 3 | Worktree chip opens a popover whose option is named Isolated |
| 5 | Error Prevention | 4 | Launch Gate, git-init offer, Skills quarantine, Ask-by-default |
| 6 | Recognition Rather Than Recall | 3 | Conversation never restates which Project/Checkout it edits |
| 7 | Flexibility and Efficiency | 3 | Good shortcut set, but no list keyboard nav, no shortcut reference |
| 8 | Aesthetic and Minimalist Design | 4 | Six type sizes, luminance hierarchy, rationed color |
| 9 | Error Recovery | 4 | Nine failure categories mapped to plain-language next steps + resend |
| 10 | Help and Documentation | 1 | No help surface, glossary, tour, or shortcut list anywhere |
| **Total** | | **29/40** | **Good (borderline)** |

## Design Specificity Verdict

LLM assessment: emphatically authored, not category-interchangeable — controlled vocabulary, "git is the only undo" worldview, Project name inside the composer's sentence, rationed color. The inverse risk: designed for people who already share its worldview; the vocabulary is used consistently but never taught.

Deterministic scan: 2 findings, both `overused-font` (Geist / Geist Mono in styles.css) — judged false positives for a developer desktop tool where the mono face is load-bearing. No layout/a11y/contrast rules fired. Detector and reviewer agree the visual system is clean; every real issue is interaction/vocabulary, not pixels.

## Priority Issues

- **[P0] Enter-to-approve is an unsafe global default** (Conversation.tsx keydown). The highest-stakes action — allowing an agent's shell command — fires on the most reflexive key with focus anywhere outside a control. Fix: focus the approval card on arrival; Enter allows only while it (or its buttons) hold focus; Escape=deny stays global.
- **[P1] Permission Mode does not travel** — chosen in the Composer, silently reset to Ask in Conversation (`useState('ask')`). Seed from the Session's last Run configuration and announce changes via the existing configuration boundary note.
- **[P1] Vocabulary used before taught** — first-launch copy is "No Harness can run a Session yet"; onboarding defines Project only. Fix: bind each term at first encounter ("a Harness — a coding agent CLI like Claude Code or Codex") and add a small glossary/help entry to the AppMenu (also lifts H10 from 1).
- **[P2] Worktree/Isolated naming asymmetry** — a chip labeled Worktree opens options with no row named Worktree. Deliberate per spec (CONTEXT.md) but confusing on screen; consider "Isolated (worktree)" on the option row.
- **[P2] Remove Project: instant, unconfirmed, no undo** — while Delete Session gets an alertdialog. Add ⌘Z parity or a lightweight confirm naming what happens to its Sessions.
- **[P3] Background Run completion is nearly silent** — only a sidebar dot changes. aria-live announce + optional macOS notification when unfocused.

## Persona Red Flags

- Alex (power user): no ↑/↓ across Session rows; amber "waiting" count expands the rail instead of opening the blocked Session; no next/prev-session shortcut; shortcuts scattered with no reference.
- Sam (accessibility): hover-revealed quick actions rest at opacity-0; status dot disappears exactly on row focus; Modal has no focus trap (Tab escapes the dialog); 10–11px body text with no type-size preference.
- Jordan (first-timer): gate headline has two undefined nouns in seven words; unlabeled chips ("Local", "Ask") can't be identified until clicked; "/ for a Skill" is a third undefined noun; no accept/reject step exists and nothing says that's intentional where the diff is shown.

## Cognitive Load

Moderate (3 failures): the Composer stacks 6–9 simultaneous decisions (Project, Checkout, Permission, model+effort, Skill, Continue chips); Permission Mode is a working-memory bridge across the Composer→Conversation boundary; the Readiness dialog exceeds chunking limits on the exact surface a stressed user meets.

## Emotional Journey

Peak: end-of-run divider + collapsed activity summary. Valleys: Enter-to-approve stakes inversion; `supervision-failed` copy is honest but abandoning; background completion has no payoff moment. High-stakes reassurance (approval card, delete dialog, verbatim rule text) is excellent.

## Minor Observations

- AgentText renders backtick chips only — agent markdown (headings, lists, fenced code) will show raw `###` and ``` fences; the most visible polish gap in real use.
- RunDivider renders an `<li>` outside any list — semantics smell.
- Conversation loading/failed states are stray cards, not centered like App.tsx's.
- Skills `/` popover repeats the licence attribution on every invocation.
- Archived view: entered via AppMenu, exited via a small X — asymmetric paths.
- Project picker menu is a flat list with full mono paths; unwieldy past ~8 Projects.
- WhereAmI branch chip flashes an em-dash before facts load.

## Questions to Consider

1. If the copy has to work this hard, is the model too complicated — could Checkout and Run become invisible on the 80% path?
2. Why does the safest-feeling app in the category bind its most dangerous action to Enter?
3. Who is the second user? If the git-literate expert could just use the CLI, is the real audience the less-expert developer this vocabulary locks out?
