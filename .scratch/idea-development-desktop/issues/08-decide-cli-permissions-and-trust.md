# Decide CLI permissions and trust boundaries

Type: grilling
Status: open
Blocked by: 03, 04

## Question

What may a Run read, write, execute, or request outside its Idea directory, how are CLI permission prompts surfaced, and what audit and approval experience keeps local harness use understandable and safe?

## Comments

Agreed constraints:

- Run in an explicit Working Directory. Agent writes are restricted to managed planning files; project source and outside-directory writes are blocked.
- Hard-block every Git mutation. Only the app's explicit confirmed `git init` action may mutate Git.
- Hard-deny known secret paths and redact sensitive values before persistence or display. Unsafe-to-sanitize payloads are omitted.
- Tool network access requires Allow once, allow exact scope for this Run, or Deny. Provider API traffic is inherent to starting the Run.
- Claude Auto and Codex YOLO/never-ask may suppress routine prompts only inside the same hard planning sandbox. These modes and remembered approvals reset every Run and remain visibly badged.
- The Matt Pocock installer is the only permitted package-install command and always requires separate confirmation.
- Planning source protections, Git prohibitions, secret denials, and outside-write denials are non-overridable.
