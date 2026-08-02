/**
 * Fixed IPC channel names. Kept dependency-free so the sandboxed Preload can
 * import them without pulling validation libraries into its bundle.
 */
export const IPC_CHANNELS = {
  bootState: 'shell:boot-state',
  chooseProject: 'project:choose',
  listProjects: 'project:list',
  removeProject: 'project:remove',
  initializeProject: 'project:init',
  confirmProject: 'project:confirm',
  startSession: 'session:start',
  listSessions: 'session:list',
  listDamagedSessions: 'session:list-damaged',
  queryMailbox: 'mailbox:query',
  setSessionPinned: 'session:set-pinned',
  setSessionArchived: 'session:set-archived',
  deleteSession: 'session:delete',
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
