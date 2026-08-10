# The Codex protocol bindings

`app/src/core/harness/codex-protocol/` is generated from the installed Codex
binary and never edited by hand. `app/src/core/harness/fixtures/codex-app-server.jsonl`
is a session recorded from that same binary, and
`app/src/core/harness/fixtures/codex-review.jsonl` is a detached review
recorded from it. All three are pinned to one version, and all three are
regenerated together when it moves.

## Why generated rather than written

The published Codex documentation and the shipped binary disagree. The docs
show `"sandbox": "workspaceWrite"`; 0.146.0 answers

```
unknown variant `workspaceWrite`, expected one of `read-only`, `workspace-write`, `danger-full-access`
```

and the nested `sandboxPolicy` object uses the camelCase spellings after all —
so both casings exist, on different fields. Transcribing from the docs
produces code that is rejected at runtime by a Harness that was working
yesterday. The binary can emit its own contract, so it does.

## Regenerating, when the supported version moves

```
pnpm codex:protocol       # rewrites the bindings from the installed binary
pnpm codex:record         # re-records the contract fixture (costs one Codex request)
pnpm codex:record-review  # re-records the review fixture (costs one more)
pnpm verify
```

A review is protocol of its own rather than a variant of a turn: `review/start`
answers with the id of a thread Codex runs the review on, and everything worth
reading arrives under that id. So it has its own recording and its own suite,
`app/src/core/harness/codex-review.test.ts`. The review itself answers in
prose — findings first, `[P1] Title — path:line`, one paragraph each — and
`parseReviewReport` in `@shared/review` is what turns that into located
Findings. When the shape of that prose moves, the recording is what proves it.

Read both diffs. The bindings are types, so a shape change becomes a compile
error — `app/src/core/harness/codex.ts` deliberately asserts that the wire
values the app sends are still ones the generated contract declares, which is
where a moved enum stops the build rather than a Run. The fixture diff is the
behaviour change: what the Harness now says, and whether the Adapter still
reads it. Update `codex.test.ts` to whatever the recording proves.

Then move `conversation.minimumVersion` for Codex in `app/src/main/readiness.ts`.
Below it the app has bindings that were never checked against what that Harness
sends, and readiness says so rather than letting a Run report nothing.

## What is not generated

The events the app runs on are its own (`@shared/conversation`), and the
Adapter validates incoming frames with zod rather than trusting the generated
types at runtime — generated types describe the shapes, they do not check
them. Only the fields the app actually reads are validated; everything else on
the wire is ignored on purpose, so a new field is not a failure.
