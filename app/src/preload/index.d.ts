import type { IdeaShellApi } from '@shared/contract'

declare global {
  interface Window {
    ideaShell: IdeaShellApi
  }
}

export {}
