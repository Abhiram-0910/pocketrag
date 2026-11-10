import { Stop } from '@phosphor-icons/react'
import { Button } from './ui/Button'

export type AnswerStage = 'searching' | 'asking' | 'writing'

interface AnswerProgressProps {
  stage: AnswerStage
  provider: string
  // False for providers the Worker can't stream yet (Grok, OpenRouter) and web search.
  streams: boolean
  // Shown only while it's not available to stream.
  nonStreamingNote: boolean
  text: string
  imageIncluded: boolean
  onStop?: () => void
}

const STEPS: { stage: AnswerStage; label: (provider: string) => string }[] = [
  { stage: 'searching', label: () => 'Searching your documents' },
  { stage: 'asking', label: (provider) => `Asking ${provider}` },
  { stage: 'writing', label: () => 'Writing' },
]

/**
 * v1.3 loading experience for this session's live question: the stage ("Searching your
 * documents → Asking Gemini → Writing", the current step marked aria-current), a skeleton
 * until text arrives, the streamed text itself, and Stop. Nothing here is a live region —
 * QueryPanel announces only the start and the end. Pulses honour reduced motion
 * (motion-safe only).
 */
export function AnswerProgress({ stage, provider, streams, nonStreamingNote, text, imageIncluded, onStop }: AnswerProgressProps) {
  const current = STEPS.findIndex((s) => s.stage === stage)
  const steps = streams ? STEPS : STEPS.slice(0, 2)
  return (
    <div className="mt-4 space-y-3" data-answer-progress={stage}>
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" aria-label="Progress">
        {steps.map((step, i) => (
          <li
            key={step.stage}
            aria-current={i === current ? 'step' : undefined}
            className={
              i === current
                ? 'font-medium text-slate-900 dark:text-slate-100'
                : i < current
                  ? 'text-slate-600 dark:text-slate-400'
                  : 'text-slate-500 dark:text-slate-400'
            }
          >
            {i > 0 && (
              <span aria-hidden="true" className="mr-2 text-slate-400 dark:text-slate-500">
                →
              </span>
            )}
            {step.label(provider)}
          </li>
        ))}
      </ol>
      {nonStreamingNote && stage !== 'searching' && (
        <p className="text-xs text-slate-600 dark:text-slate-400">
          Streaming isn't available for this provider yet; your answer will appear when it is complete.
        </p>
      )}
      {imageIncluded && stage === 'asking' && (
        <p className="text-xs text-slate-600 dark:text-slate-400">A page image was included, which can take a bit longer.</p>
      )}
      <div className="rounded border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
        {text ? (
          <p className="whitespace-pre-wrap break-words text-sm text-slate-900 dark:text-slate-100" data-streamed-answer>
            {text}
          </p>
        ) : (
          // Skeleton: three bars, static under reduced motion.
          <div aria-hidden="true" className="space-y-2">
            <div className="h-3 w-11/12 rounded bg-slate-200 motion-safe:animate-pulse dark:bg-slate-700" />
            <div className="h-3 w-4/5 rounded bg-slate-200 motion-safe:animate-pulse dark:bg-slate-700" />
            <div className="h-3 w-2/3 rounded bg-slate-200 motion-safe:animate-pulse dark:bg-slate-700" />
          </div>
        )}
        {onStop && stage !== 'searching' && (
          <Button variant="secondary" className="mt-3" onClick={onStop}>
            <Stop className="size-4" weight="bold" aria-hidden="true" />
            Stop
          </Button>
        )}
      </div>
    </div>
  )
}
