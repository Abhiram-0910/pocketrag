// Milestone 10 Phase B: the opt-in toggle for sending a page image alongside a
// question. Default OFF is the load-bearing part — anything unset or malformed reads
// as disabled, never enabled. Persisted across reloads so the choice doesn't reset
// every session (a toggle that silently resets would either annoy someone who wants it
// on, or worse, create doubt about whether it's currently on).
const STORAGE_KEY = 'pocketrag:diagram-images-enabled'

export function getDiagramImagesEnabled(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(STORAGE_KEY) === 'true'
}

export function setDiagramImagesEnabled(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(STORAGE_KEY, String(enabled))
}
