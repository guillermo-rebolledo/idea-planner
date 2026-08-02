/**
 * Fixed IPC channel names. Kept dependency-free so the sandboxed Preload can
 * import them without pulling validation libraries into its bundle.
 */
export const IPC_CHANNELS = {
  bootState: 'shell:boot-state',
  chooseLibraryLocation: 'library:choose-location',
  openLibrary: 'library:open',
  captureSession: 'session:capture',
  openSession: 'session:open',
  listSessions: 'session:list',
  queryMailbox: 'mailbox:query',
  setSessionPinned: 'session:set-pinned',
  setSessionArchived: 'session:set-archived',
  previewDeleteSession: 'session:delete-preview',
  deleteSessionPermanently: 'session:delete-permanently',
  setThemePreference: 'theme:set-preference',
  themeChanged: 'theme:changed',
  getReadiness: 'readiness:get',
  refreshReadiness: 'readiness:refresh',
  chooseHarnessExecutable: 'readiness:choose-executable',
  clearHarnessExecutable: 'readiness:clear-executable',
  setLoginShellDiscovery: 'readiness:set-login-shell-discovery',
  openExternalLink: 'shell:open-external-link',
  startRun: 'run:start',
  listRuns: 'run:list',
  stopRun: 'run:stop',
  getConversation: 'conversation:get',
  developSession: 'conversation:develop',
  conversationEvent: 'conversation:event'
} as const
