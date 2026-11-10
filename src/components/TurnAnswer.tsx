import type { TurnRecord } from '../lib/historyDb'
import { GROUNDED_TEXT, NOT_RETAINED_TEXT, UNGROUNDED_TEXT } from '../lib/answerCopy'
import { StatusBanner } from './ui/StatusBanner'

// "(Doc N, page M)", as the Worker's citation check reads it (worker/src/grounding.ts).
const CITATION = /(Doc\s+\d+[\s,]*page\s+\d+)/i
const CITATION_PARTS = /Doc\s+(\d+)[\s,]*page\s+(\d+)/i

/** The answer text with each citation of a known document as a button (v1.4 click-to-verify). */
function AnswerText({ text, labels, onCite }: { text: string; labels: Set<number>; onCite?: (label: number, page: number) => void }) {
  if (!onCite) return <>{text}</>
  return (
    <>
      {text.split(CITATION).map((part, i) => {
        const m = i % 2 === 1 ? CITATION_PARTS.exec(part) : null
        if (!m || !labels.has(Number(m[1]))) return part
        return (
          <button
            key={i}
            type="button"
            aria-haspopup="dialog"
            aria-label={`${part}: show it on the page`}
            className="cursor-pointer rounded text-blue-700 underline underline-offset-2 hover:text-blue-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:text-blue-400 dark:hover:text-blue-300"
            onClick={() => onCite(Number(m[1]), Number(m[2]))}
          >
            {part}
          </button>
        )
      })}
    </>
  )
}

/** An answered turn's grounding banner, image note and text. `text` null means a
 * web-grounded answer that wasn't retained: there's no answer to vouch for, so the
 * placeholder replaces the grounding banner too. With `onCite`, citations are buttons. */
export function TurnAnswer({ turn, text, onCite }: { turn: TurnRecord; text: string | null; onCite?: (label: number, page: number) => void }) {
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
        <p className="text-sm text-slate-900 dark:text-slate-100">
          <AnswerText text={text} labels={new Set(turn.docLabels.map((d) => d.label))} onCite={onCite} />
        </p>
      ) : (
        <p className="text-sm italic text-slate-600 dark:text-slate-400">{NOT_RETAINED_TEXT}</p>
      )}
    </>
  )
}
