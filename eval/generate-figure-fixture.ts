// v1.4: renders eval/fixtures/figures-notes.pdf with Chromium (the globally installed
// Playwright, as in e2e/; not a project dependency). Run once; the PDF is committed.
//
//   NODE_PATH=$(npm root -g) node --experimental-strip-types eval/generate-figure-fixture.ts
//
// Page 1: a raster figure (an <img>, so an image XObject) between paragraphs.
// Page 2: a vector figure (inline SVG, so drawn paths, with text labels).
// Page 3: text only.
// Page 4: a "scanned" page: one full-page image with an invisible text layer over it, as
//         a scanner's OCR leaves it.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')
const OUT = new URL('./fixtures/figures-notes.pdf', import.meta.url).pathname

const CSS = `
@page { size: A4; margin: 18mm; }
body { font-family: 'DejaVu Serif', serif; font-size: 12pt; line-height: 1.45; margin: 0; }
.page { break-after: page; position: relative; }
.page:last-child { break-after: auto; }
h2 { font-size: 15pt; margin: 0 0 8pt; }
p { margin: 5pt 0; }
figure { margin: 10pt 0; }
figcaption { font-size: 10pt; font-style: italic; }
@page scan { margin: 0; }
.scanpage { page: scan; }
.scan { position: relative; height: 296mm; }
.scan img { position: absolute; inset: 0; width: 100%; height: 100%; }
.scan .ocr { position: absolute; top: 25mm; left: 18mm; right: 18mm; color: transparent; }
`

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.setContent('<!doctype html><canvas id="c"></canvas>')
  // Figure 1, drawn as pixels: a thylakoid with light coming in and products going out.
  const raster: string = await page.evaluate(() => {
    const c = document.getElementById('c') as HTMLCanvasElement
    c.width = 640
    c.height = 360
    const g = c.getContext('2d') as CanvasRenderingContext2D
    g.fillStyle = '#fff'
    g.fillRect(0, 0, 640, 360)
    g.fillStyle = '#cfe8c4'
    g.strokeStyle = '#2f6b2f'
    g.lineWidth = 6
    g.beginPath()
    g.ellipse(320, 200, 220, 90, 0, 0, Math.PI * 2)
    g.fill()
    g.stroke()
    g.strokeStyle = '#d99a00'
    for (let i = 0; i < 3; i++) {
      g.beginPath()
      g.moveTo(80 + i * 60, 20)
      g.lineTo(200 + i * 60, 130)
      g.stroke()
    }
    g.fillStyle = '#1b3a1b'
    g.font = 'bold 28px sans-serif'
    g.fillText('light', 40, 60)
    g.fillText('O2', 470, 120)
    g.fillText('ATP + NADPH', 380, 320)
    return c.toDataURL('image/png')
  })
  // The "scan": a grey page of text, as pixels.
  const scan: string = await page.evaluate(() => {
    const c = document.getElementById('c') as HTMLCanvasElement
    c.width = 900
    c.height = 1270
    const g = c.getContext('2d') as CanvasRenderingContext2D
    g.fillStyle = '#ecebe6'
    g.fillRect(0, 0, 900, 1270)
    g.fillStyle = '#333'
    g.font = '30px serif'
    const lines = ['Lab sheet: osmosis in potato strips', 'Strips in salt water lost mass;', 'strips in pure water gained mass.', 'Water moves toward the more', 'concentrated solution.']
    lines.forEach((l, i) => g.fillText(l, 70, 120 + i * 52))
    return c.toDataURL('image/png')
  })
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="page">
  <h2>Photosynthesis</h2>
  <p>Photosynthesis happens in the chloroplast. The light reactions take place in the thylakoid membrane, where chlorophyll absorbs light energy.</p>
  <figure><img src="${raster}" width="320" height="180" alt=""><figcaption>Figure 1: The light reactions in the thylakoid membrane.</figcaption></figure>
  <p>The light reactions split water, release oxygen, and make ATP and NADPH, which the Calvin cycle then uses to fix carbon dioxide into sugar.</p>
  <h2>The Calvin cycle</h2>
  <p>The Calvin cycle runs in the stroma, the fluid that surrounds the thylakoids. It does not need light directly, but it depends on the ATP and NADPH that the light reactions supply. The enzyme rubisco joins carbon dioxide to a five-carbon sugar called ribulose bisphosphate. The six-carbon product is unstable and splits at once into two molecules of a three-carbon compound.</p>
  <p>ATP and NADPH then reduce these compounds to glyceraldehyde phosphate. For every three turns of the cycle, one molecule of glyceraldehyde phosphate leaves to build glucose, sucrose and starch; the other five are rearranged, using more ATP, to regenerate ribulose bisphosphate so that the cycle can continue. Plants in hot, dry places reduce water loss by opening their stomata at night, storing carbon dioxide as an organic acid and releasing it to the Calvin cycle during the day.</p>
  <p>Factors that limit the rate of photosynthesis include light intensity, the concentration of carbon dioxide and temperature, because the enzymes of the Calvin cycle work fastest within a narrow range of temperatures.</p>
</div>
<div class="page">
  <h2>The water cycle</h2>
  <p>Water evaporates from the sea when the sun heats it. The vapour rises, cools and condenses into clouds.</p>
  <figure>
    <svg width="360" height="220" viewBox="0 0 360 220" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="180" width="360" height="40" fill="#7fb3d5"/>
      <circle cx="50" cy="45" r="28" fill="#f4d03f" stroke="#b7950b" stroke-width="3"/>
      <ellipse cx="230" cy="50" rx="70" ry="28" fill="#d5d8dc" stroke="#566573" stroke-width="3"/>
      <path d="M90 170 C 110 120, 140 90, 170 75" stroke="#1f618d" stroke-width="4" fill="none"/>
      <path d="M260 85 L 280 170" stroke="#1f618d" stroke-width="4" stroke-dasharray="8 6" fill="none"/>
      <path d="M300 85 L 320 170" stroke="#1f618d" stroke-width="4" stroke-dasharray="8 6" fill="none"/>
      <text x="6" y="118" font-size="14">evaporation</text>
      <text x="200" y="20" font-size="14">condensation</text>
      <text x="250" y="200" font-size="14">precipitation</text>
    </svg>
    <figcaption>Figure 2: The water cycle: evaporation, condensation and precipitation.</figcaption>
  </figure>
  <p>Precipitation returns the water to the sea and the land as rain or snow, and rivers carry it back to the sea.</p>
</div>
<div class="page">
  <h2>The cell membrane</h2>
  <p>The cell membrane is a phospholipid bilayer. It controls what enters and leaves the cell.</p>
  <p>Small uncharged molecules such as oxygen cross it by simple diffusion; ions need protein channels; active transport uses ATP to move substances against their concentration gradient.</p>
</div>
<div class="page scanpage">
  <div class="scan"><img src="${scan}" alt=""><div class="ocr"><p>Lab sheet: osmosis in potato strips. Strips in salt water lost mass; strips in pure water gained mass. Water moves toward the more concentrated solution.</p></div></div>
</div>
</body></html>`
  await page.setContent(html)
  await page.pdf({ path: OUT, format: 'A4', printBackground: true, preferCSSPageSize: true })
  await browser.close()
  console.log(`wrote ${OUT}`)
}

void main()
