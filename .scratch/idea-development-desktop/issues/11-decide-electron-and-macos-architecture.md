# Decide the Electron and macOS architecture

Type: grilling
Status: open
Blocked by: 04, 06, 08

## Question

What Electron main/renderer/IPC boundaries, Run supervision model, file-watching and snapshot design, rebuildable SQLite index, macOS signing/notarization, and GitHub Releases update architecture implement the product decisions without weakening the local-first security model?

## Comments

Standing choices: TypeScript end-to-end, sandboxed React renderer with no direct Node/filesystem/shell access, macOS-first MVP, later Linux/Windows expansion, single app instance/window, notarized direct distribution, stable-channel automatic updates from GitHub Releases, and explicit restart only when Runs are idle.
