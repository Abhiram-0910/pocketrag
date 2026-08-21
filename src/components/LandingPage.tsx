import { Key, LockSimple, NotePencil } from '@phosphor-icons/react'
import { Button } from './ui/Button'

interface LandingPageProps {
  onGetStarted: () => void
}

/**
 * Milestone 14. Composed entirely from existing primitives (Button, Phosphor icons
 * already a dependency, the same slate/blue Tailwind token vocabulary every other
 * component uses) — no new dependency, no new design-system component. Shown once per
 * browser, gated by landingVisitSetting.ts's localStorage flag (see App.tsx).
 */
export function LandingPage({ onGetStarted }: LandingPageProps) {
  return (
    <div className="text-left">
      <div className="flex items-start gap-3">
        <LockSimple className="mt-1 size-8 shrink-0 text-blue-600 dark:text-blue-400" weight="bold" aria-hidden="true" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            Chat with your documents — without uploading them.
          </h1>
          <p className="mt-2 text-slate-600 dark:text-slate-400">
            PocketRAG parses, embeds, and searches your PDFs and notes entirely in your browser. Only the small
            passages needed to answer a specific question are ever sent out — and only to the AI provider you
            choose.
          </p>
        </div>
      </div>

      <ol className="mt-8 list-decimal space-y-2 pl-5 text-sm text-slate-700 dark:text-slate-300">
        <li>Drop in a PDF, or a photo of handwritten notes.</li>
        <li>Ask a question, in plain English.</li>
        <li>Get a grounded answer, with citations back to the source.</li>
      </ol>

      <div className="mt-8 space-y-4">
        <div className="flex items-start gap-3">
          <Key className="mt-0.5 size-5 shrink-0 text-slate-500 dark:text-slate-400" weight="bold" aria-hidden="true" />
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Bring your own API key — Gemini and OpenAI are fully supported today, with Anthropic, Grok, and
            OpenRouter available as experimental options. Your key, your cost, never stored on our servers.
          </p>
        </div>
        <div className="flex items-start gap-3">
          <NotePencil className="mt-0.5 size-5 shrink-0 text-slate-500 dark:text-slate-400" weight="bold" aria-hidden="true" />
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Handwritten and scanned notes are supported too, with clear per-file consent before anything is
            uploaded for OCR.
          </p>
        </div>
      </div>

      <Button variant="primary" onClick={onGetStarted} className="mt-8">
        Get started
      </Button>
    </div>
  )
}
