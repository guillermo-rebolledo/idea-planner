import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '@shared/channels'
import type { ConversationStreamEvent, IdeaShellApi, ThemeState } from '@shared/contract'

/**
 * The complete privileged surface available to the sandboxed Renderer.
 * Fixed product functions only: no ipcRenderer, no Electron objects, no
 * arbitrary channels, no filesystem or shell access.
 */
const api: IdeaShellApi = {
  getBootState: () => ipcRenderer.invoke(IPC_CHANNELS.bootState),
  chooseLibraryLocation: () => ipcRenderer.invoke(IPC_CHANNELS.chooseLibraryLocation),
  openLibrary: (path) => ipcRenderer.invoke(IPC_CHANNELS.openLibrary, path),
  captureIdea: (input) => ipcRenderer.invoke(IPC_CHANNELS.captureIdea, input),
  openIdea: (relativePath) => ipcRenderer.invoke(IPC_CHANNELS.openIdea, relativePath),
  listIdeas: () => ipcRenderer.invoke(IPC_CHANNELS.listIdeas),
  queryMailbox: (query) => ipcRenderer.invoke(IPC_CHANNELS.queryMailbox, query),
  setIdeaPinned: (input) => ipcRenderer.invoke(IPC_CHANNELS.setIdeaPinned, input),
  setIdeaArchived: (input) => ipcRenderer.invoke(IPC_CHANNELS.setIdeaArchived, input),
  previewDeleteIdea: (relativePath) =>
    ipcRenderer.invoke(IPC_CHANNELS.previewDeleteIdea, relativePath),
  deleteIdeaPermanently: (input) => ipcRenderer.invoke(IPC_CHANNELS.deleteIdeaPermanently, input),
  setThemePreference: (preference) =>
    ipcRenderer.invoke(IPC_CHANNELS.setThemePreference, preference),
  getReadiness: () => ipcRenderer.invoke(IPC_CHANNELS.getReadiness),
  refreshReadiness: (provider) => ipcRenderer.invoke(IPC_CHANNELS.refreshReadiness, { provider }),
  chooseProviderExecutable: (provider) =>
    ipcRenderer.invoke(IPC_CHANNELS.chooseProviderExecutable, provider),
  clearProviderExecutable: (provider) =>
    ipcRenderer.invoke(IPC_CHANNELS.clearProviderExecutable, provider),
  setLoginShellDiscovery: (consent) =>
    ipcRenderer.invoke(IPC_CHANNELS.setLoginShellDiscovery, consent),
  openExternalLink: (url) => ipcRenderer.invoke(IPC_CHANNELS.openExternalLink, url),
  startRun: (input) => ipcRenderer.invoke(IPC_CHANNELS.startRun, input),
  listRuns: (relativePath) => ipcRenderer.invoke(IPC_CHANNELS.listRuns, relativePath),
  stopRun: (input) => ipcRenderer.invoke(IPC_CHANNELS.stopRun, input),
  getConversation: (relativePath) => ipcRenderer.invoke(IPC_CHANNELS.getConversation, relativePath),
  developIdea: (input) => ipcRenderer.invoke(IPC_CHANNELS.developIdea, input),
  onConversationEvent: (listener) => {
    const subscription = (_event: unknown, streamed: ConversationStreamEvent): void =>
      listener(streamed)
    ipcRenderer.on(IPC_CHANNELS.conversationEvent, subscription)
    return () => ipcRenderer.off(IPC_CHANNELS.conversationEvent, subscription)
  },
  onThemeChanged: (listener) => {
    const subscription = (_event: unknown, theme: ThemeState): void => listener(theme)
    ipcRenderer.on(IPC_CHANNELS.themeChanged, subscription)
    return () => ipcRenderer.off(IPC_CHANNELS.themeChanged, subscription)
  }
}

contextBridge.exposeInMainWorld('ideaShell', api)
