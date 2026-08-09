# Project source flow prototype

Throwaway UI prototype answering:

> How should adding a Project expand from a native folder picker into a Local
> folder / Git URL / GitHub flow?

Run it from the repository root:

```bash
pnpm prototype:project-source
```

Switch variants with `?variant=A|B|C`, the floating bar, or ← / →. Use
`?state=source|configure|cloning|failed` or the state controls in the floating
bar to compare the same moment across variants.

| Key   | Name                  | Bet                                                                                         |
| ----- | --------------------- | ------------------------------------------------------------------------------------------- |
| A     | Command palette       | Progressive disclosure keeps repeat use fast and matches T3 Code's interaction model        |
| **B** | **Add Project modal** | **One reusable modal serves first-run onboarding and every later Add / New Project action** |
| C     | Guided wizard         | A persistent step rail makes the filesystem mutation and recovery model clearest            |

## What is real here

The prototype imports Argos's real stylesheet, tokens, fonts, button primitive,
and utility conventions. The surrounding Session shell is contextual furniture,
not a redesign proposal.

Every mutation is simulated in memory. The shared state deliberately includes
source selection, configuration, cloning progress, and a failed/cancelled clone
whose partial destination remains on disk. That last state is part of the design
question: the UI must name the retained path without turning cancellation into
an automatic destructive action.

No variant is production architecture. Once one wins, its interaction decision
should be rewritten into the real onboarding/app-menu flow and the prototype
captured on a throwaway branch as design evidence.

## Verdict

**B — Add Project modal.** The modal opens by default when the app has no
Projects, over an empty workspace with an **Add Project** action. Dismissing it
leaves that empty state available, while the sidebar's **New Project** action
opens the same modal for repeat use. For GitHub, both values are selections
rather than free-form strings:

- **GitHub repository** opens a searchable popover of repositories accessible
  to the authenticated `gh` account, including private repositories.
- **Clone into** opens a popover of recent/common parent folders and ends with
  **Choose another folder…**, which hands off to the system directory picker.
  The trigger previews the child folder Argos will create.

**Local folder** has no drag-and-drop target. Its single **Choose project
folder…** button opens the system directory picker. The native picker is a
user-initiated runtime grant; the operating system may request access to a
protected location.
