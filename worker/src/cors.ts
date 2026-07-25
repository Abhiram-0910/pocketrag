const DEV_ORIGINS = new Set(['http://localhost:5173', 'http://localhost:4173'])

/** Returns the request's Origin if it's allowed, otherwise null (no CORS headers sent). */
export function resolveCorsOrigin(requestOrigin: string | null, productionOrigin: string): string | null {
  if (!requestOrigin) return null
  if (DEV_ORIGINS.has(requestOrigin)) return requestOrigin
  if (productionOrigin && requestOrigin === productionOrigin) return requestOrigin
  return null
}

export function corsHeaders(allowedOrigin: string | null): HeadersInit {
  if (!allowedOrigin) return {}
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}
