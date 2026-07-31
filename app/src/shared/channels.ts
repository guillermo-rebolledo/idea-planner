/**
 * Fixed IPC channel names. Kept dependency-free so the sandboxed Preload can
 * import them without pulling validation libraries into its bundle.
 */
export const IPC_CHANNELS = {
  bootState: 'shell:boot-state',
  chooseLibraryLocation: 'library:choose-location',
  openLibrary: 'library:open',
  captureIdea: 'idea:capture',
  openIdea: 'idea:open',
  listIdeas: 'idea:list',
  queryMailbox: 'mailbox:query',
  setIdeaPinned: 'idea:set-pinned',
  setIdeaArchived: 'idea:set-archived',
  previewDeleteIdea: 'idea:delete-preview',
  deleteIdeaPermanently: 'idea:delete-permanently',
  setThemePreference: 'theme:set-preference',
  themeChanged: 'theme:changed'
} as const
