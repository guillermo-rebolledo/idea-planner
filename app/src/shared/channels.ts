/**
 * Fixed IPC channel names. Kept dependency-free so the sandboxed Preload can
 * import them without pulling validation libraries into its bundle.
 */
export const IPC_CHANNELS = {
  bootState: 'shell:boot-state',
  chooseLibraryLocation: 'library:choose-location',
  openLibrary: 'library:open',
  captureIdea: 'idea:capture',
  listIdeas: 'idea:list',
  setThemePreference: 'theme:set-preference',
  themeChanged: 'theme:changed'
} as const
