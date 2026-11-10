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
//
// Phase 2b: chat-history flows, and a reconciliation of every cross-origin request the
// browser made against the Receipts / This-session rows the app rendered (data-host /
// data-final-host), read off the DOM — which also proves the embedding worker's download
// records reach the main thread. A redirect chain (huggingface.co → *.hf.co) is one
// request; a CORS preflight (OPTIONS) must pair with a POST. Any request with no ledger
// row fails the run.
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
  let streamedAnswers = 0
  // Every answer carries the Search Suggestions widget (→ grounded) unless a flow turns it off.
  let groundedAnswers = true
  // Cross-origin requests as the browser made them, and the ledger rows the app rendered.
  const ownOrigin = new URL(APP).origin
  const observed = []
  const ledger = new Map()
  let phase = 'start'
  page.on('pageerror', (e) => pageErrors.push(`${phase}: ${String(e).slice(0, 200)}`))
  context.on('request', (r) => r.url().startsWith(ORT_CDN) && ortUrls.add(r.url().split('/').pop()))
  context.on('request', (r) => {
    const url = r.url()
    if (!/^https?:/.test(url) || new URL(url).origin === ownOrigin) return
    observed.push({ phase, req: r })
  })
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
      answerBodies.push({ phase, hasImage: Boolean(body.image), history: body.history || [] })
      const ids = [...new Set((body.chunks || []).map((c) => c.documentId))]
      // v1.3: a streamed request gets the Worker's event stream (one response body, so it
      // reconciles as one request and one Receipt row, settled 'ok' at `done`). Simulated
      // grounded answers stay JSON: the real Worker never streams a web-search answer.
      if (body.stream && !groundedAnswers) {
        streamedAnswers++
        const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
        return route.fulfill({
          status: 200,
          headers: { ...CORS, 'Content-Type': 'text/event-stream; charset=utf-8' },
          body:
            ev('meta', { provider: 'gemini', model: 'gemini-3.5-flash-lite' }) +
            ev('delta', { t: `Mocked answer #${answerBodies.length} ` }) +
            ev('delta', { t: `for ${phase} (Doc 1, page 1).` }) +
            ev('done', { groundingWarning: false, docLabels: ids.map((d, i) => ({ label: i + 1, documentId: d })) }),
        })
      }
      return json({
        answer: `Mocked answer #${answerBodies.length} for ${phase} (Doc 1, page 1).`,
        groundingWarning: false,
        docLabels: ids.map((d, i) => ({ label: i + 1, documentId: d })),
        ...(groundedAnswers ? { searchEntryPointHtml: WIDGET } : {}),
      })
    }
    if (req.url().endsWith('/models')) return json({ models: [{ id: 'gpt-5-mini', displayName: 'gpt-5-mini' }] })
    if (req.url().endsWith('/ocr')) return json({ text: 'Transcribed notes: the Krebs cycle runs in the mitochondrial matrix.' })
    return route.abort()
  })

  // Union of every Receipt / This-session row rendered so far, by egress id (a later read of
  // the same request replaces the in-flight copy). Taken before anything that removes rows
  // from the DOM: a reload (the session log is memory-only) or a delete.
  async function snapshotLedger() {
    const rows = await page
      .locator('[data-egress-id]')
      .evaluateAll((els) => els.map((el) => ({ id: el.getAttribute('data-egress-id'), host: el.getAttribute('data-host'), finalHost: el.getAttribute('data-final-host'), purpose: el.getAttribute('data-purpose') })))
      .catch(() => [])
    for (const row of rows) ledger.set(row.id, row)
  }

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
    await snapshotLedger()
    console.error(`${flows.at(-1).ok ? 'ok  ' : 'FAIL'} ${name} (${Math.round((Date.now() - started) / 1000)}s)`)
  }

  const docButton = (name) => page.locator('li button', { hasText: name }).first()
  const waitReady = (name) =>
    docButton(name)
      .filter({ hasText: /\d+ chunks?$/ })
      .waitFor({ timeout: 300_000 })
  const queryInput = page.locator('form input[type="text"]')
  async function ask(question, expectPhase) {
    const n = answerBodies.length + 1
    await queryInput.fill(question)
    await page.getByRole('button', { name: 'Search' }).click()
    await page.getByText(`Mocked answer #${n} for ${expectPhase}`).first().waitFor({ timeout: 300_000 })
    return `Mocked answer #${n} for ${expectPhase}`
  }
  const focusedId = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName)
  const nav = page.locator('nav[aria-labelledby="conversations-heading"]')
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
  // v1.4: with the page-image opt-in off, the figure next to the cited text is cut from the
  // page and the citation opens the highlighted page, all drawn locally: no request in this
  // flow carries image bytes, and no answer request has an image.
  await flow('figure crop + click-to-verify (no image leaves)', async () => {
    await page.getByLabel('Send a page image when a matched chunk looks like it has a diagram', { exact: false }).uncheck()
    await upload(path.join(__dirname, '../eval/fixtures/figures-notes.pdf'))
    await waitReady('figures-notes.pdf')
    await docButton('figures-notes.pdf').click()
    await ask('What happens in the light reactions?', 'figure crop + click-to-verify (no image leaves)')
    await page.locator('#answer-area [data-figure-kind="figure"] canvas').waitFor({ timeout: 60_000 })
    await page.locator('#answer-area').getByRole('button', { name: /Doc 1, page 1/ }).first().click()
    const status = await page.locator('dialog [data-verify-status]').getAttribute('data-verify-status', { timeout: 60_000 })
    await page.keyboard.press('Escape')
    const mine = observed.filter((o) => o.phase === 'figure crop + click-to-verify (no image leaves)')
    const imageBytes = mine.filter((o) => /\/9j\/|iVBOR|data:image|"image"/.test(o.req.postData() || '')).length
    const withImage = answerBodies.filter((b) => b.phase === 'figure crop + click-to-verify (no image leaves)' && b.hasImage).length
    if (status !== 'highlight') throw new Error(`verify status ${status}`)
    if (imageBytes || withImage) throw new Error(`${imageBytes} requests with image bytes, ${withImage} answer requests with an image`)
    return { requests: mine.length, imageBytes, withImage, verify: status }
  })
  await flow('BYOK models fetch (mocked)', async () => {
    await page.getByLabel('Use your own API key').check()
    await page.getByLabel('Provider', { exact: true }).selectOption('openai')
    await page.getByLabel('OpenAI API key').fill('sk-fake-stepc-0000000000')
    await page.getByRole('button', { name: 'Find a model' }).click()
    await page.getByRole('button', { name: 'Use this model' }).click()
    await page.getByRole('button', { name: 'Change', exact: true }).waitFor()
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
  await flow('history excludes grounded answers (QueryPanel)', async () => {
    await docButton('eight-pages.pdf').click()
    groundedAnswers = true
    const grounded = await ask('Which organelle makes ATP?', 'history excludes grounded answers (QueryPanel)')
    groundedAnswers = false
    const plain = await ask('Which organelle builds proteins?', 'history excludes grounded answers (QueryPanel)')
    await ask('And which one stores DNA?', 'history excludes grounded answers (QueryPanel)')
    // The request after a grounded answer, and the one after a plain answer.
    const [afterGrounded, afterPlain] = answerBodies.slice(-2).map((b) => b.history.map((h) => h.answer))
    const isAnswer = (prefix) => (a) => a.startsWith(`${prefix} (`)
    if (afterGrounded.some(isAnswer(grounded))) throw new Error('the grounded answer was sent as history')
    if (!afterPlain.some(isAnswer(plain))) throw new Error('the plain answer was not sent as history')
    if (afterPlain.some(isAnswer(grounded))) throw new Error('the grounded answer was sent as history (third request)')
    if ([...afterGrounded, ...afterPlain].some((a) => a.includes('searchEntryPoint'))) throw new Error('widget HTML in history')
    return { historyAfterGrounded: afterGrounded.length, historyAfterPlain: afterPlain.length }
  })
  await flow('reload + restore', async () => {
    await page.reload()
    const getStarted = page.getByRole('button', { name: 'Get started' })
    if (await getStarted.isVisible().catch(() => false)) await getStarted.click()
    for (const name of ['eight-pages.pdf', 'chart-report.pdf']) await waitReady(name)
    // The most recent conversation reopens on its own: its last (plain) answer is back,
    // and grounded answers before it are placeholders — they were never stored.
    await page.getByText('And which one stores DNA?').first().waitFor({ timeout: 30_000 })
    const notRetained = await page.getByText('Web-grounded answer, not retained (Google terms)').count()
    if (notRetained === 0) throw new Error('no restored grounded turn shown as not retained')
    // A not-retained card shows the placeholder only: no grounded / ungrounded banner.
    const bannersOnNotRetained = await page.evaluate(() =>
      [...document.querySelectorAll('p')]
        .filter((p) => p.textContent === 'Web-grounded answer, not retained (Google terms)')
        .filter((p) => /Grounded in your documents\.|may not be fully grounded/.test(p.parentElement.textContent)).length,
    )
    if (bannersOnNotRetained !== 0) throw new Error(`${bannersOnNotRetained} not-retained cards still show a grounding banner`)
    await docButton('eight-pages.pdf').click()
    await ask('Where is DNA stored?', 'reload + restore')
    return { restoredNotRetained: notRetained, bannersOnNotRetained }
  })
  await flow('document deletion', async () => {
    await page.getByRole('button', { name: 'Delete eight-pages.pdf' }).click()
    const confirm = page.getByText(/chat turns? cites? this document and keeps? (its|their) answers?/).first()
    await confirm.waitFor({ timeout: 10_000 })
    const confirmText = (await confirm.innerText()).split('\n')[0]
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await docButton('eight-pages.pdf').waitFor({ state: 'detached', timeout: 30_000 })
    return { confirmText }
  })
  await flow('history: new, delete one, delete all (focus)', async () => {
    await docButton('chart-report.pdf').click()
    await snapshotLedger()
    await nav.getByRole('button', { name: 'New conversation' }).click()
    const afterNew = await focusedId()
    if (afterNew !== 'question-input') throw new Error(`after New: focus on ${afterNew}`)
    await ask('What does Figure 1 show?', 'history: new, delete one, delete all (focus)')
    const rows = nav.locator('li > div > button:not([aria-label])')
    const before = await rows.count()
    if (before < 2) throw new Error(`expected 2+ conversations, saw ${before}`)
    // Delete the newest (first) row: focus lands on the row that took its place.
    await snapshotLedger()
    const second = (await rows.nth(1).innerText()).split('\n')[0]
    await nav.locator('li').first().getByRole('button', { name: /^Delete conversation:/ }).click()
    await nav.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.waitForFunction((n) => document.querySelectorAll('nav li > div > button:not([aria-label])').length === n, before - 1)
    const afterOne = await page.evaluate(() => document.activeElement?.closest('li')?.innerText.split('\n')[0] ?? document.activeElement?.id)
    if (afterOne !== second) throw new Error(`after delete-one: focus on ${afterOne}, expected ${second}`)
    await nav.getByRole('button', { name: 'Delete all chat history' }).click()
    await nav.getByRole('button', { name: 'Delete', exact: true }).click()
    await nav.getByText('No saved conversations yet.').waitFor()
    const afterAll = await focusedId()
    if (afterAll !== 'conversations-heading') throw new Error(`after delete-all: focus on ${afterAll}`)
    return { conversationsBefore: before, focusAfterNew: afterNew, focusAfterDeleteOne: 'next row', focusAfterDeleteAll: afterAll }
  })
  await flow('delete everything (model cache kept)', async () => {
    await ask('What does the chart compare?', 'delete everything (model cache kept)')
    await snapshotLedger()
    await nav.getByRole('button', { name: 'Delete everything' }).click()
    await nav.getByRole('button', { name: 'Delete', exact: true }).click()
    await nav.getByText('Deleted all documents and chat history.').waitFor()
    const focus = await focusedId()
    if (focus !== 'conversations-heading') throw new Error(`after delete everything: focus on ${focus}`)
    if (await page.locator('li button', { hasText: /\.(pdf|png)/ }).count()) throw new Error('documents still listed')
    // Reload so the worker has to load the model again: from the Cache API, not the network.
    await page.reload()
    const mark = observed.length
    await upload(path.join(dir, 'eight-pages.pdf'))
    await waitReady('eight-pages.pdf')
    const modelBytes = observed.slice(mark).filter(({ req }) => /\.(onnx|wasm)(\?|$)/.test(req.url()))
    if (modelBytes.length) throw new Error(`model/runtime re-downloaded: ${modelBytes.map(({ req }) => req.url()).join(', ')}`)
    return { focusAfter: focus, modelOrRuntimeRequestsAfterReload: modelBytes.length }
  })

  phase = 'settle'
  await page.waitForTimeout(2000)
  await snapshotLedger()
  await browser.close()

  // Reconciliation: every observed request (a redirect chain counts once, from its head)
  // must match a ledger row with the same host and the chain's final host; each OPTIONS
  // preflight must pair with an observed POST to the same URL.
  const heads = observed.filter(({ req }) => !req.redirectedFrom())
  const finalOf = (req) => {
    let r = req
    while (r.redirectedTo()) r = r.redirectedTo()
    return r
  }
  const unused = [...ledger.values()]
  const unmatched = []
  const posts = new Map()
  for (const { req } of heads) if (req.method() === 'POST') posts.set(req.url(), (posts.get(req.url()) || 0) + 1)
  const preflights = heads.filter(({ req }) => req.method() === 'OPTIONS')
  const unpairedPreflights = []
  for (const { req, phase: p } of preflights) {
    const left = posts.get(req.url()) || 0
    if (left === 0) unpairedPreflights.push(`${p}: OPTIONS ${req.url()}`)
  }
  let redirectChains = 0
  for (const { req, phase: p } of heads) {
    if (req.method() === 'OPTIONS') continue
    const host = new URL(req.url()).host
    const finalHost = new URL(finalOf(req).url()).host
    if (finalHost !== host) redirectChains++
    let i = unused.findIndex((r) => r.host === host && r.finalHost === finalHost)
    if (i === -1) i = unused.findIndex((r) => r.host === host && r.finalHost === '')
    if (i === -1) unmatched.push(`${p}: ${req.method()} ${req.url().slice(0, 120)} (final host ${finalHost})`)
    else unused.splice(i, 1)
  }
  const downloadRows = [...ledger.values()].filter((r) => /huggingface\.co|hf\.co|cdn\.jsdelivr\.net/.test(r.host)).length
  // Download labels: each model's observed requests match its rows' purpose (the reranker
  // loads lazily, on the first question).
  const purposeCounts = {}
  for (const [model, purpose] of [['multilingual-e5-small', 'embed-model-download'], ['ms-marco-MiniLM-L-2-v2', 'rerank-model-download']]) {
    const requests = heads.filter(({ req }) => req.url().includes(model)).length
    const rows = [...ledger.values()].filter((r) => r.purpose === purpose).length
    purposeCounts[purpose] = { requests, rows }
  }
  const purposeMismatch = Object.values(purposeCounts).some(({ requests, rows }) => requests === 0 || requests !== rows)
  const reconciliation = {
    streamedAnswers,
    purposeCounts,
    observedRequests: heads.length - preflights.length,
    redirectChains,
    preflights: preflights.length,
    ledgerRows: ledger.size,
    workerDownloadRowsInDom: downloadRows,
    matched: heads.length - preflights.length - unmatched.length,
    unmatched,
    unpairedPreflights,
    ledgerRowsNotObserved: unused.length,
  }

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
  console.log(JSON.stringify({ browser: BROWSER, webgpu: WEBGPU, app: APP, flows, ortFromJsDelivr: [...ortUrls], allowlistedWidgetStyle: allowlisted.length, violationsByDirective: byDirective, unexpected, cspBlocked, pageErrors, reconciliation }, null, 2))
  // v1.3: the shared-tier answers above must have been streamed.
  if (streamedAnswers === 0) failed.push({ flow: 'streaming', ok: false, error: 'no streamed answer request seen' })
  if (failed.length || unexpected.length || cspBlocked.length || unmatched.length || unpairedPreflights.length || purposeMismatch) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
