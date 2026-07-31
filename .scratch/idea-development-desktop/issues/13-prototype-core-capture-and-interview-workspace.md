# Prototype the core capture and interview workspace

Type: prototype
Status: resolved
Blocked by: 01

## Question

Which concrete desktop interaction best validates Idea capture, the pinned-first inbox and operational states, the central Grill Me or Wayfinder Conversation, editable Suggested Responses, collapsed activity, harness/model/effort controls, and the right-side Markdown reader/diff experience during Captured and Developing?

## Answer

Use the validated **Focus Mailbox** direction: a Linear-inspired, conversation-first Focus Deck in the center; a full Mailbox-style Idea inbox on the left that is expanded by default and collapses to a compact rail; and an independently collapsible Artifact drawer on the right. The center remains visually dominant whether either sidebar is open or closed.

Build the production UI on source-owned shadcn/ui components with React 19, TypeScript, Tailwind CSS v4, and the Radix-backed component flavor for the simplest compatibility with Nexus UI. Treat Linear as a quality reference—compact information density, calm neutral surfaces, hairline separators, restrained elevation, clear active states, and keyboard-first interaction—not as a visual clone.

Preferred component boundaries:

- **shadcn/ui:** application shell, Sidebar, Collapsible, Resizable panels, ScrollArea, Button, Badge, Tooltip, Dropdown Menu, Select, Toggle Group, Tabs, Sheet, Dialog, command palette, forms, loading, and feedback.
- **Nexus UI registry:** Thread, Message, Prompt Input, Questions or Suggestions, Reasoning, Tool activity, and Model Selector. Adapt their presentation to the product's normalized harness events rather than coupling product state to a provider or UI component.
- **assistant-ui registry:** standalone Diff Viewer for app-snapshot comparisons, with unified view as the compact default and split view available when space permits. It must compare app-owned before/after content and must not depend on Git.

Registry components are copied into the repository and become application source. Add only the components needed for a vertical slice, inspect their source and dependencies, normalize imports and icons to the project configuration, and record upstream registry identity/version for later updates. Do not mix multiple competing components for the same responsibility without a demonstrated accessibility or capability gap.

The prototype answered the layout question but remains throwaway code. It is intentionally not committed or moved to a branch because this effort's explicit Git boundary forbids commits, staging, and branch switching.
