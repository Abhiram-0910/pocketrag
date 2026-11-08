// Lists the privacy page states as facts. privacyFacts.test.ts fails if any drifts from
// the code it describes (localStorage keys in src/, the Worker's region set).

// Every localStorage key this app writes, and what it holds.
export const LOCAL_STORAGE_KEYS: readonly { key: string; holds: string }[] = [
  { key: 'pocketrag:has-visited-app', holds: "that you've opened the app before, so the intro page is skipped" },
  { key: 'pocketrag:diagram-images-enabled', holds: 'whether the diagram images switch is on' },
  { key: 'pocketrag:web-search-enabled', holds: 'whether the web search switch is on' },
]

// Countries where the free shared tier is refused (a copy of worker/src/region.ts's
// RESTRICTED_COUNTRIES; the frontend never imports Worker code).
export const REGION_RESTRICTED_COUNTRIES: readonly string[] = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'IS', 'LI', 'NO',
  'CH',
  'GB',
]

export const REPO_URL = 'https://github.com/Abhiram-0910/pocketrag'
export const ISSUES_URL = `${REPO_URL}/issues`
