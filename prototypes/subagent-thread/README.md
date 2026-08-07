# Subagent thread prototype

Throwaway UI prototype answering:

> When a Run spawns subagents, where does the Conversation say so, and what does opening one look like?

Run it from the repository root:

```bash
pnpm prototype:subagents
```

Three variants, switchable with `?variant=A|B|C`, the floating bar, or the ← / → arrow keys.

| Key | Name                       | Where subagents are announced                                                        | Where one is read                           |
| --- | -------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------- |
| A   | Pills in the prose         | A line of pills and a verb per fleet event, inline in the transcript (Codex's shape) | A 380px sidebar beside the transcript       |
| B   | One folded block           | One folded line — "Dispatched 3 subagents — 2 clean, 1 needs attention"              | The transcript column itself, drilled into  |
| C   | The fleet has its own dock | A quiet one-line mention; the fleet lives in a right-hand dock of live cards         | The dock, which becomes the thread in place |

## What is real here

The prototype imports the app's own `styles.css` and its real `ChainOfThought`
primitive through `app/prototype.vite.config.ts`, so the tokens, type scale,
fonts, dark theme and disclosure motion are the product's rather than a
lookalike. Everything else — the Run, the three subagents, their steps and
results — is a fixture in `src/fleet.ts`.

## The replay

The scripted Run is 34 seconds long and loops. The floating bar plays, pauses
and scrubs it, and spells out each agent's state, because a surface that reads
well at second 30 and badly at second 9 has not been judged. Two agents finish
clean, and a third (`Fixture sweep`) comes back unable to verify — a fleet
where everything succeeds hides what failure costs each layout.

Also on the bar: a light/dark toggle.

## Verdict

**Variant C, the dock, is the direction.** A running fleet is a dashboard
question rather than a reading question: the transcript should not have to be
scrolled to find out whether an agent is stuck, and a fleet of ten agents
should not cost ten times the vertical space of a fleet of two.

C was then taken further, and this is the shape to build:

- **The Conversation's whole mention of the fleet is one pill** — overlapping
  agent marks, "3 subagents created", and a live count. It is a toggle: it
  opens the dock, and clicking it again puts the dock back on its rail.
- **The dock opens and resizes like the Files panel** — an `aside` beside the
  transcript rather than over it, its own left edge as the drag handle, arrow
  keys from the keyboard, 280–560px and never past 42vw.
- **It collapses like the inbox: to a rail, not to nothing.** 44px of agent
  marks with a live state dot each, because a fleet that vanished when it was
  in the way would leave nobody able to notice an agent had failed. Clicking a
  mark opens the dock straight onto that agent.
- **A card says state, not percentage.** A subagent cannot report how much of
  its work is left, so there is no progress bar: the card carries the agent's
  name, what it is on now, how long it has been going, its state
  (Working / Done / Needs attention) and the number of steps it has actually
  taken. A bar advancing on elapsed time would be inventing a denominator.
- **It follows the Run until somebody takes it over** — open while agents work,
  collapsed once they land — using the same "claimed" rule `ChainOfThought`
  already uses, so a person who opens or collapses it is not overruled.

Variants A and B stay here as the evidence for that choice. When this is folded
into the real Conversation, they and the switcher come out of `main` and this
directory moves onto a throwaway branch.

Read-only, in-memory, no tests, not production architecture.
