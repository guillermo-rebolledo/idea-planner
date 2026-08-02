import type { ShellApi } from '@shared/contract'

declare global {
  interface Window {
    shell: ShellApi
  }
}

export {}
