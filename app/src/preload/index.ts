import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '@shared/channels'
import type { ConversationStreamEvent, ShellApi, ThemeState } from '@shared/contract'

/**
 * The complete privileged surface available to the sandboxed Renderer.
 * Fixed product functions only: no ipcRenderer, no Electron objects, no
 * arbitrary channels, no filesystem or shell access.
 */
const api: ShellApi = {
  getBootState: () => ipcRenderer.invoke(IPC_CHANNELS.bootState),
  chooseLibraryLocation: () => ipcRenderer.invoke(IPC_CHANNELS.chooseLibraryLocation),
  openLibrary: (path) => ipcRenderer.invoke(IPC_CHANNELS.openLibrary, path),
  captureSession: (input) => ipcRenderer.invoke(IPC_CHANNELS.captureSession, input),
  openSession: (relativePath) => ipcRenderer.invoke(IPC_CHANNELS.openSession, relativePath),
  listSessions: () => ipcRenderer.invoke(IPC_CHANNELS.listSessions),
  queryMailbox: (query) => ipcRenderer.invoke(IPC_CHANNELS.queryMailbox, query),
  setSessionPinned: (input) => ipcRenderer.invoke(IPC_CHANNELS.setSessionPinned, input),
  setSessionArchived: (input) => ipcRenderer.invoke(IPC_CHANNELS.setSessionArchived, input),
  previewDeleteSession: (relativePath) =>
    ipcRenderer.invoke(IPC_CHANNELS.previewDeleteSession, relativePath),
  deleteSessionPermanently: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteSessionPermanently, input),
  setThemePreference: (preference) =>
    ipcRenderer.invoke(IPC_CHANNELS.setThemePreference, preference),
  getReadiness: () => ipcRenderer.invoke(IPC_CHANNELS.getReadiness),
  refreshReadiness: (harness) => ipcRenderer.invoke(IPC_CHANNELS.refreshReadiness, { harness }),
  chooseHarnessExecutable: (harness) =>
    ipcRenderer.invoke(IPC_CHANNELS.chooseHarnessExecutable, harness),
  clearHarnessExecutable: (harness) =>
    ipcRenderer.invoke(IPC_CHANNELS.clearHarnessExecutable, harness),
  setLoginShellDiscovery: (consent) =>
    ipcRenderer.invoke(IPC_CHANNELS.setLoginShellDiscovery, consent),
  openExternalLink: (url) => ipcRenderer.invoke(IPC_CHANNELS.openExternalLink, url),
  startRun: (input) => ipcRenderer.invoke(IPC_CHANNELS.startRun, input),
  listRuns: (relativePath) => ipcRenderer.invoke(IPC_CHANNELS.listRuns, relativePath),
  stopRun: (input) => ipcRenderer.invoke(IPC_CHANNELS.stopRun, input),
  getConversation: (relativePath) => ipcRenderer.invoke(IPC_CHANNELS.getConversation, relativePath),
  developSession: (input) => ipcRenderer.invoke(IPC_CHANNELS.developSession, input),
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

contextBridge.exposeInMainWorld('shell', api)
