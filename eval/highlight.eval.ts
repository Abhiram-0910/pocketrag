// v1.4 click-to-verify: what fraction of fixture chunks the highlight can place. Each
// fixture PDF is read and chunked exactly as the app does (pdf.ts's item join, the real
// e5 tokenizer, chunker.ts), then each chunk is located two ways:
//   stored:  the item range saved at ingest (v1.4) reads back as the chunk's text;
//   search:  text search of the page (chunks saved before v1.4, no stored range).
// It also counts how many chunks get at least one highlight rectangle. Writes
// eval/results/highlight.json. Run with `npm run eval`.
import { describe, it } from 'vitest'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AutoTokenizer, env } from '@huggingface/transformers'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { chunkText } from '../src/lib/chunker'
import { EMBEDDING_MODEL } from '../src/lib/searchModels'
import { charRangeToItems, itemRangeBoxes, itemRangeText, resolvePassage, type TextItemBox } from '../src/lib/textLayout'

const ROOT = new URL('..', import.meta.url).pathname
env.cacheDir = join(ROOT, 'eval/.cache')
env.allowLocalModels = false

describe('click-to-verify: fixture chunks that resolve', () => {
  it('reports stored-range and text-search resolution per fixture', async () => {
    const tokenizer = await AutoTokenizer.from_pretrained(EMBEDDING_MODEL.id, { revision: EMBEDDING_MODEL.revision })
    const countTokens = (text: string) => tokenizer(text, { add_special_tokens: false }).input_ids.data.length
    const perFile: Record<string, { pages: number; chunks: number; stored: number; search: number; boxed: number }> = {}
    for (const name of readdirSync(join(ROOT, 'eval/fixtures')).filter((f) => f.endsWith('.pdf'))) {
      const pdf = await getDocument({ data: new Uint8Array(readFileSync(join(ROOT, 'eval/fixtures', name))), verbosity: 0 }).promise
      const row = { pages: pdf.numPages, chunks: 0, stored: 0, search: 0, boxed: 0 }
      for (let p = 1; p <= pdf.numPages; p++) {
        const content = await (await pdf.getPage(p)).getTextContent()
        const items: TextItemBox[] = content.items.map((i) =>
          'str' in i ? { str: i.str, transform: i.transform as number[], width: i.width, height: i.height } : { str: '', transform: [1, 0, 0, 1, 0, 0], width: 0, height: 0 },
        )
        const strs = items.map((i) => i.str)
        for (const chunk of chunkText(strs.join(' '), { countTokens })) {
          row.chunks++
          const stored = charRangeToItems(
            strs.map((s) => s.length),
            chunk.start,
            chunk.end,
          )
          if (stored && itemRangeText(strs, stored) === chunk.text) row.stored++
          const found = resolvePassage(strs, chunk.text)
          if (found) row.search++
          if (found && itemRangeBoxes(items, found).length > 0) row.boxed++
        }
      }
      perFile[name] = row
    }
    const total = Object.values(perFile).reduce((t, r) => ({ chunks: t.chunks + r.chunks, stored: t.stored + r.stored, search: t.search + r.search, boxed: t.boxed + r.boxed }), { chunks: 0, stored: 0, search: 0, boxed: 0 })
    const out = { tokenizer: `${EMBEDDING_MODEL.id}@${EMBEDDING_MODEL.revision}`, perFile, total }
    writeFileSync(join(ROOT, 'eval/results/highlight.json'), `${JSON.stringify(out, null, 2)}\n`)
  })
})
