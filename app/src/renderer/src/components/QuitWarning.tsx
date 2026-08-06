import { useEffect, useState } from 'react'
import type { QuitRequestResponse } from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import { Modal } from '@renderer/components/ui/dialog'

/** The product-owned quit warning; process cleanup itself remains Main's. */
export function QuitWarning(): React.JSX.Element | null {
  const [activeRunCount, setActiveRunCount] = useState<number | null>(null)
  const [answering, setAnswering] = useState(false)

  useEffect(() => window.shell.onQuitRequested(setActiveRunCount), [])

  async function answer(response: QuitRequestResponse): Promise<void> {
    setAnswering(true)
    try {
      await window.shell.respondToQuitRequest(response)
      if (response === 'keep-working') setActiveRunCount(null)
    } finally {
      setAnswering(false)
    }
  }

  if (activeRunCount === null) return null
  const plural = activeRunCount === 1 ? 'agent is' : `${String(activeRunCount)} agents are`
  return (
    <Modal
      labelledBy="quit-warning-title"
      onDismiss={() => void answer('keep-working')}
      className="max-w-md"
    >
      <h2 id="quit-warning-title" className="text-sm font-medium">
        {activeRunCount === 1 ? 'An agent is still working' : 'Agents are still working'}
      </h2>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {plural} running in the background. Quitting now safely stops every active Run and its
        processes before Argos exits.
      </p>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        Always quitting turns this warning off. You can turn it back on in Settings.
      </p>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button
          data-autofocus=""
          variant="secondary"
          size="sm"
          disabled={answering}
          onClick={() => void answer('keep-working')}
        >
          Keep Working
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={answering}
          onClick={() => void answer('always-quit')}
        >
          Always Quit Without Asking
        </Button>
        <Button size="sm" disabled={answering} onClick={() => void answer('quit')}>
          Quit Anyway
        </Button>
      </div>
    </Modal>
  )
}
