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
  chooseProject: () => ipcRenderer.invoke(IPC_CHANNELS.chooseProject),
  listProjects: () => ipcRenderer.invoke(IPC_CHANNELS.listProjects),
  removeProject: (root) => ipcRenderer.invoke(IPC_CHANNELS.removeProject, root),
  initializeProject: (path) => ipcRenderer.invoke(IPC_CHANNELS.initializeProject, path),
  confirmProject: (root) => ipcRenderer.invoke(IPC_CHANNELS.confirmProject, root),
  startSession: (input) => ipcRenderer.invoke(IPC_CHANNELS.startSession, input),
  listSessions: () => ipcRenderer.invoke(IPC_CHANNELS.listSessions),
  listDamagedSessions: () => ipcRenderer.invoke(IPC_CHANNELS.listDamagedSessions),
  queryMailbox: (query) => ipcRenderer.invoke(IPC_CHANNELS.queryMailbox, query),
  setSessionPinned: (input) => ipcRenderer.invoke(IPC_CHANNELS.setSessionPinned, input),
  setSessionArchived: (input) => ipcRenderer.invoke(IPC_CHANNELS.setSessionArchived, input),
  deleteSession: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.deleteSession, sessionId),
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
  listRuns: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.listRuns, sessionId),
  stopRun: (input) => ipcRenderer.invoke(IPC_CHANNELS.stopRun, input),
  getConversation: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.getConversation, sessionId),
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
