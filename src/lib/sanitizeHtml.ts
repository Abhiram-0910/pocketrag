import DOMPurify from 'dompurify'

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
  return DOMPurify.sanitize(html)
}
