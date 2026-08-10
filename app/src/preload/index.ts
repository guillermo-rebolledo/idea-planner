import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC_CHANNELS } from '@shared/channels'
import type {
  ConversationStreamEvent,
  ProjectCloneEvent,
  ShellApi,
  ThemeState,
  UpdateAvailability
} from '@shared/contract'

/**
 * The complete privileged surface available to the sandboxed Renderer.
 * Fixed product functions only: no ipcRenderer, no Electron objects, no
 * arbitrary channels, no filesystem or shell access.
 */
const api: ShellApi = {
  getBootState: () => ipcRenderer.invoke(IPC_CHANNELS.bootState),
  chooseProject: () => ipcRenderer.invoke(IPC_CHANNELS.chooseProject),
  listGitHubRepositories: () => ipcRenderer.invoke(IPC_CHANNELS.listGitHubRepositories),
  listProjectCloneLocations: (suggestedName) =>
    ipcRenderer.invoke(IPC_CHANNELS.listProjectCloneLocations, suggestedName),
  chooseProjectCloneLocation: (suggestedName) =>
    ipcRenderer.invoke(IPC_CHANNELS.chooseProjectCloneLocation, suggestedName),
  startProjectClone: (input) => ipcRenderer.invoke(IPC_CHANNELS.startProjectClone, input),
  beginProjectClone: (operationId) =>
    ipcRenderer.invoke(IPC_CHANNELS.beginProjectClone, operationId),
  cancelProjectClone: (operationId) =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelProjectClone, operationId),
  onProjectCloneEvent: (listener) => {
    const subscription = (_event: unknown, cloneEvent: ProjectCloneEvent): void =>
      listener(cloneEvent)
    ipcRenderer.on(IPC_CHANNELS.projectCloneEvent, subscription)
    return () => ipcRenderer.off(IPC_CHANNELS.projectCloneEvent, subscription)
  },
  offerProject: (path) => ipcRenderer.invoke(IPC_CHANNELS.offerProject, path),
  pathForFile: (file) => webUtils.getPathForFile(file),
  listProjects: () => ipcRenderer.invoke(IPC_CHANNELS.listProjects),
  removeProject: (root) => ipcRenderer.invoke(IPC_CHANNELS.removeProject, root),
  listSkills: (input) => ipcRenderer.invoke(IPC_CHANNELS.listSkills, input),
  listModels: () => ipcRenderer.invoke(IPC_CHANNELS.listModels),
  trustProjectSkills: (input) => ipcRenderer.invoke(IPC_CHANNELS.trustProjectSkills, input),
  listStandingApprovals: (projectRoot) =>
    ipcRenderer.invoke(IPC_CHANNELS.listStandingApprovals, projectRoot),
  revokeStandingApproval: (input) => ipcRenderer.invoke(IPC_CHANNELS.revokeStandingApproval, input),
  initializeProject: (path) => ipcRenderer.invoke(IPC_CHANNELS.initializeProject, path),
  confirmProject: (root) => ipcRenderer.invoke(IPC_CHANNELS.confirmProject, root),
  startSession: (input) => ipcRenderer.invoke(IPC_CHANNELS.startSession, input),
  resumeWorktreeBootstrap: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.resumeWorktreeBootstrap, input),
  listSessions: () => ipcRenderer.invoke(IPC_CHANNELS.listSessions),
  listDamagedSessions: () => ipcRenderer.invoke(IPC_CHANNELS.listDamagedSessions),
  queryMailbox: (query) => ipcRenderer.invoke(IPC_CHANNELS.queryMailbox, query),
  setSessionPinned: (input) => ipcRenderer.invoke(IPC_CHANNELS.setSessionPinned, input),
  setSessionArchived: (input) => ipcRenderer.invoke(IPC_CHANNELS.setSessionArchived, input),
  renameSession: (input) => ipcRenderer.invoke(IPC_CHANNELS.renameSession, input),
  deleteSession: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.deleteSession, sessionId),
  getAppearanceSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getAppearanceSettings),
  setAppearanceSettings: (settings) =>
    ipcRenderer.invoke(IPC_CHANNELS.setAppearanceSettings, settings),
  getQuitWarningPreference: () => ipcRenderer.invoke(IPC_CHANNELS.getQuitWarningPreference),
  setQuitWarningPreference: (enabled) =>
    ipcRenderer.invoke(IPC_CHANNELS.setQuitWarningPreference, enabled),
  respondToQuitRequest: (response) =>
    ipcRenderer.invoke(IPC_CHANNELS.respondToQuitRequest, response),
  getReadiness: () => ipcRenderer.invoke(IPC_CHANNELS.getReadiness),
  refreshReadiness: (harness) => ipcRenderer.invoke(IPC_CHANNELS.refreshReadiness, { harness }),
  chooseHarnessExecutable: (harness) =>
    ipcRenderer.invoke(IPC_CHANNELS.chooseHarnessExecutable, harness),
  clearHarnessExecutable: (harness) =>
    ipcRenderer.invoke(IPC_CHANNELS.clearHarnessExecutable, harness),
  setLoginShellDiscovery: (consent) =>
    ipcRenderer.invoke(IPC_CHANNELS.setLoginShellDiscovery, consent),
  openExternalLink: (url) => ipcRenderer.invoke(IPC_CHANNELS.openExternalLink, url),
  getUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.getUpdate),
  openUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.openUpdate),
  preparePullRequest: (input) => ipcRenderer.invoke(IPC_CHANNELS.preparePullRequest, input),
  createPullRequest: (input) => ipcRenderer.invoke(IPC_CHANNELS.createPullRequest, input),
  openPullRequest: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.openPullRequest, sessionId),
  startRun: (input) => ipcRenderer.invoke(IPC_CHANNELS.startRun, input),
  listRuns: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.listRuns, sessionId),
  stopRun: (input) => ipcRenderer.invoke(IPC_CHANNELS.stopRun, input),
  getCheckoutFacts: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.getCheckoutFacts, sessionId),
  listBranches: (projectRoot) => ipcRenderer.invoke(IPC_CHANNELS.listBranches, projectRoot),
  listEditors: () => ipcRenderer.invoke(IPC_CHANNELS.listEditors),
  openInEditor: (input) => ipcRenderer.invoke(IPC_CHANNELS.openInEditor, input),
  getConversation: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.getConversation, sessionId),
  developSession: (input) => ipcRenderer.invoke(IPC_CHANNELS.developSession, input),
  compactSession: (input) => ipcRenderer.invoke(IPC_CHANNELS.compactSession, input),
  rewindSession: (input) => ipcRenderer.invoke(IPC_CHANNELS.rewindSession, input),
  enqueueQueuedSubmission: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.enqueueQueuedSubmission, input),
  editQueuedSubmission: (input) => ipcRenderer.invoke(IPC_CHANNELS.editQueuedSubmission, input),
  moveQueuedSubmission: (input) => ipcRenderer.invoke(IPC_CHANNELS.moveQueuedSubmission, input),
  cancelQueuedSubmission: (input) => ipcRenderer.invoke(IPC_CHANNELS.cancelQueuedSubmission, input),
  pauseConversationQueue: (sessionId) =>
    ipcRenderer.invoke(IPC_CHANNELS.pauseConversationQueue, sessionId),
  resumeConversationQueue: (sessionId) =>
    ipcRenderer.invoke(IPC_CHANNELS.resumeConversationQueue, sessionId),
  sendQueuedSubmissionNow: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.sendQueuedSubmissionNow, input),
  resolveApproval: (input) => ipcRenderer.invoke(IPC_CHANNELS.resolveApproval, input),
  prepareRunUndo: (input) => ipcRenderer.invoke(IPC_CHANNELS.prepareRunUndo, input),
  applyRunUndo: (input) => ipcRenderer.invoke(IPC_CHANNELS.applyRunUndo, input),
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
  },
  onQuitRequested: (listener) => {
    const subscription = (_event: unknown, activeRunCount: number): void => {
      if (Number.isInteger(activeRunCount) && activeRunCount > 0) listener(activeRunCount)
    }
    ipcRenderer.on(IPC_CHANNELS.quitRequested, subscription)
    return () => ipcRenderer.off(IPC_CHANNELS.quitRequested, subscription)
  },
  onUndoShortcut: (listener) => {
    const subscription = (): void => listener()
    ipcRenderer.on(IPC_CHANNELS.undoShortcut, subscription)
    return () => ipcRenderer.off(IPC_CHANNELS.undoShortcut, subscription)
  },
  onToggleSidebarShortcut: (listener) => {
    const subscription = (): void => listener()
    ipcRenderer.on(IPC_CHANNELS.toggleSidebarShortcut, subscription)
    return () => ipcRenderer.off(IPC_CHANNELS.toggleSidebarShortcut, subscription)
  },
  onUpdateAvailable: (listener) => {
    const subscription = (_event: unknown, availability: UpdateAvailability): void =>
      listener(availability)
    ipcRenderer.on(IPC_CHANNELS.updateAvailable, subscription)
    return () => ipcRenderer.off(IPC_CHANNELS.updateAvailable, subscription)
  },
  onOpenSessionRequest: (listener) => {
    const subscription = (_event: unknown, sessionId: string): void => {
      if (typeof sessionId === 'string' && sessionId) listener(sessionId)
    }
    ipcRenderer.on(IPC_CHANNELS.openSessionRequest, subscription)
    return () => ipcRenderer.off(IPC_CHANNELS.openSessionRequest, subscription)
  }
}

contextBridge.exposeInMainWorld('shell', api)
