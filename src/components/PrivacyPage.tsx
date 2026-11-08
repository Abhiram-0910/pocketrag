import { useEffect, useRef, type ReactNode } from 'react'
import { ArrowLeft } from '@phosphor-icons/react'
import { ALLOWED_DESTINATIONS } from '../lib/allowedDestinations'
import { PROVIDERS, PROVIDER_HOSTS, PROVIDER_LABELS } from '../lib/models'
import { ISSUES_URL, LOCAL_STORAGE_KEYS, REGION_RESTRICTED_COUNTRIES } from '../lib/privacyFacts'

// Privacy + terms, an in-app view (#privacy) rather than a static file: the enforced CSP
// allows no inline style, and a static HTML file can't reference Vite's hashed CSS. Every
// list below is imported from the code it describes, or drift-tested (privacyFacts.test.ts).

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' })
const countryNames = REGION_RESTRICTED_COUNTRIES.map((c) => regionNames.of(c) ?? c).sort((a, b) => a.localeCompare(b))

const H2 = 'mt-10 text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50'
const P = 'mt-3 text-sm leading-relaxed text-slate-700 dark:text-slate-300'
const UL = 'mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed text-slate-700 dark:text-slate-300'
const LINK =
  'font-medium text-blue-700 underline underline-offset-2 hover:text-blue-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:text-blue-300 dark:hover:text-blue-100'

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="wrap-anywhere rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.8125rem] text-slate-800 dark:bg-slate-800 dark:text-slate-200">
      {children}
    </code>
  )
}

export function PrivacyPage() {
  const heading = useRef<HTMLHeadingElement>(null)
  // A view change, not a page load: start at the top with focus on the heading.
  useEffect(() => {
    window.scrollTo(0, 0)
    heading.current?.focus()
  }, [])

  return (
    <article className="text-left">
      <a href="#" className={`inline-flex min-h-11 items-center gap-1.5 text-sm ${LINK}`}>
        <ArrowLeft className="size-4" weight="bold" aria-hidden="true" />
        Back to PocketRAG
      </a>
      <h1 ref={heading} tabIndex={-1} className="mt-4 text-2xl font-semibold tracking-tight text-slate-900 focus:outline-none dark:text-slate-50">
        Privacy and terms
      </h1>
      <p className={P}>
        What PocketRAG keeps, what it sends and to whom, and the terms for using it. There are no accounts and no
        cookies.
      </p>

      <nav aria-label="On this page" className="mt-6">
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <li><a className={LINK} href="#privacy-stored">In your browser</a></li>
          <li><a className={LINK} href="#privacy-sent">What leaves your device</a></li>
          <li><a className={LINK} href="#privacy-server">PocketRAG's server</a></li>
          <li><a className={LINK} href="#privacy-delete">Deleting your data</a></li>
          <li><a className={LINK} href="#privacy-terms">Terms</a></li>
          <li><a className={LINK} href="#privacy-contact">Contact</a></li>
        </ul>
      </nav>

      <section aria-labelledby="privacy-stored">
        <h2 id="privacy-stored" className={H2}>Stored in your browser</h2>
        <ul className={UL}>
          <li>
            <strong>Documents.</strong> The text extracted from your files, cut into passages, and each passage's
            search vector (IndexedDB database <Code>pocketrag</Code>). The original file is never stored; it's kept in
            memory for the open tab only.
          </li>
          <li>
            <strong>Chat history.</strong> Your questions, the answers and the passages they cited, in plain text,
            not encrypted (IndexedDB database <Code>pocketrag-history</Code>). Answers that used web search are never
            stored; they're shown for the open tab only.
          </li>
          <li>
            <strong>Settings</strong> (localStorage), exactly these keys:
            <ul className="mt-2 list-[circle] space-y-1 pl-5">
              {LOCAL_STORAGE_KEYS.map(({ key, holds }) => (
                <li key={key}>
                  <Code>{key}</Code>: {holds}
                </li>
              ))}
            </ul>
          </li>
          <li>
            <strong>AI models and runtime.</strong> The search and ranking models, cached in your browser's Cache
            Storage (<Code>transformers-cache</Code>) so they download once, plus the AI runtime in the browser's
            normal download cache.
          </li>
          <li>
            <strong>Not stored:</strong> your API key. It's kept in memory and is gone when you reload. There are
            no accounts, no sign-in and no cookies.
          </li>
        </ul>
      </section>

      <section aria-labelledby="privacy-sent">
        <h2 id="privacy-sent" className={H2}>What leaves your device</h2>
        <p className={P}>
          Every request that carries anything of yours is listed in that answer's <strong>Receipt</strong>, with the
          destination, what it carried and its size. In short:
        </p>
        <ul className={UL}>
          <li>
            <strong>Answering a question, free shared tier.</strong> Your question, up to 3 matching passages, your last
            3 questions and answers, and random document IDs (never file names) go to PocketRAG's server, which sends
            them to Google Gemini. If you turn on diagram images (off by default, shared tier only), one page image is
            added when a question is about a chart or diagram.
          </li>
          <li>
            <strong>Answering with your own key.</strong> The same content plus your API key goes to PocketRAG's server,
            which forwards it to the provider you chose. The server uses the key for that one request and doesn't save
            it. Finding a model for your key sends only the key, the same way.
          </li>
          <li>
            <strong>Handwritten or scanned notes (OCR).</strong> After you confirm for each file, the whole file goes
            through PocketRAG's server to Google Gemini on the free shared tier, to extract its text.
          </li>
          <li>
            <strong>First-time downloads.</strong> The AI models come from Hugging Face and the AI runtime from jsDelivr.
            Those services see your IP address and browser user agent, as any download does. Nothing from your documents
            is sent to them.
          </li>
        </ul>
        <p className={P}>Where your own key's requests go, by provider:</p>
        <ul className={UL}>
          {PROVIDERS.map((p) => (
            <li key={p}>
              {PROVIDER_LABELS[p]}: <Code>{PROVIDER_HOSTS[p]}</Code>
            </li>
          ))}
        </ul>
        <p className={P}>
          The browser itself is only allowed to send data to these destinations (enforced by the page's
          Content-Security-Policy):
        </p>
        <ul className={UL}>
          {ALLOWED_DESTINATIONS.map((d) => (
            <li key={d.source}>
              {d.label}: <Code>{d.source}</Code>
            </li>
          ))}
        </ul>
        <p className={P}>
          <strong>Google's free tier.</strong> On the free shared tier, Google uses what's sent and the answers to
          provide, improve and develop its products and machine-learning technologies, and human reviewers may read
          them. Use your own paid key to avoid that. With your own key, your provider's terms and privacy policy apply to
          what you send it.
        </p>
        <p className={P}>
          <strong>Region restriction.</strong> Google's terms don't allow the free tier to be offered in the EEA,
          Switzerland or the UK, so the shared tier (answers and OCR) refuses requests that Cloudflare locates in:{' '}
          {countryNames.join(', ')}. Bring your own key there.
        </p>
      </section>

      <section aria-labelledby="privacy-server">
        <h2 id="privacy-server" className={H2}>What PocketRAG's server keeps</h2>
        <p className={P}>The server is a Cloudflare Worker. It does not log request bodies: not your questions, passages, files or keys.</p>
        <ul className={UL}>
          <li>
            <strong>Rate-limit counters.</strong> One counter per IP address per day for each tier (shared, own key,
            OCR), stored in Cloudflare KV under a key of the form <Code>ratelimit:shared:203.0.113.7:2026-11-08</Code>.
            The IP address is stored as is, not hashed. The value is only a count, and it expires after 24 hours.
          </li>
          <li>
            <strong>Shared-tier pause.</strong> When Google rate-limits the free tier, the server stores a short pause
            under <Code>cooldown:shared:gemini</Code>. It holds a time, nothing about you.
          </li>
          <li>
            <strong>Failure logs.</strong> When a provider call fails, the server logs the provider, model, HTTP status,
            error codes, whether it was the shared tier or your own key, and the provider's error message with any API
            key removed (withheld entirely if it repeats what was sent). No IP address, no request content.
          </li>
          <li>
            <strong>Maintainer alerts.</strong> When alerts are enabled, some of those failures also send the same
            fields to a private Discord channel for the maintainer.
          </li>
          <li>
            <strong>Cloudflare.</strong> Cloudflare hosts the site and the server and keeps its own request logs and
            analytics (for example the time, path, status and approximate location of each request) under its own
            privacy policy.
          </li>
        </ul>
      </section>

      <section aria-labelledby="privacy-delete">
        <h2 id="privacy-delete" className={H2}>Deleting your data</h2>
        <ul className={UL}>
          <li><strong>One document:</strong> the bin icon next to it.</li>
          <li><strong>One conversation:</strong> the bin icon next to it in the conversation list.</li>
          <li><strong>All chat history:</strong> "Delete all chat history" under the conversation list.</li>
          <li>
            <strong>Everything:</strong> "Delete everything" removes all documents and chat history. The downloaded AI
            models stay cached; to remove them and the settings too, clear this site's data in your browser settings.
          </li>
        </ul>
        <p className={P}>
          Nothing is kept on PocketRAG's server to delete, apart from the counters above, which expire within a day.
        </p>
      </section>

      <section aria-labelledby="privacy-terms">
        <h2 id="privacy-terms" className={H2}>Terms</h2>
        <ul className={UL}>
          <li>PocketRAG is provided as is, with no warranty of any kind. Answers can be wrong; check them against the cited passages.</li>
          <li>The free shared tier is rate-limited and may be unavailable at any time.</li>
          <li>Don't put confidential documents through the free shared tier: Google may use and review what's sent.</li>
          <li>When you use your own key, your provider's terms apply to everything you send it, and its charges are yours.</li>
          <li>
            Use it lawfully: don't use it to break the law or anyone's rights, to attack or overload the service, or
            to get around its limits.
          </li>
        </ul>
      </section>

      <section aria-labelledby="privacy-contact">
        <h2 id="privacy-contact" className={H2}>Who runs it</h2>
        <p className={P}>
          PocketRAG is built and operated by the PocketRAG maintainer (GitHub: Abhiram-0910). Questions or requests:{' '}
          <a className={LINK} href={ISSUES_URL} rel="noopener noreferrer" target="_blank">
            GitHub Issues
          </a>
          .
        </p>
      </section>

      <p className="mt-10 border-t border-slate-200 pt-4 text-xs text-slate-600 dark:border-slate-800 dark:text-slate-400">
        A plain-language description, not legal advice.
      </p>
    </article>
  )
}
