// Milestone 14: whether this browser has ever entered the app view before, past the
// landing page. Default unset (false) means show the landing page — a first-time
// visitor sees it; a returning visitor (who must have set this on an earlier visit to
// have gotten anywhere at all) skips straight to the app, same read-once-at-mount,
// synchronous, zero-flash pattern as diagramImageSetting.ts/webSearchSetting.ts.
const STORAGE_KEY = 'pocketrag:has-visited-app'

export function getHasVisitedApp(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(STORAGE_KEY) === 'true'
}

export function setHasVisitedApp(): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(STORAGE_KEY, 'true')
}
