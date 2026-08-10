# Can Claude Code be steered mid-turn, on the invocation this app uses?

Research date: 2026-08-09

Harness under test: Claude Code `2.1.226` at `/Users/guillermoortizrebolledo/.local/bin/claude` (native binary, macOS arm64).

Probe: `pnpm claude:probe-steer` (`scripts/probe-claude-steering.mjs`). Recorded stream: `app/src/core/harness/fixtures/claude-steer-probe.jsonl`.

## Question

MEM-125 gave Codex native steering through `turn/steer` and left Claude on the queue, because whether Claude can be steered *the way this app runs it* was unverified. `agent-conversation-ux-comparison.md` §"Open questions" recorded it as the one thing that had to be probed before Claude steering was designed at all — and recorded the assumption that this repo already ran Claude with `--input-format stream-json`.

So: does a user frame written to stdin while a turn is in flight reach that turn, wait for it to end, or go nowhere?

## Executive conclusion

- **The assumption was wrong.** The app ran `claude --print` with the prompt as the last argv argument and `stdin` closed immediately after spawn (`answersProtocol: false`). There was no channel to write a frame to at all.
- **On that invocation a mid-turn write does nothing.** Held open deliberately and written to at +8.7s of a turn, in both plain text and stream-json spellings: the turn ran to its end on its first instruction, wrote `ORIGINAL`, and ended once. The CLI said why on stderr — `Warning: no stdin data received in 3s, proceeding without it` — so with the text input format stdin is a startup-only source of extra prompt, ignored for the rest of the run.
- **With `--input-format stream-json` the running turn takes it.** The prompt goes in as a user frame; a second user frame written at +6.6s, while the CLI was executing a 12-second `sleep`, was folded into the *same* turn. The turn wrote `STEERED` instead of `ORIGINAL`, `num_turns` was 3, and exactly one `result` frame was emitted. Not a queue: no second turn was started.
- **The echo is the acknowledgement.** With `--replay-user-messages`, each frame read off stdin comes back on stdout as a `user` frame marked `isReplay: true`. The correction's echo appeared at +15.6s — after the `sleep` tool result at +14.6s, i.e. the CLI holds a frame until the current step settles and then injects it. There is no request id and no response: this echo is the only signal that a correction was taken.
- **Acted on.** Claude's prompt now travels as a stdin frame, its Run is steered through the delivery intent MEM-125 built, and `HARNESS_SPECS.claude.steering` is `{ minimumVersion: '2.1.226' }` — the version that was watched doing it. Below it the composer keeps saying queue.

## The two arms, as recorded

Both arms run one real turn in a scratch git repository, in `bypassPermissions` with `--setting-sources ''`, so what is measured is the protocol rather than this machine's hooks, plugins, and approval bridge. Both are told to `sleep 12` and then write `ORIGINAL` into a file; the correction, written while the sleep is running, asks for `STEERED` instead.

| | Arm A — prompt in argv, stdin held open | Arm B — prompt on stdin as a user frame |
| --- | --- | --- |
| Extra flags | none | `--input-format stream-json --replay-user-messages` |
| Correction written | +8.7s | +6.6s |
| Echoed back | never | +15.6s |
| `result` frames | 1 | 1 |
| File afterwards | `ORIGINAL` | `STEERED` |
| Verdict | ignored | **steered — the running turn took it** |

Arm A is the shape a Run had before this change, and is generous to it: the real app closes stdin, and the arm holds it open and writes both a bare line and a JSON frame. Neither was read.

## Mechanism, from the recorded stream

Arm B, abridged to the frames that carry the answer (`claude-steer-probe.jsonl`):

```
{"type":"system","subtype":"init", ... ,"capabilities":["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"]}
{"type":"user","message":{...,"content":[{"type":"text","text":"Run exactly this Bash command ..."}]},"isReplay":true}
{"type":"assistant", ... "content":[{"type":"tool_use","name":"Bash","input":{"command":"sleep 12"}}]}
{"type":"system","subtype":"task_started","task_id":"...","tool_use_id":"toolu_...","task_type":"local_bash"}
>>> correction written to stdin at +6623ms
{"type":"system","subtype":"task_notification", ... ,"status":"completed"}
{"type":"user","message":{"content":[{"tool_use_id":"toolu_...","type":"tool_result", ...}]}}
{"type":"user","message":{...,"content":[{"type":"text","text":"Change of plan: write the single word STEERED ..."}]},"isReplay":true}
{"type":"assistant", ... "content":[{"type":"tool_use","name":"Write","input":{"file_path":".../steer-probe.txt","content":"STEERED\n"}}]}
{"type":"result","subtype":"success","num_turns":3, ... ,"result":"done"}
```

Three things worth designing against:

1. **A correction is admitted between steps, not inside one.** It was written 8 seconds before the `sleep` finished and was not echoed until the tool result had landed. A correction cannot cancel work already in flight — for that there is Stop, which is a different act (CONTEXT.md: *"A Steer changes what the active Run should do; it does not Stop or interrupt the Run"*).
2. **The echo is keyed by nothing but its text.** No id comes back. The Adapter therefore holds each correction by the exact text it wrote and matches the echo to it, which is also why the Run's own prompt — echoed the same way — has to be recognised as *not* a correction and dropped.
3. **After the `result` frame the same write starts a new turn.** That is the queue by a longer road, and a worse one: the Run is already concluded by then. So the Adapter refuses to steer once it has seen a result, and the caller queues the message properly.

## What the app had to change

- The prompt moved from argv to the first stdin frame (`harness/open` now carries a Claude launch payload, because protocol frames are Core's to build). Verified in the same probe: with `--input-format stream-json` an argv prompt produces *nothing at all* — no `init`, no turn, exit 0 — so the two cannot be mixed.
- Claude's stdin stays open (`answersProtocol: true`), and the Run therefore ends on Claude's own `result` frame rather than on the process exiting, exactly as Codex's already does. Without that the process outlives its work, waiting for a message nobody is going to send.
- `--replay-user-messages` is passed so a correction can be acknowledged rather than assumed.

Both flags are present in the 2.1.0 tarball (`npm pack @anthropic-ai/claude-code@2.1.0`, `grep` of `cli.js`), so the launch shape is available across the whole supported band. Mid-turn admission itself is only *measured* at 2.1.226, which is what `steering.minimumVersion` says.

## A defect the probe caught on the way past

Claude reports a file **creation** as `tool_use_result: {"type":"create","filePath":...,"content":"STEERED\n","structuredPatch":[],"originalFile":null}` — an empty patch, with the whole new file under `content`. The existing Adapter required at least one hunk and reported `Unsupported Claude file-change payload`, a protocol failure, for every file a Run created; the recorded fixture only ever covered edits, so nothing had caught it. A creation is now read as what it is and becomes an all-added diff with `changeKind: 'added'`.

## Limits of this result

- One machine, one binary, one model (`claude-opus-5[1m]`), two turns. The mechanism is protocol-level and unlikely to be model-specific, but nothing here has watched a second version do it.
- Not measured: a correction written *between* the `result` frame and process exit (the Adapter refuses that window by construction), several corrections in one turn, a correction during a subagent's work, or a correction while an Approval Request is outstanding.
- The probe runs in `bypassPermissions` with no setting sources. A real Run carries the person's user settings, the app's staged settings, and an MCP approval bridge; none of them touch stdin, but none of them were in the measurement either.

## Reproducing

```
pnpm claude:probe-steer     # two real turns, one scratch repo each, ~$0.20
```

Read the verdict lines it prints, and the recorded stream it writes to `app/src/core/harness/fixtures/claude-steer-probe.jsonl`. `app/src/core/harness/claude.test.ts` replays that same fixture, so a change in what the binary does shows up as a failing test rather than as a Run that quietly stops taking corrections.
