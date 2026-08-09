# Run plan prototype

Throwaway UI prototype answering:

> Where does the Conversation show the plan a Run is working through, and what
> does reading it look like?

Run it from the repository root:

```bash
pnpm prototype:plan
```

Three variants, switchable with `?variant=A|B|C`, the floating bar, or the
← / → arrow keys.

| Key   | Name                   | Where the plan lives                                         | What it is optimised for                |
| ----- | ---------------------- | ------------------------------------------------------------ | --------------------------------------- |
| A     | The working row grows  | The existing live footer row, expanding in place             | _What is it doing now?_                 |
| **B** | **One anchored block** | **Inline, where the plan first appeared, mutating in place** | _What did it commit to, and where?_     |
| C     | The plan is the header | A pinned band above the transcript, done steps folded        | _How much is left, and what is coming?_ |

## What is real here

The prototype imports the app's own `styles.css` through
`app/run-plan.prototype.vite.config.ts`, so the tokens, type scale, fonts and
dark theme are the product's rather than a lookalike. The Conversation
furniture around it — sidebar, header, composer — is there so density is judged
honestly, not because any of it is being proposed.

Everything else is a fixture in `src/plan.ts`. It is not a data-model proposal,
but it is deliberately faithful to what the two Harnesses actually send, per
`.scratch/research/agent-todo-plan-indicator.md`:

- **The whole list arrives every time.** Neither Harness sends a delta.
- **`activeForm` is Claude's and Codex has none**, so the present-continuous
  phrasing is optional and every variant has to say what it does without it.
- **Three statuses, exactly**: `pending` / `in-progress` / `completed`.

Two house rules from `SubagentDock.tsx` are obeyed rather than re-litigated per
variant: a completed step is **not green** (green is an addition in this app),
and state is carried in **text**, not colour alone.

## The replay

The scripted Run is 56 seconds long and loops. The floating bar plays, pauses
and scrubs it, and spells out the count and the current step, because a plan
surface judged only at `7/7` has not been judged.

**Scrub to second 23.** That is where the agent rewrites the list — two steps
inserted, one reworded — which is the moment that separates a surface that
animates a status change from one that flickers the whole list. Rows are keyed
by step text (with an occurrence ordinal for duplicates), never by index and
never by anything containing the status, which is the bug T3 Code shipped.

## Verdict

**B, anchored.** The plan belongs in the transcript rather than in a footer —
it is part of the story of the Run, and where it appeared is meaningful: it is
the moment the Run stopped exploring and committed to a shape.

But B was first drawn Codex's way, a block appended per `update_plan`, and that
was wrong. Codex does it because a terminal cannot mutate scrollback; the block
therefore reappears further down after every message and every log line, and by
the end of a Run the transcript is a diff log of a list. **So the block is
anchored at the first sighting and every later rewrite mutates it in place.**
It never moves and it is never re-emitted.

**It opens by default and folds to its header.** Collapsing reduces the plan
rather than hiding it: the `3/7` stays, and the step being worked on moves up
into the header, still shimmering while the Run is live. A fold that left only
the word "Plan" behind would cost the reader the one thing they most likely
wanted. The fold state is per-plan and survives every rewrite — a person who
collapsed it does not get it sprung open again by the agent.

Three consequences that came with the choice and are part of it:

- **The live row still says what the Run is on now.** An anchored block does
  not follow the reader, so scrolling away from it would otherwise lose the
  current step. This is variant A's row, kept underneath — not instead of B.
- **The rewrite happens off screen.** At second 23 the agent inserts two steps
  and rewords a third somewhere the reader may not be looking. That is the one
  thing the appended blocks were buying, and it is given up deliberately. If it
  turns out to matter, the answer is a mark on the live row, not a second
  block.
- **Collapsed and the live row now say the same thing.** Both carry the current
  step. That is redundancy worth keeping while the block is on screen and worth
  removing if the row ever grows the count too — a question for the real
  implementation, not for the fixture.

Variants A and C stay here as the evidence for that choice. When this is folded
into the real Conversation, they and the switcher come out of `main` and this
directory moves onto a throwaway branch.

Read-only, in-memory, no tests, not production architecture.
