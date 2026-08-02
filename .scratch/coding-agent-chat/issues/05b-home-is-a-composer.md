# 05b — Home is a composer

**What to build:** The app opens on a chat. The person types, accepts or changes the Project, sends, and a Session exists. Home *is* a new chat, and a **New chat** action sits above everything in the sidebar and returns to it. Selecting a Session opens it.

Ticket 05a made Sessions app-owned and bound them to Projects. This is the surface that uses it.

The target Project is displayed prominently in the composer rather than tucked into a subtle dropdown, because after [ADR 0004](../../../docs/adr/0004-in-place-primary-checkout.md) sending to the wrong Project means real edits in the wrong place.

## Carried from tickets 04 and 05

- **The `+` on a Project row**, which opens the composer already bound to that Project. Deferred from 04 because Sessions had no Project; 05a gave them one.
- **Renaming `workingDirectory` to `checkout`.** Tickets 03 and 04 both declined it because the field held a Session's own folder rather than a checkout of anything. Once a Session works against its Project's primary checkout, the name is true.
- **Retiring the capture form.** A Session is created on send, from a message — not from a title and notes saved for later.

## Two things ticket 05a left for the composer

`suggestSessionTitle` was deleted in 05a: with notes gone it had no caller, and dead code is dead code. A composer that derives a Session title from the first message will want it back — it is one `git show` away rather than something to write again.

`listDamagedSessions` was surfaced in 05a itself, in the inbox, so this ticket inherits nothing there.

**Blocked by:** 05a

**Status:** done

- [x] The launch surface is a composer with a Project selector defaulting to the last used
- [x] A Session is created on send, not before, and appears in the sidebar
- [x] The target Project is unmissable in the composer
- [x] The `+` on a Project row opens the same composer pre-bound to it
- [x] **New chat** is always available in the sidebar and returns to the launch surface
- [x] A Session's working directory is its Project's primary checkout, and the field is named for what it holds
- [x] The capture form is gone, and no surface creates a Session without a message
- [x] `pnpm verify` passes
