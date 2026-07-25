// gemini-2.5-flash-lite (named in the original spec) returns 404 "no longer
// available to new users" for this API key — pinned to 3.5 instead, deliberately,
// not via the floating `gemini-flash-lite-latest` alias. Confirmed working 2026-07-25.
const MODEL_ID = 'gemini-3.5-flash-lite'
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent`

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[]
}

/** Calls Gemini's generateContent endpoint. `fetchImpl` is injected so tests can mock it. */
export async function callGemini(fetchImpl: typeof fetch, apiKey: string, prompt: string): Promise<string> {
  const response = await fetchImpl(`${ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Gemini API error ${response.status}: ${body}`)
  }

  const data = (await response.json()) as GeminiResponse
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('Gemini response did not contain any answer text.')
  return text
}
