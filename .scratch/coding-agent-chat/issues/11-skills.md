# 11 — Skills

**What to build:** The user types `/` in the composer, sees the methodologies available to them, and picks one for that message. The agent then works to that methodology — test-driven development, bug diagnosis, code review — for that turn.

Skills are per-message, not per-Session. Real coding work switches methodology constantly within one thread of context: diagnose, then test-drive the fix, then review the diff. Binding a whole Session to one methodology would force the user to abandon it or start fresh and lose everything the agent has learned.

Skills are optional. Nothing is required, nothing blocks. When the user has skills installed, the app says so and suggests trying them — encouragement, never a gate.

Discovery covers the user's global skill directories and the Project's own. **Project skills stay inert until the user trusts that Project once.** A skill is instruction text steering an agent that has write and command access; a repo-local skill arrives by `git clone` from someone the user may not know, and the app would be *recommending* it. Trust is granted per Project, with the skills shown, and is revocable.

This ticket also wires `offer_response_options` to Suggested Responses: when a skill offers structured choices, they render as buttons, the Session goes `blocked`, and choosing one submits it as the user's turn. Custom text is always available. Prose lists are never treated as choices — a false `blocked` destroys trust in the inbox group.

Skills work better on Claude Code, which supports them natively, than on Codex, where the app injects the methodology as instruction text. Surface that difference rather than hiding it. Retain the existing MIT attribution.

One duplication to remove: the list of usable Skills is currently hardcoded in two places — `VERIFIED_SKILLS` in Main, and the Skill `<select>` in the Renderer. Ticket 03 left it that way because discovery is this ticket's job. Discovery should leave exactly one source of truth.

**Blocked by:** 06, 09

**Status:** ready-for-agent

- [ ] Skills are discovered from global directories and from the Project
- [ ] Project skills are inert until that Project's skills are trusted, once, with the skills shown; trust is revocable
- [ ] Typing `/` in the composer lists available skills and inserts one for that message
- [ ] A Run records which Skill it used, with provenance pinned
- [ ] Structured choices render as Suggested Responses and move the Session to `blocked`; prose lists never do
- [ ] Choosing a Suggested Response submits it as an immediate visible user turn
- [ ] The app indicates when skills are installed and suggests them, without ever requiring them
- [ ] The Codex limitation is stated in the UI
- [ ] Attribution is retained
- [ ] `pnpm verify` passes
