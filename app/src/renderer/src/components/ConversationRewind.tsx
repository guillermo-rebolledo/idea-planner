import { useId, useState } from 'react'
import { History } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Modal } from '@renderer/components/ui/dialog'

/** The one confirmation for changing the readable Conversation, never files. */
export function ConversationRewindDialog({
  message,
  onClose,
  onConfirm
}: {
  message: string
  onClose: () => void
  onConfirm: () => Promise<void>
}): React.JSX.Element {
  const titleId = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const confirm = (): void => {
    setBusy(true)
    setError(null)
    void onConfirm()
      .catch(() => setError('The Conversation could not be rewound. Nothing was changed.'))
      .finally(() => setBusy(false))
  }

  return (
    <Modal labelledBy={titleId} onDismiss={onClose} className="max-w-lg">
      <h2 id={titleId} className="text-sm font-medium">
        Rewind the Conversation?
      </h2>
      <p className="mt-2 text-xs text-muted-foreground">
        This message and everything after it will leave the Conversation you see. The message will
        return to the composer so you can edit and send it again.
      </p>
      <p className="mt-2 text-xs font-medium">Your files are not affected.</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Rewinding the Conversation is separate from undoing a Run. It will not put back, change, or
        remove any file, even when a Run Snapshot exists.
      </p>
      <blockquote className="mt-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        {message}
      </blockquote>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="ghost" data-autofocus onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" variant="default" disabled={busy} onClick={confirm}>
          <History aria-hidden="true" className="size-3" />
          {busy ? 'Rewinding…' : 'Rewind Conversation'}
        </Button>
      </div>
    </Modal>
  )
}
