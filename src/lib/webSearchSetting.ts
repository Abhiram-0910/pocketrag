// Milestone 12 (Gemini-native grounding): the opt-in toggle for letting Gemini use its
// built-in Google Search tool. Default OFF is the load-bearing part — anything unset or
// malformed reads as disabled, never enabled. Persisted across reloads, same reasoning
// as diagramImageSetting.ts: a toggle that silently resets would either annoy someone
// who wants it on, or create doubt about whether it's currently on.
const STORAGE_KEY = 'pocketrag:web-search-enabled'

export function getWebSearchEnabled(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(STORAGE_KEY) === 'true'
}

export function setWebSearchEnabled(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(STORAGE_KEY, String(enabled))
}
