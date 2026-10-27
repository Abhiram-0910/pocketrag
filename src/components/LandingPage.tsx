import { DownloadSimple, Info, Key, LockSimple, NotePencil } from '@phosphor-icons/react'
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
            PocketRAG reads, indexes and searches your PDFs in your browser; the files stay on your device, except
            scanned pages you choose to OCR. To answer a question it sends your question, up to 3 matching passages,
            your last few questions and answers, and, only if you turn on diagram images (off by default, free tier
            only), a page image when a question is about a chart or diagram, through PocketRAG's server to the AI
            provider: Google Gemini by default, or the provider you pick with your own key. Every answer comes with a receipt of exactly what was sent.
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
            OpenRouter available as experimental options. Your key goes through PocketRAG's server to your
            provider with each request and isn't saved there or in your browser.
          </p>
        </div>
        <div className="flex items-start gap-3">
          <NotePencil className="mt-0.5 size-5 shrink-0 text-slate-500 dark:text-slate-400" weight="bold" aria-hidden="true" />
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Handwritten and scanned notes are supported too, with per-file consent before the whole file is sent,
            through PocketRAG's server, to Google Gemini for text extraction.
          </p>
        </div>
        <div className="flex items-start gap-3">
          <Info className="mt-0.5 size-5 shrink-0 text-slate-500 dark:text-slate-400" weight="bold" aria-hidden="true" />
          <p className="text-sm text-slate-600 dark:text-slate-400">
            On the free shared tier, Google uses what's sent and the answers to provide, improve and develop its
            products and machine-learning technologies, and human reviewers may read them. Use your own paid key to
            avoid that. The free shared tier isn't available in the EEA, Switzerland or the UK (Google's terms);
            bring your own key there.
          </p>
        </div>
        <div className="flex items-start gap-3">
          <DownloadSimple className="mt-0.5 size-5 shrink-0 text-slate-500 dark:text-slate-400" weight="bold" aria-hidden="true" />
          <p className="text-sm text-slate-600 dark:text-slate-400">
            The first time you use it, your browser downloads the AI models from Hugging Face and the AI runtime from
            jsDelivr. They see your IP address, never your documents.
          </p>
        </div>
      </div>

      <Button variant="primary" onClick={onGetStarted} className="mt-8">
        Get started
      </Button>
    </div>
  )
}
