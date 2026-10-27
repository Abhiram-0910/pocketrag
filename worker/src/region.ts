// Gemini API terms (Use Restrictions): "You may use only Paid Services when making API
// Clients available to users in the European Economic Area, Switzerland, or the United
// Kingdom." The shared tier runs on an unpaid key, so it refuses those countries.
// EU27 + EEA (IS LI NO) + CH + GB, as ISO 3166-1 alpha-2 (Cloudflare's request.cf.country).
const RESTRICTED_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'IS', 'LI', 'NO',
  'CH',
  'GB',
])

// ponytail: fail-open on purpose — a missing or non-country value (undefined in local
// dev, XX unknown, T1 Tor) is allowed. Geo-IP can't see through a VPN either; this is
// a good-faith gate on what Cloudflare reports, not proof of where the user is.
export function isRegionRestricted(country: unknown): boolean {
  return typeof country === 'string' && RESTRICTED_COUNTRIES.has(country)
}
