// Step C CSP check: every app flow under public/_headers, collecting CSP violation reports.
//
// Manual run, not wired into CI yet. Uses the globally installed Playwright (no project
// dependency) against a server that applies public/_headers — `wrangler pages dev` locally,
// or a Pages preview/production URL:
//
//   npm run build && npx wrangler pages dev dist --port 8788 &
//   NODE_PATH=$(npm root -g) node e2e/step-c-csp.cjs                    # Chromium, WASM backend
//   WEBGPU=1 NODE_PATH=$(npm root -g) node e2e/step-c-csp.cjs           # Chromium, SwiftShader WebGPU
//   BROWSER=firefox NODE_PATH=$(npm root -g) node e2e/step-c-csp.cjs
//   APP_URL=https://<preview>.pocketrag.pages.dev NODE_PATH=$(npm root -g) node e2e/step-c-csp.cjs
//
// Violations reach the policy's report-uri (/__csp-report), which this script records —
// that is the only place violations raised inside the embedding/pdf.js workers show up.
// Every Worker call is route-mocked: the shared tier is never called. Hugging Face and
// jsDelivr downloads are real. The fixture PDFs are generated (no binaries in the repo); the
// real-world embedded-fonts PDF defaults to one Debian/Ubuntu ships (REAL_PDF overrides).
// Exits 1 if any flow fails, or any violation other than the allowlisted Gemini-widget
// <style> (see the end of main) or any CSP-blocked request is seen.
const pw = require('playwright')
const fs = require('fs')
const os = require('os')
const path = require('path')

const APP = (process.env.APP_URL || 'http://localhost:8788').replace(/\/$/, '')
const API = 'https://pocketrag-answer.abhiram-dev.workers.dev'
const BROWSER = process.env.BROWSER || 'chromium'
const WEBGPU = process.env.WEBGPU === '1'
const REAL_PDF = process.env.REAL_PDF || '/usr/share/doc/shared-mime-info/shared-mime-info-spec.pdf'
const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@'
const CORS = { 'Access-Control-Allow-Origin': APP, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }

// Shape of Gemini grounding's searchEntryPoint.renderedContent (leading <style>, inline svg, chip link).
const WIDGET =
  '<style>.container{align-items:center;border-radius:8px;display:flex;padding:8px 12px}.chip{display:inline-block;border:solid 1px;border-radius:16px;padding:5px 16px}</style>' +
  '<div class="container"><div class="headline"><svg width="18" height="18" viewBox="9 9 35 35" xmlns="http://www.w3.org/2000/svg"><path d="M42.86 27.0H26.31v3.1z" fill="#4285F4"/></svg></div>' +
  '<div class="carousel"><a class="chip" href="https://www.google.com/search?q=mitochondrion">mitochondrion function</a></div></div>'

function textPdf(pages) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  const kids = []
  for (const lines of pages) {
    const stream = `BT /F1 10 Tf 40 760 Td 12 TL ${lines.map((l) => `(${l}) Tj T*`).join(' ')} ET`
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${objs.length} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`)
    kids.push(`${objs.length} 0 R`)
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`
  let pdf = '%PDF-1.4\n'
  const offsets = objs.map((o, i) => {
    const offset = pdf.length
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`
    return offset
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  return Buffer.from(`${pdf}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1')
}

async function writeFixtures(dir) {
  const topics = ['mitochondria make ATP', 'ribosomes build proteins', 'the nucleus stores DNA', 'chloroplasts capture light', 'lysosomes digest waste', 'the Golgi apparatus packages proteins', 'the cell membrane controls transport', 'vacuoles store water']
  const pages = topics.map((t, i) => [`Page ${i + 1}: ${t}.`, ...Array.from({ length: 30 }, (_, k) => `Detail ${k + 1} on how ${t} in eukaryotic cells under varied conditions.`)])
  fs.writeFileSync(path.join(dir, 'eight-pages.pdf'), textPdf(pages))
  fs.writeFileSync(path.join(dir, 'notes-scan.pdf'), textPdf([['Handwritten lecture notes about the Krebs cycle.']]))
  fs.writeFileSync(path.join(dir, 'note.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
  // Chromium-printed PDF: embedded TrueType font subsets + a raster image XObject (the chart).
  const chromium = await pw.chromium.launch()
  const page = await chromium.newPage()
  await page.setContent('<h1>Organelle energy report</h1><p>Figure 1 is a bar chart of ATP production by organelle in a typical eukaryotic cell.</p><canvas id="c" width="480" height="240"></canvas><p>The chart shows mitochondria produce far more ATP than any other organelle.</p>')
  await page.evaluate(() => {
    const c = document.getElementById('c')
    const ctx = c.getContext('2d')
    ;[200, 60, 30, 15].forEach((h, i) => {
      ctx.fillStyle = ['#2563eb', '#16a34a', '#d97706', '#dc2626'][i]
      ctx.fillRect(40 + i * 110, 230 - h, 70, h)
    })
    const img = new Image()
    img.src = c.toDataURL('image/png')
    img.id = 'chart'
    c.replaceWith(img)
  })
  await page.pdf({ path: path.join(dir, 'chart-report.pdf') })
  await chromium.close()
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrag-csp-'))
  await writeFixtures(dir)
  const realPdf = fs.existsSync(REAL_PDF) ? REAL_PDF : null

  const launchArgs = WEBGPU ? ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader'] : []
  const browser = await pw[BROWSER].launch(BROWSER === 'chromium' ? { args: launchArgs } : {})
  const context = await browser.newContext({ acceptDownloads: true })
  const page = await context.newPage()

  const reports = []
  const cspBlocked = []
  const pageErrors = []
  const ortUrls = new Set()
  const answerBodies = []
  let phase = 'start'
  page.on('pageerror', (e) => pageErrors.push(`${phase}: ${String(e).slice(0, 200)}`))
  context.on('request', (r) => r.url().startsWith(ORT_CDN) && ortUrls.add(r.url().split('/').pop()))
  context.on('requestfailed', (r) => {
    const why = r.failure()?.errorText || ''
    if (/csp|blocked/i.test(why)) cspBlocked.push(`${phase}: ${r.url().slice(0, 100)} ${why}`)
  })
  // Reports are read off the request event: Playwright's Firefox doesn't route CSP report
  // POSTs (the request still fires), so a route-only collector silently sees none there.
  context.on('request', (req) => {
    if (!req.url().endsWith('/__csp-report')) return
    try {
      const r = JSON.parse(req.postData())['csp-report']
      reports.push({ phase, directive: r['effective-directive'] || r['violated-directive'], blocked: r['blocked-uri'], source: r['source-file'] })
    } catch {
      reports.push({ phase, raw: String(req.postData()).slice(0, 200) })
    }
  })
  await context.route('**/__csp-report', (route) => route.fulfill({ status: 204 }))
  await context.route(`${API}/**`, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const json = (body) => route.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (req.url().endsWith('/answer')) {
      const body = JSON.parse(req.postData() || '{}')
      answerBodies.push({ phase, hasImage: Boolean(body.image) })
      const ids = [...new Set((body.chunks || []).map((c) => c.documentId))]
      return json({ answer: `Mocked answer for ${phase} (Doc 1, page 1).`, groundingWarning: false, docLabels: ids.map((d, i) => ({ label: i + 1, documentId: d })), searchEntryPointHtml: WIDGET })
    }
    if (req.url().endsWith('/models')) return json({ models: [{ id: 'model-a', displayName: 'model-a' }] })
    if (req.url().endsWith('/ocr')) return json({ text: 'Transcribed notes: the Krebs cycle runs in the mitochondrial matrix.' })
    return route.abort()
  })

  const flows = []
  async function flow(name, fn) {
    phase = name
    const started = Date.now()
    try {
      const detail = await fn()
      flows.push({ flow: name, ok: true, ...(detail || {}) })
    } catch (e) {
      flows.push({ flow: name, ok: false, error: String(e).split('\n')[0].slice(0, 200) })
    }
    console.error(`${flows.at(-1).ok ? 'ok  ' : 'FAIL'} ${name} (${Math.round((Date.now() - started) / 1000)}s)`)
  }

  const docButton = (name) => page.locator('li button', { hasText: name }).first()
  const waitReady = (name) =>
    docButton(name)
      .filter({ hasText: /\d+ chunks?$/ })
      .waitFor({ timeout: 300_000 })
  const queryInput = page.locator('form input[type="text"]')
  async function ask(question, expectPhase) {
    await queryInput.fill(question)
    await page.getByRole('button', { name: 'Search' }).click()
    await page.getByText(`Mocked answer for ${expectPhase}`).first().waitFor({ timeout: 300_000 })
  }
  const upload = (file) => page.setInputFiles('input[type="file"][accept="application/pdf"]', file)

  await flow('landing', async () => {
    await page.goto(APP)
    await page.getByRole('button', { name: 'Get started' }).click()
    await page.locator('input[type="file"][accept="application/pdf"]').waitFor({ state: 'attached' })
  })
  await flow('upload 8-page PDF + embedding', async () => {
    await upload(path.join(dir, 'eight-pages.pdf'))
    await waitReady('eight-pages.pdf')
    const badge = await page.locator('text=Backend:').allInnerTexts()
    const fallback = await page.getByText('Using the WASM backend').count()
    return { backend: badge[0] || (fallback ? 'WASM (fallback banner)' : 'WASM') }
  })
  await flow('upload real-world PDF (embedded Type 1 fonts)', async () => {
    if (!realPdf) throw new Error(`no real-world PDF at ${REAL_PDF}`)
    await upload(realPdf)
    await waitReady(path.basename(realPdf))
  })
  await flow('upload chart PDF (embedded TrueType + raster image)', async () => {
    await upload(path.join(dir, 'chart-report.pdf'))
    await waitReady('chart-report.pdf')
  })
  await flow('query + reranking', async () => {
    await docButton('eight-pages.pdf').click()
    await ask('What do ribosomes do in eukaryotic cells?', 'query + reranking')
  })
  await flow('diagram path (page image sent)', async () => {
    await page.getByLabel('Send a page image when a matched chunk looks like it has a diagram', { exact: false }).check()
    await docButton('chart-report.pdf').click()
    await ask('What does Figure 1 bar chart show about ATP production?', 'diagram path (page image sent)')
    const sent = answerBodies.filter((b) => b.phase === 'diagram path (page image sent)')
    if (!sent.some((b) => b.hasImage)) throw new Error('no page image in the /answer request')
  })
  await flow('search-suggestions widget rendered', async () => {
    const chip = page.locator('a.chip').first()
    await chip.waitFor()
    return { chipText: await chip.innerText() }
  })
  await flow('PDF export', async () => {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      page.getByRole('button', { name: 'Export as PDF' }).click(),
    ])
    return { file: download.suggestedFilename() }
  })
  await flow('BYOK models fetch (mocked)', async () => {
    await page.getByLabel('Use your own API key').check()
    await page.getByLabel('Provider').selectOption('openai')
    await page.getByLabel('OpenAI API key').fill('sk-fake-stepc-0000000000')
    await page.getByRole('button', { name: 'Fetch models' }).click()
    await page.getByLabel('Model', { exact: true }).waitFor()
    await page.getByLabel('Use your own API key').uncheck()
  })
  await flow('Notes OCR: image + PDF (mocked)', async () => {
    await page.getByRole('button', { name: 'Notes', exact: true }).click()
    for (const file of ['note.png', 'notes-scan.pdf']) {
      await page.setInputFiles('input[type="file"][multiple]', path.join(dir, file))
      await page.getByRole('button', { name: 'Upload for OCR' }).click()
      await waitReady(file)
    }
    await page.getByRole('button', { name: 'Documents', exact: true }).click()
  })
  await flow('reload + restore', async () => {
    await page.reload()
    const getStarted = page.getByRole('button', { name: 'Get started' })
    if (await getStarted.isVisible().catch(() => false)) await getStarted.click()
    for (const name of ['eight-pages.pdf', 'chart-report.pdf']) await waitReady(name)
    await docButton('eight-pages.pdf').click()
    await ask('Where is DNA stored?', 'reload + restore')
  })
  await flow('document deletion', async () => {
    await page.getByRole('button', { name: 'Delete eight-pages.pdf' }).click()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await docButton('eight-pages.pdf').waitFor({ state: 'detached', timeout: 30_000 })
  })

  phase = 'settle'
  await page.waitForTimeout(2000)
  await browser.close()

  // The one known violation: DOMPurify (in the main bundle) parsing the mocked Gemini
  // widget, whose leading <style> trips style-src-elem in Chromium (Firefox doesn't flag
  // DOMParser documents). Nothing renders differently — DOMPurify already drops that
  // leading <style>. Allowlisted only for that exact shape, in a phase that rendered a
  // widget answer; anything else fails the run.
  const widgetPhases = new Set(answerBodies.map((b) => b.phase))
  const isWidgetStyle = (r) =>
    r.directive === 'style-src-elem' && r.blocked === 'inline' && /\/assets\/index-[\w-]+\.js$/.test(r.source || '') && widgetPhases.has(r.phase)
  const allowlisted = reports.filter(isWidgetStyle)
  const unexpected = reports.filter((r) => !isWidgetStyle(r))
  const byDirective = {}
  for (const r of unexpected) byDirective[r.directive || 'unparsed'] = (byDirective[r.directive || 'unparsed'] || 0) + 1
  const failed = flows.filter((f) => !f.ok)
  console.log(JSON.stringify({ browser: BROWSER, webgpu: WEBGPU, app: APP, flows, ortFromJsDelivr: [...ortUrls], allowlistedWidgetStyle: allowlisted.length, violationsByDirective: byDirective, unexpected, cspBlocked, pageErrors }, null, 2))
  if (failed.length || unexpected.length || cspBlocked.length) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
