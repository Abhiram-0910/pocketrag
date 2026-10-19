// Step B failure-UI check: provider failure codes → banner copy, action button, focus target.
//
// Manual run, not wired into CI yet (seed for the TODO "CI + E2E" item). Uses the globally
// installed Playwright (no project dependency) against `vite preview` of a production build:
//
//   npm run build && npx vite preview --port 4173 &
//   NODE_PATH=$(npm root -g) node e2e/step-b-failures.cjs
//   SHOTS_DIR=/some/dir NODE_PATH=$(npm root -g) node e2e/step-b-failures.cjs   # + light/dark, 1280/375 screenshots
//
// Phase 2b: failures, timeouts and interruptions are also checked after being restored from
// IndexedDB in a fresh tab (same browser context, so the same history DB): outside every
// live region, verbatim Worker copy, the action button, and a retry adding a receipt row.
//
// Every /answer call is route-mocked — the shared tier is never called live. /models is mocked
// too, except the last scenario: one live /models call with a fake OpenAI key (BYOK, own key),
// which spends one request from this IP's BYOK bucket. Takes ~2 minutes (one scenario waits out
// the 60s answer timeout). Exits 1 if any check fails.
const { chromium } = require('playwright')
const fs = require('fs')
const os = require('os')
const path = require('path')

const APP = process.env.APP_URL || 'http://localhost:4173'
const API = 'https://pocketrag-answer.abhiram-dev.workers.dev'
const SHOTS_DIR = process.env.SHOTS_DIR
const CORS = {
  'Access-Control-Allow-Origin': APP,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

// The Worker's fixed copy per failure (worker/src/index.ts).
const COPY = {
  key: "The provider rejected your API key. Check that it's correct, active, and has access to this model.",
  sharedRl: 'The free shared tier is at capacity right now. Try again later, or use your own API key.',
  ownRl: 'Your provider account hit its rate limit, quota, or credit balance. Wait a moment or check your plan.',
  req: 'The provider rejected this request. The selected model may not be available to your key; try another.',
  sharedUn: "The free tier couldn't respond right now. Try again in a moment, or use your own API key.",
  ownUn: "The provider couldn't respond right now. Please try again in a moment.",
  exp: "This provider isn't fully supported yet. Please try Gemini or OpenAI for now — we're working on it.",
  ours: "You've hit today's request limit. Please try again tomorrow.",
}

// A one-page text PDF, built here so no binary fixture lives in the repo.
function writeTestPdf() {
  const lines = [
    'The mitochondrion is the powerhouse of the cell.',
    'It produces ATP through cellular respiration.',
    'Ribosomes synthesize proteins from messenger RNA.',
    "The nucleus stores the cell's genetic material.",
  ]
  const stream = `BT /F1 14 Tf 72 720 Td 18 TL ${lines.map((l) => `(${l}) Tj T*`).join(' ')} ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((obj, i) => {
    const offset = pdf.length
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`
    return offset
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrag-e2e-')), 'cells.pdf')
  fs.writeFileSync(file, pdf, 'latin1')
  return file
}

const HANG = Symbol('hang')
// Routes left hanging on purpose, released once the app has given up on them, so no
// intercepted request outlives its scenario.
const hung = []
let answerHandler = null
let answerCalls = 0
const results = []
const failures = []
const check = (ok, msg) => ok || failures.push(msg)

const successFor = (tag) => (req) => {
  const body = JSON.parse(req.postData() || '{}')
  const ids = [...new Set((body.chunks || []).map((c) => c.documentId))]
  return {
    status: 200,
    body: { answer: `Retried answer ${tag} (Doc 1, page 1).`, groundingWarning: false, docLabels: ids.map((d, i) => ({ label: i + 1, documentId: d })) },
  }
}

async function main() {
  const browser = await chromium.launch()
  // One context, so the extra tabs below share the same IndexedDB. Routes stay per page
  // (each tab gets the same /answer mock): with a context-level route, the live /models
  // check's response was intermittently never reported to page.waitForResponse.
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  const newTab = async (init) => {
    const tab = await context.newPage()
    tab.on('pageerror', (e) => pageErrors.push(`tab: ${String(e)}`))
    await tab.route(`${API}/answer`, routeAnswer)
    if (init) await init(tab)
    await tab.goto(APP)
    return tab
  }
  // Ancestors that would announce an element: aria-live containers and alert/status/log roles.
  const announcingAncestors = (locator) =>
    locator.evaluate((el) => {
      let n = 0
      for (let a = el; a; a = a.parentElement) {
        const role = a.getAttribute('role')
        if (a.hasAttribute('aria-live') || role === 'alert' || role === 'status' || role === 'log') n++
      }
      return n
    })

  async function routeAnswer(route) {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    answerCalls++
    if (!answerHandler) return route.abort() // never reach the live shared tier
    const reply = answerHandler(req)
    if (reply === HANG) return void hung.push(route) // pending until the app's own 60s timeout aborts it
    return route.fulfill({ status: reply.status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(reply.body) })
  }
  await page.route(`${API}/answer`, routeAnswer)
  const MODELS = { models: [{ id: 'model-a', displayName: 'model-a' }, { id: 'model-b', displayName: 'model-b' }] }
  // Page-level (only this tab fetches models), so the live check below can unroute it.
  await page.route(`${API}/models`, (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    return route.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(MODELS) })
  })

  await context.addInitScript(() => localStorage.setItem('pocketrag:has-visited-app', 'true'))
  await page.goto(APP)
  await page.setInputFiles('input[type="file"][accept="application/pdf"]', writeTestPdf())
  const queryInput = page.locator('form input[type="text"]')
  await page.waitForFunction(() => document.querySelector('form input[type="text"]')?.disabled === false, null, {
    timeout: 300_000,
  })

  const byokToggle = page.getByLabel('Use your own API key')
  const search = page.getByRole('button', { name: 'Search' })
  const modelSelect = page.getByLabel('Model', { exact: true })
  const searchDisabled = () => search.isDisabled()
  const focused = () =>
    page.evaluate(() => {
      const a = document.activeElement
      if (!a) return null
      if (a === document.querySelector('form input[type="text"]')) return 'question input'
      return a.getAttribute('aria-label') || a.tagName
    })
  const retryAnswer = (tag) =>
    page
      .getByText(`Retried answer ${tag}`)
      .first()
      .waitFor({ timeout: 60_000 })
      .then(() => true, () => false)

  // Light + dark, desktop + 375px, of one element; records horizontal page overflow.
  async function shot(name, locator) {
    if (!SHOTS_DIR) return
    fs.mkdirSync(SHOTS_DIR, { recursive: true })
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme })
      for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: 900 })
        await locator.scrollIntoViewIfNeeded()
        await locator.screenshot({ path: path.join(SHOTS_DIR, `${name}-${colorScheme}-${width}.png`) })
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
        results.push({ screenshot: `${name}-${colorScheme}-${width}.png`, horizontalOverflowPx: overflow })
        check(overflow <= 0, `${name} ${colorScheme} ${width}px: page scrolls horizontally by ${overflow}px`)
      }
    }
    await page.emulateMedia({ colorScheme: 'light' })
    await page.setViewportSize({ width: 1280, height: 900 })
  }

  async function ask(name, handler, expected) {
    answerHandler = handler
    const before = answerCalls
    // Mark the always-mounted live containers before the error appears.
    await page.evaluate(() => document.querySelectorAll('[aria-live]').forEach((el) => el.setAttribute('data-pre', '1')))
    await queryInput.fill(`What does the mitochondrion do? (${name})`)
    await search.click()
    const banner = page.locator('[aria-live="polite"] p', { hasText: expected.text.slice(0, 30) }).first()
    await banner.waitFor({ timeout: 120_000 })
    const text = (await banner.innerText()).replace(/\s+/g, ' ').trim()
    const buttons = await banner.locator('button').allInnerTexts()
    const live = await banner.evaluate((p) => {
      let n = 0
      let pre = false
      for (let el = p; el; el = el.parentElement) {
        const role = el.getAttribute('role')
        if (el.hasAttribute('aria-live') || role === 'alert' || role === 'status' || role === 'log') {
          n++
          if (el.hasAttribute('aria-live')) pre = el.getAttribute('data-pre') === '1'
        }
      }
      return { liveAncestors: n, containerPreMounted: pre }
    })
    const row = { scenario: name, text, buttons: buttons.join(', ') || '(none)', calls: answerCalls - before, ...live }
    check(text.startsWith(expected.text), `${name}: banner text`)
    const wantButton = expected.button ?? expected.click ?? null
    check((buttons[0] ?? null) === wantButton, `${name}: button ${buttons[0]} != ${wantButton}`)
    check(live.liveAncestors === 1 && live.containerPreMounted, `${name}: not announced exactly once`)
    check(row.calls === 1, `${name}: ${row.calls} /answer calls`)
    if (expected.shot) await shot(expected.shot, banner.locator('xpath=..'))
    if (expected.beforeClick) expected.beforeClick()
    const callsBeforeClick = answerCalls
    if (expected.click) {
      await banner.getByRole('button', { name: expected.click }).click()
      await page.waitForTimeout(300)
      if (expected.click !== 'Try again') row.focusAfterClick = await focused()
    }
    if (expected.after) Object.assign(row, await expected.after())
    if (expected.focus) check(row.focusAfterClick === expected.focus, `${name}: focus on ${row.focusAfterClick}`)
    if (expected.click === 'Try again') row.retryRequestsSent = answerCalls - callsBeforeClick
    results.push(row)
    return row
  }

  const err = (status, body) => () => ({ status, body })
  // A failure banner's "Try again": exactly one retry, retried answer shown, no stale
  // banner left beside it, and focus on the question input (not <body>).
  const retrySucceeds = (tag, staleText) => ({
    click: 'Try again',
    focus: 'question input',
    beforeClick: () => {
      answerHandler = successFor(tag)
    },
    after: async () => ({
      retryAnswerShown: await retryAnswer(tag),
      staleBannerAfterRetry: await page.locator('[aria-live="polite"] p', { hasText: staleText }).count(),
      focusAfterClick: await focused(),
    }),
  })

  // ---- Shared tier (all mocked) ----
  await ask('provider_rate_limited / shared', err(502, { error: COPY.sharedRl, code: 'provider_rate_limited', source: 'shared' }), {
    text: COPY.sharedRl,
    shot: 'shared-rate-limited',
    click: 'Use your own key',
    focus: 'Provider',
    after: async () => ({ byokChecked: await byokToggle.isChecked(), searchDisabledAfter: await searchDisabled() }),
  })
  await byokToggle.uncheck()

  await ask('provider_unavailable / shared copy', err(502, { error: COPY.sharedUn, code: 'provider_unavailable' }), {
    text: COPY.sharedUn,
    ...retrySucceeds('shared', 'free tier'),
  })

  // The pre-existing timeout banner's "Try again" goes through the same retry path.
  answerHandler = () => HANG
  await queryInput.fill('What does the mitochondrion do? (timeout)')
  await search.click()
  const timeoutBanner = page.getByText('This is taking longer than expected.')
  await timeoutBanner.waitFor({ timeout: 90_000 })
  // The timed-out turn is already saved: a second tab restores it as "timed out", with a
  // Try again, outside every live region.
  {
    const tab = await newTab()
    const restored = tab.locator('p', { hasText: 'This answer timed out.' }).first()
    await restored.waitFor({ timeout: 30_000 })
    const row = {
      scenario: 'restored timed-out turn (second tab)',
      text: (await restored.innerText()).replace(/\s+/g, ' ').trim(),
      buttons: (await restored.locator('button').allInnerTexts()).join(', ') || '(none)',
      announcingAncestors: await announcingAncestors(restored),
    }
    check(row.buttons === 'Try again', `restored timeout: buttons ${row.buttons}`)
    check(row.announcingAncestors === 0, `restored timeout: ${row.announcingAncestors} announcing ancestors`)
    results.push(row)
    await tab.close()
  }
  answerHandler = successFor('timeout')
  await page.getByRole('button', { name: 'Try again' }).click()
  const timeoutRow = { scenario: 'timeout → Try again', retryAnswerShown: await retryAnswer('timeout'), focusAfterClick: await focused() }
  check(timeoutRow.focusAfterClick === 'question input', `timeout retry: focus on ${timeoutRow.focusAfterClick}`)
  results.push(timeoutRow)
  for (const route of hung.splice(0)) await route.abort().catch(() => {})

  await ask('our own 429 (resetAt)', err(429, { error: COPY.ours, resetAt: '2026-10-20T00:00:00.000Z' }), {
    text: "You've hit today's request limit",
  })
  await ask('old Worker body, no code', err(502, { error: COPY.exp }), { text: COPY.exp })

  // ---- BYOK OpenAI (mocked /models + /answer) ----
  await byokToggle.check()
  await page.getByLabel('Provider', { exact: true }).selectOption('openai')
  const keyInput = page.getByLabel('OpenAI API key')
  await keyInput.fill('sk-fake-stepb-0000000000')
  await page.getByRole('button', { name: 'Fetch models' }).click()
  await modelSelect.waitFor()
  const fetchRow = {
    scenario: 'model fetch (openai, mocked)',
    selectedAfterFetch: await modelSelect.inputValue(),
    placeholderText: await modelSelect.locator('option:checked').innerText(),
    searchDisabledBeforeChoice: await searchDisabled(),
  }
  check(fetchRow.selectedAfterFetch === '' && fetchRow.searchDisabledBeforeChoice, 'model fetch: auto-selected a model')
  results.push(fetchRow)
  await shot('byok-choose-model', modelSelect.locator('xpath=ancestor::div[contains(@class, "rounded border")][1]'))
  await modelSelect.selectOption('model-b')

  await ask('key_rejected', err(502, { error: COPY.key, code: 'key_rejected' }), {
    text: COPY.key,
    shot: 'key-rejected',
    click: 'Check your key',
    focus: 'OpenAI API key',
    after: async () => {
      const r = { modelSelectVisible: await modelSelect.isVisible(), searchDisabledAfter: await searchDisabled() }
      // Same key, no retyping — Fetch models must still work.
      r.keyUnchanged = (await keyInput.inputValue()) === 'sk-fake-stepb-0000000000'
      await page.getByRole('button', { name: 'Fetch models' }).click()
      await modelSelect.waitFor()
      r.refetchSameKeyWorked = await modelSelect.isVisible()
      check(r.keyUnchanged && r.refetchSameKeyWorked && !r.modelSelectVisible, 'key_rejected: key/model reset')
      await modelSelect.selectOption('model-b')
      return r
    },
  })

  await ask('request_rejected', err(502, { error: COPY.req, code: 'request_rejected' }), {
    text: COPY.req,
    click: 'Choose another model',
    focus: 'Model',
    after: async () => ({ modelStillSelected: await modelSelect.inputValue() }),
  })
  await ask('provider_rate_limited / own', err(502, { error: COPY.ownRl, code: 'provider_rate_limited', source: 'own' }), {
    text: COPY.ownRl,
  })
  await ask('provider_unavailable / own copy', err(502, { error: COPY.ownUn, code: 'provider_unavailable' }), {
    text: COPY.ownUn,
    ...retrySucceeds('own', 'provider couldn'),
  })

  // ---- Experimental provider, unclassified ----
  await page.getByLabel('Provider', { exact: true }).selectOption('anthropic')
  await page.getByLabel('Claude API key').fill('sk-ant-fake-stepb-000000')
  await page.getByRole('button', { name: 'Fetch models' }).click()
  await modelSelect.waitFor()
  await modelSelect.selectOption('model-a')
  await ask('Experimental unclassified (anthropic)', err(502, { error: COPY.exp, code: 'provider_unavailable' }), {
    text: COPY.exp,
    button: 'Try again',
  })

  // ---- Live: fake OpenAI key against the deployed Worker's /models (own key, never shared) ----
  // In a fresh tab with no routes at all, so nothing but the browser stands between the app
  // and the production Worker: on the long-lived main page, whose /answer requests are
  // intercepted (and one left hanging by the timeout scenario), this real request
  // intermittently never completed in Chromium (seen in-flight in the app's own egress log
  // for 30s+), while the same call from curl answered in ~1s every time.
  answerHandler = null
  {
    const live = await context.newPage()
    live.on('pageerror', (e) => pageErrors.push(`live tab: ${String(e)}`))
    await live.goto(APP)
    await live.getByLabel('Use your own API key').check()
    await live.getByLabel('Provider', { exact: true }).selectOption('openai')
    await live.getByLabel('OpenAI API key').fill('sk-fake-stepb-live-0000000000')
    const liveResp = live.waitForResponse((r) => r.url() === `${API}/models` && r.request().method() === 'POST')
    await live.getByRole('button', { name: 'Fetch models' }).click()
    const resp = await liveResp
    const liveBody = await resp.json()
    const liveBanner = live.locator('[aria-live="polite"] p', { hasText: 'rejected your API key' }).first()
    await liveBanner.waitFor({ timeout: 30_000 })
    await liveBanner.getByRole('button', { name: 'Check your key' }).click()
    const liveRow = {
      scenario: 'LIVE /models, fake OpenAI key',
      httpStatus: resp.status(),
      code: liveBody.code,
      text: (await liveBanner.innerText()).replace(/\s+/g, ' ').trim(),
      focusAfterClick: await live.evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName),
    }
    check(liveRow.httpStatus === 502 && liveRow.code === 'key_rejected', 'live: not a key_rejected 502')
    check(liveRow.focusAfterClick === 'OpenAI API key', `live: focus on ${liveRow.focusAfterClick}`)
    results.push(liveRow)
    await live.close()
  }

  // ---- Restored from IndexedDB in a fresh tab (Phase 2b) ----
  // The open conversation's leaf is the Experimental-provider failure above. A fresh tab
  // (shared tier — the BYOK key never persists) restores it outside every live region.
  {
    const tab = await newTab()
    const banner = tab.locator('p', { hasText: COPY.exp.slice(0, 30) }).first()
    await banner.waitFor({ timeout: 30_000 })
    const row = {
      scenario: 'restored failure (fresh tab)',
      text: (await banner.innerText()).replace(/\s+/g, ' ').trim(),
      buttons: (await banner.locator('button').allInnerTexts()).join(', ') || '(none)',
      announcingAncestors: await announcingAncestors(banner),
    }
    check(row.text.startsWith(COPY.exp), 'restored failure: not the verbatim Worker copy')
    check(row.buttons === 'Try again', `restored failure: buttons ${row.buttons}`)
    check(row.announcingAncestors === 0, `restored failure: ${row.announcingAncestors} announcing ancestors`)

    // Try again rebuilds the request from the turn's citations; the receipt gains a row.
    answerHandler = successFor('restored')
    const callsBefore = answerCalls
    await banner.getByRole('button', { name: 'Try again' }).click()
    await tab.getByText('Retried answer restored').first().waitFor({ timeout: 60_000 })
    await tab.waitForTimeout(300)
    row.retryRequestsSent = answerCalls - callsBefore
    // The question input if it can take focus; in this fresh tab no document is selected,
    // so it's disabled and focus goes to the answer area instead — never <body>.
    row.inputDisabled = await tab.locator('#question-input').isDisabled()
    row.focusAfterClick = await tab.evaluate(() => {
      const id = document.activeElement?.id
      return id === 'question-input' ? 'question input' : id === 'answer-area' ? 'answer area' : document.activeElement?.tagName
    })
    const receiptRows = tab
      .locator('div.rounded.border', { hasText: 'Retried answer restored' })
      .first()
      .locator('details[data-receipt] [data-egress-id]')
    row.receiptRowOutcomes = await receiptRows.evaluateAll((els) => els.map((el) => el.getAttribute('data-outcome')))
    check(row.retryRequestsSent === 1, `restored retry: ${row.retryRequestsSent} requests`)
    check(row.focusAfterClick === (row.inputDisabled ? 'answer area' : 'question input'), `restored retry: focus on ${row.focusAfterClick}`)
    check(
      JSON.stringify(row.receiptRowOutcomes) === JSON.stringify(['http-error', 'ok']),
      `restored retry: receipt rows ${row.receiptRowOutcomes}`,
    )
    results.push(row)

    // Interrupted: a request still in flight when the tab closes. A tab opened with the
    // clock 6 minutes on (past STALE_PENDING_MS) sweeps it to "interrupted".
    answerHandler = () => HANG
    const pendingBefore = answerCalls
    // Restoring selects no document; a new question needs one.
    await tab.locator('li button', { hasText: 'cells.pdf' }).first().click()
    await tab.locator('#question-input').fill('What does the mitochondrion do? (interrupted)')
    await tab.getByRole('button', { name: 'Search' }).click()
    for (let i = 0; i < 100 && answerCalls === pendingBefore; i++) await tab.waitForTimeout(300)
    await tab.close()
    const later = await newTab((t) => t.clock.install({ time: Date.now() + 6 * 60_000 }))
    const interrupted = later.locator('p', { hasText: 'This answer was interrupted' }).first()
    await interrupted.waitFor({ timeout: 30_000 })
    const irow = {
      scenario: 'interrupted (tab closed mid-request, reopened 6 min later)',
      requestWasInFlight: answerCalls > pendingBefore,
      text: (await interrupted.innerText()).replace(/\s+/g, ' ').trim(),
      buttons: (await interrupted.locator('button').allInnerTexts()).join(', ') || '(none)',
      announcingAncestors: await announcingAncestors(interrupted),
    }
    check(irow.requestWasInFlight, 'interrupted: the request never went out')
    check(irow.buttons === 'Ask again', `interrupted: buttons ${irow.buttons}`)
    check(irow.announcingAncestors === 0, `interrupted: ${irow.announcingAncestors} announcing ancestors`)
    results.push(irow)
    await later.close()
  }

  check(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`)
  console.log(JSON.stringify({ results, answerCalls, pageErrors, failures }, null, 2))
  await browser.close()
  if (failures.length) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  console.log(JSON.stringify({ results, failures }, null, 2))
  process.exit(1)
})
