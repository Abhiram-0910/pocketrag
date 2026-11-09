// Renders eval/fixtures.ts to PDFs in eval/fixtures/ with Chromium (the globally installed
// Playwright, as in e2e/ — not a project dependency). Run once; the PDFs are committed.
//
//   FONT_FILE=/path/to/noto-sans-devanagari-devanagari-400-normal.woff2 \
//   NODE_PATH=$(npm root -g) node --experimental-strip-types eval/generate-fixtures.ts
//
// FONT_FILE: Noto Sans Devanagari (SIL OFL 1.1, from npm @fontsource/noto-sans-devanagari)
// for the Hindi document; the PDF embeds a subset, which the OFL allows. The font file
// itself is not committed.
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync } from 'node:fs'
import { DOCS, type FixtureDoc } from './fixtures.ts'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const OUT = new URL('./fixtures/', import.meta.url).pathname
const fontFile = process.env.FONT_FILE
if (!fontFile) throw new Error('Set FONT_FILE to a Noto Sans Devanagari woff2 (see the header comment).')
const fontData = readFileSync(fontFile).toString('base64')

const CSS = `
@font-face { font-family: 'Noto Sans Devanagari'; src: url(data:font/woff2;base64,${fontData}) format('woff2'); }
body { font-family: 'DejaVu Serif', 'Noto Sans Devanagari', serif; font-size: 12pt; line-height: 1.45; margin: 0; }
.page { break-after: page; padding: 0; }
.page:last-child { break-after: auto; }
h2 { font-size: 14pt; margin: 18pt 0 6pt; }
p { margin: 4pt 0; }
table { border-collapse: collapse; margin: 8pt 0; }
td, th { border: 1px solid #444; padding: 3pt 6pt; text-align: right; }
.frac { display: inline-flex; flex-direction: column; vertical-align: middle; text-align: center; font-size: 10pt; }
.frac > span:first-child { border-bottom: 1px solid currentColor; }
`

function html(doc: FixtureDoc): string {
  const pages = doc.pages.map((page) => `<div class="page">${page.map((p) => p.html).join('\n')}</div>`).join('\n')
  return `<!doctype html><html lang="${doc.lang}"><head><meta charset="utf-8"><style>${CSS}</style></head><body>${pages}</body></html>`
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()
  const page = await browser.newPage()
  for (const doc of DOCS) {
    if (doc.scanned) {
      // A phone-scan stand-in: the page rendered to a slightly tilted grey PNG, then
      // placed in a PDF as an image only, so the PDF has no text layer at all.
      await page.setViewportSize({ width: 794, height: 1123 })
      await page.setContent(html(doc))
      await page.evaluate(() => document.fonts.ready)
      await page.addStyleTag({ content: 'body { background: #ecebe6; padding: 48px; transform: rotate(-0.6deg); }' })
      const png = (await page.screenshot({ fullPage: false })).toString('base64')
      await page.setContent(
        `<!doctype html><html><head><style>@page { margin: 0 } body { margin: 0 } img { width: 210mm; height: 297mm; display: block }</style></head><body><img src="data:image/png;base64,${png}"></body></html>`,
      )
      await page.pdf({ path: `${OUT}${doc.id}.pdf`, format: 'A4', printBackground: true })
    } else {
      await page.setContent(html(doc))
      // An embedded web font paints nothing until it has loaded (blank Hindi pages otherwise).
      await page.evaluate(() => document.fonts.ready)
      await page.pdf({ path: `${OUT}${doc.id}.pdf`, format: 'A4', margin: { top: '20mm', bottom: '20mm', left: '18mm', right: '18mm' } })
    }
    console.log(`wrote ${doc.id}.pdf`)
  }
  await browser.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
