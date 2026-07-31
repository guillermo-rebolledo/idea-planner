import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '@shared/channels'
import type { IdeaShellApi, ThemeState } from '@shared/contract'

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
  reconcileIdea: (input) => ipcRenderer.invoke(IPC_CHANNELS.reconcileIdea, input),
  latestReconciliation: (relativePath) =>
    ipcRenderer.invoke(IPC_CHANNELS.latestReconciliation, relativePath),
  locateIdea: (relativePath) => ipcRenderer.invoke(IPC_CHANNELS.locateIdea, relativePath),
  restoreManagedVersion: (input) => ipcRenderer.invoke(IPC_CHANNELS.restoreManagedVersion, input),
  resolveManagedConflict: (input) => ipcRenderer.invoke(IPC_CHANNELS.resolveManagedConflict, input),
  resolveDuplicateManagedDocument: (relativePath, documentId) =>
    ipcRenderer.invoke(IPC_CHANNELS.resolveDuplicateManagedDocument, { relativePath, documentId }),
  chooseReferenceAttachment: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.chooseReferenceAttachment, input),
  listReferenceAttachments: (relativePath) =>
    ipcRenderer.invoke(IPC_CHANNELS.listReferenceAttachments, relativePath),
  keepReferenceWithIdea: (input) => ipcRenderer.invoke(IPC_CHANNELS.keepReferenceWithIdea, input),
  locateReferenceAttachment: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.locateReferenceAttachment, input),
  continueWithoutReference: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.continueWithoutReference, input),
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
  onThemeChanged: (listener) => {
    const subscription = (_event: unknown, theme: ThemeState): void => listener(theme)
    ipcRenderer.on(IPC_CHANNELS.themeChanged, subscription)
    return () => ipcRenderer.off(IPC_CHANNELS.themeChanged, subscription)
  }
}

contextBridge.exposeInMainWorld('ideaShell', api)
