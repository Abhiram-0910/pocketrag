import type { TurnRecord } from '../lib/historyDb'
import { GROUNDED_TEXT, NOT_RETAINED_TEXT, UNGROUNDED_TEXT } from '../lib/answerCopy'
import { StatusBanner } from './ui/StatusBanner'

/** An answered turn's grounding banner, image note and text. `text` null means a
 * web-grounded answer that wasn't retained: there's no answer to vouch for, so the
 * placeholder replaces the grounding banner too. */
export function TurnAnswer({ turn, text }: { turn: TurnRecord; text: string | null }) {
  return (
    <>
      {text !== null && (
        <StatusBanner variant={turn.groundingWarning ? 'warning' : 'success'}>
          {turn.groundingWarning ? UNGROUNDED_TEXT : GROUNDED_TEXT}
        </StatusBanner>
      )}
      {turn.imageIncluded && (
        <p className="text-xs text-slate-500 dark:text-slate-400">🖼️ A page image was included in this request.</p>
      )}
      {text !== null ? (
        <p className="text-sm text-slate-900 dark:text-slate-100">{text}</p>
      ) : (
        <p className="text-sm italic text-slate-600 dark:text-slate-400">{NOT_RETAINED_TEXT}</p>
      )}
    </>
  )
}
