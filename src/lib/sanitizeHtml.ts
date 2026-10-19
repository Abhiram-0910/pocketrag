import DOMPurify from 'dompurify'

// QueryPanel calls this during render, for the current answer and every stored turn, so
// without a cache every re-render re-parses each widget. Keyed by the input string;
// oldest entry evicted past MAX_CACHED (QueryPanel keeps at most 10 turns + the current one).
const MAX_CACHED = 16
const cache = new Map<string, string>()

/**
 * Sanitizes Gemini grounding's searchEntryPoint.renderedContent before it hits
 * dangerouslySetInnerHTML. Google's own docs never state this widget HTML is safe to
 * render unsanitized (checked directly, not assumed — see SECURITY_REVIEW.md) — this is
 * the only line standing between a malformed/compromised grounding response and script
 * execution in the same origin as the app's IndexedDB document store. DOMPurify's default
 * config already allows `style` tags/attributes (verified against its source), which the
 * widget needs for its light/dark CSS, while stripping `script`/event-handler/`javascript:`
 * vectors — no custom allowlist needed.
 */
export function sanitizeGroundingHtml(html: string): string {
  let clean = cache.get(html)
  if (clean === undefined) {
    clean = DOMPurify.sanitize(html)
    cache.set(html, clean)
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string)
  }
  return clean
}
