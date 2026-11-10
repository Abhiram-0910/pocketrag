import { useEffect, useRef, useState, type FormEvent } from 'react'
import { CaretLeft, CaretRight } from '@phosphor-icons/react'
import type { TurnRecord } from '../lib/historyDb'
import { Button } from './ui/Button'

interface TurnControlsProps {
  turn: TurnRecord
  // Where this turn sits among the versions of its question (siblingPosition).
  index: number
  count: number
  // False while a request is in flight or no query can run (no ready document, no key).
  canAsk: boolean
  // False only while a request is in flight: viewing another version needs no document.
  canNavigate: boolean
  onEdit: (question: string) => void
  // Only for answered turns: a failed one gets "Try again" (same turn), never this.
  onRegenerate?: () => void
  onPrevious: () => void
  onNext: () => void
}

const NAV_BUTTON =
  'inline-flex size-11 cursor-pointer items-center justify-center rounded text-slate-700 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 aria-disabled:cursor-not-allowed aria-disabled:text-slate-400 dark:text-slate-300 dark:hover:bg-slate-800 dark:focus-visible:outline-blue-400 dark:aria-disabled:text-slate-500'

/**
 * A turn's question with Edit / Regenerate and, when the question has more than one
 * version, a "‹ 2/3 ›" navigator (v1.2 branching). Navigator buttons use aria-disabled,
 * not disabled, so focus stays on them at either end.
 */
export function TurnControls({ turn, index, count, canAsk, canNavigate, onEdit, onRegenerate, onPrevious, onNext }: TurnControlsProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const editButtonRef = useRef<HTMLButtonElement>(null)
  const editing = draft !== null

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  const cancel = () => {
    setDraft(null)
    // The form unmounts; put focus back on the button that opened it.
    requestAnimationFrame(() => editButtonRef.current?.focus())
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const question = draft?.trim()
    if (!question || !canAsk) return
    setDraft(null)
    onEdit(question)
  }
  const atStart = index <= 0
  const atEnd = index >= count - 1

  return (
    <div className="space-y-1" data-turn-controls={turn.id}>
      {editing ? (
        <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                cancel()
              }
            }}
            aria-label="Edit question"
            className="min-h-11 min-w-0 flex-1 rounded border border-slate-300 px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          />
          <div className="flex gap-2">
            <Button type="submit" disabled={!canAsk || !draft.trim()}>
              Send edited question
            </Button>
            <Button variant="secondary" onClick={cancel}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <p className="break-words text-xs font-medium text-slate-600 dark:text-slate-400">{turn.question}</p>
      )}
      <div className="flex flex-wrap items-center gap-1">
        {count > 1 && (
          <div role="group" aria-label="Versions of this question" className="inline-flex items-center">
            <button
              type="button"
              className={NAV_BUTTON}
              aria-label="Previous version"
              aria-disabled={atStart || !canNavigate ? true : undefined}
              onClick={() => !atStart && canNavigate && onPrevious()}
            >
              <CaretLeft className="size-4" weight="bold" aria-hidden="true" />
            </button>
            <span className="min-w-10 text-center text-xs tabular-nums text-slate-700 dark:text-slate-300">
              {index + 1}/{count}
            </span>
            <button
              type="button"
              className={NAV_BUTTON}
              aria-label="Next version"
              aria-disabled={atEnd || !canNavigate ? true : undefined}
              onClick={() => !atEnd && canNavigate && onNext()}
            >
              <CaretRight className="size-4" weight="bold" aria-hidden="true" />
            </button>
          </div>
        )}
        {!editing && (
          <Button ref={editButtonRef} variant="secondary" disabled={!canAsk} onClick={() => setDraft(turn.question)}>
            Edit question
          </Button>
        )}
        {!editing && onRegenerate && (
          <Button variant="secondary" disabled={!canAsk} onClick={onRegenerate}>
            Regenerate answer
          </Button>
        )}
      </div>
    </div>
  )
}
