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
  region: "The free shared tier isn't available in your region because of Google's terms. Use your own API key instead.",
}
// ByokPanel's shared-tier line, shown only while the shared tier is active.
const DISCLOSURE =
  "Free shared tier: Google uses what's sent and the answers to improve its products, and human reviewers may read them. Use your own paid key to avoid that."


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
  // Realistic per-provider lists, junk included; the picker (src/lib/modelLadder.ts) ranks them.
  const MODEL_LISTS = {
    openai: ['gpt-5-nano', 'gpt-5-mini', 'gpt-5.1', 'gpt-5.1-codex-mini', 'gpt-4o-mini-search-preview', 'o3', 'gpt-4o-2024-08-06'],
    anthropic: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-sonnet-4-5-20250929', 'claude-fable-5-1'],
    grok: ['grok-2-image-1212', 'grok-code-fast-1'], // nothing qualifies → manual entry
  }
  // Page-level (only this tab fetches models), so the live check below can unroute it.
  await page.route(`${API}/models`, (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const { provider } = JSON.parse(route.request().postData() || '{}')
    const models = (MODEL_LISTS[provider] ?? []).map((id) => ({ id, displayName: id }))
    return route.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ models }) })
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
  // The picker's sentence (always-mounted live region) and its buttons.
  const proposal = page.locator('p[aria-live="polite"]').filter({ hasText: /We'll use|Using |Couldn't pick/ })
  const proposalText = async () => (await proposal.innerText()).replace(/\s+/g, ' ').trim()
  const findModel = () => page.getByRole('button', { name: 'Find a model' }).click()
  const useModel = page.getByRole('button', { name: 'Use this model' })
  const higher = page.getByRole('button', { name: 'Use a higher model' })
  const lower = page.getByRole('button', { name: 'Use a lower model' })
  const changeModel = page.getByRole('button', { name: 'Change', exact: true })
  // The question box itself (the Search button is also disabled by an empty question).
  // Polls briefly: the key config reaches QueryPanel through an effect, a tick after the click.
  const questionDisabled = (want = true) =>
    page
      .waitForFunction((w) => document.querySelector('form input[type="text"]').disabled === w, want, { timeout: 3000 })
      .then(() => want, () => !want)
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
    // The previous banner may carry the same text; wait for this question's request first.
    for (let i = 0; i < 100 && answerCalls === before; i++) await page.waitForTimeout(100)
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

  // The shared tier's EEA/CH/UK refusal: a 403, not a 502, with the same action.
  const disclosure = page.getByText(DISCLOSURE, { exact: true })
  {
    const row = { scenario: 'shared-tier disclosure', visibleOnShared: await disclosure.isVisible() }
    await byokToggle.check()
    row.visibleOnOwnKey = await disclosure.isVisible()
    await byokToggle.uncheck()
    row.visibleAgainOnShared = await disclosure.isVisible()
    check(row.visibleOnShared && !row.visibleOnOwnKey && row.visibleAgainOnShared, `disclosure visibility ${JSON.stringify(row)}`)
    results.push(row)
  }
  await ask('region_restricted / shared (403)', err(403, { error: COPY.region, code: 'region_restricted' }), {
    text: COPY.region,
    shot: 'region-restricted',
    click: 'Use your own key',
    focus: 'Provider',
    after: async () => ({ byokChecked: await byokToggle.isChecked(), disclosureVisibleAfter: await disclosure.isVisible() }),
  })
  check(results.at(-1).byokChecked === true && results.at(-1).disclosureVisibleAfter === false, 'region_restricted: own key not switched on')
  check(results.at(-1).text === COPY.region + ' Showing raw matched passages below. Use your own key', `region_restricted: banner not verbatim: ${results.at(-1).text}`)
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

  // Step D: a known reset gives a timed "Try again" (this resetAt is already past, so it's
  // enabled from the start). Countdowns themselves are checked in stepD below.
  await ask('our own 429 (resetAt)', err(429, { error: COPY.ours, resetAt: '2026-10-20T00:00:00.000Z' }), {
    text: "You've hit today's request limit",
    button: 'Try again',
  })
  await ask('old Worker body, no code', err(502, { error: COPY.exp }), { text: COPY.exp })

  // ---- BYOK OpenAI (mocked /models + /answer): the automatic model picker ----
  await byokToggle.check()
  await page.getByLabel('Provider', { exact: true }).selectOption('openai')
  const keyInput = page.getByLabel('OpenAI API key')
  await keyInput.fill('sk-fake-stepb-0000000000')
  // Every text the picker's live region is handed, in order.
  await page.evaluate(() => {
    const el = document.querySelector('p[aria-live="polite"]')
    window.__pickerLive = []
    new MutationObserver(() => window.__pickerLive.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true })
  })
  await findModel()
  await useModel.waitFor()
  {
    const row = { scenario: 'picker: propose → higher → lower → confirm (openai, mocked)' }
    row.first = await proposalText()
    row.focusFirst = await page.evaluate(() => document.activeElement?.textContent)
    row.searchDisabledBeforeConfirm = await questionDisabled()
    row.modelSelects = await page.locator('select[aria-label="Model"]').count()
    row.optionsInPanel = await page.getByLabel('Provider', { exact: true }).locator('xpath=ancestor::div[contains(@class, "rounded border")][1]').locator('option').count()
    check(row.first === "We'll use gpt-5-mini (Balanced) · Recommended", `picker: first proposal ${row.first}`)
    check(row.focusFirst === 'Use this model', `picker: focus after find ${row.focusFirst}`)
    check(row.searchDisabledBeforeConfirm, 'picker: search enabled before a model was confirmed')
    check(row.modelSelects === 0 && row.optionsInPanel === 5, `picker: a model list is rendered (${row.modelSelects} selects, ${row.optionsInPanel} options)`)
    check(await page.getByText('Higher models usually cost more per question.').isVisible(), 'picker: cost note missing')
    await shot('byok-model-proposal', proposal.locator('xpath=ancestor::div[contains(@class, "rounded border")][1]'))
    // 360px: no horizontal scroll. README_SHOTS=docs/screenshots writes the README pair.
    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 900 })
      const panel = proposal.locator('xpath=ancestor::div[contains(@class, "rounded border")][1]')
      await panel.scrollIntoViewIfNeeded()
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      check(overflow <= 0, `picker ${width}px: page scrolls horizontally by ${overflow}px`)
      row[`overflowPx${width}`] = overflow
      if (process.env.README_SHOTS) await panel.screenshot({ path: path.join(process.env.README_SHOTS, `byok-model-proposal-${width}.png`) })
    }
    await page.setViewportSize({ width: 1280, height: 900 })
    await higher.click()
    row.higher = await proposalText()
    row.higherDisabledAtTop = await higher.isDisabled()
    row.topNote = await page.getByText('This is the highest model we found for your key.').isVisible()
    row.focusAfterHigher = await page.evaluate(() => document.activeElement?.textContent)
    row.searchDisabledAfterHigher = await questionDisabled()
    check(row.higher === "We'll use gpt-5.1 (Large)" && row.higherDisabledAtTop && row.topNote, `picker: top ${JSON.stringify(row)}`)
    check(row.focusAfterHigher === 'Use this model', `picker: focus after higher on ${row.focusAfterHigher}`)
    await lower.click()
    await lower.click()
    row.bottom = await proposalText()
    row.lowerDisabledAtBottom = await lower.isDisabled()
    row.bottomNote = await page.getByText('This is the lowest model we found for your key.').isVisible()
    check(row.bottom === "We'll use gpt-5-nano (Light)" && row.lowerDisabledAtBottom && row.bottomNote, `picker: bottom ${JSON.stringify(row)}`)
    // Keyboard only from here: Tab to "Use a higher model", Enter, then Enter on the focused confirm.
    await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')
    row.backToRecommended = await proposalText()
    await page.keyboard.press('Enter')
    row.confirmed = await proposalText()
    row.focusAfterConfirm = await page.evaluate(() => document.activeElement?.textContent)
    row.searchEnabledAfterConfirm = !(await questionDisabled(false))
    check(row.backToRecommended === "We'll use gpt-5-mini (Balanced) · Recommended", `picker: keyboard higher ${row.backToRecommended}`)
    check(row.confirmed === 'Using gpt-5-mini.' && row.focusAfterConfirm === 'Change' && row.searchEnabledAfterConfirm, `picker: confirm ${JSON.stringify(row)}`)
    row.announcements = await page.evaluate(() => window.__pickerLive.filter((t, i, a) => t !== a[i - 1]))
    const want = [
      "We'll use gpt-5-mini (Balanced) · Recommended",
      "We'll use gpt-5.1 (Large)",
      "We'll use gpt-5-mini (Balanced) · Recommended",
      "We'll use gpt-5-nano (Light)",
      "We'll use gpt-5-mini (Balanced) · Recommended",
      'Using gpt-5-mini.',
    ]
    check(JSON.stringify(row.announcements.filter(Boolean)) === JSON.stringify(want), `picker: announcements ${JSON.stringify(row.announcements)}`)
    results.push(row)
  }

  await ask('key_rejected', err(502, { error: COPY.key, code: 'key_rejected' }), {
    text: COPY.key,
    shot: 'key-rejected',
    click: 'Check your key',
    focus: 'OpenAI API key',
    after: async () => {
      const r = { proposalAfter: await proposal.count(), searchDisabledAfter: await questionDisabled() }
      // Same key, no retyping — Find a model must still work.
      r.keyUnchanged = (await keyInput.inputValue()) === 'sk-fake-stepb-0000000000'
      await findModel()
      await useModel.waitFor()
      r.refindSameKeyWorked = (await proposalText()).startsWith("We'll use gpt-5-mini")
      check(r.keyUnchanged && r.refindSameKeyWorked && r.proposalAfter === 0 && r.searchDisabledAfter, `key_rejected: key/model reset ${JSON.stringify(r)}`)
      await useModel.click()
      return r
    },
  })

  // Model rejected → the picker reopens one rung LOWER, unconfirmed, focus on confirm.
  await ask('request_rejected', err(502, { error: COPY.req, code: 'request_rejected' }), {
    text: COPY.req,
    click: 'Choose another model',
    focus: 'BUTTON',
    after: async () => {
      const r = {
        proposalAfterReject: await proposalText(),
        focusText: await page.evaluate(() => document.activeElement?.textContent),
        rejectedNote: await page.getByText('The provider rejected the last request with').isVisible(),
        searchDisabledUntilConfirm: await questionDisabled(),
      }
      check(r.proposalAfterReject === "We'll use gpt-5-nano (Light)" && r.focusText === 'Use this model', `request_rejected: step down ${JSON.stringify(r)}`)
      check(r.rejectedNote && r.searchDisabledUntilConfirm, `request_rejected: note/search ${JSON.stringify(r)}`)
      await useModel.click()
      r.confirmedLower = await proposalText()
      check(r.confirmedLower === 'Using gpt-5-nano.', `request_rejected: confirm ${r.confirmedLower}`)
      return r
    },
  })
  // Manual entry: validated by the model-id pattern; a rejected manual model reopens the input.
  {
    const row = { scenario: 'picker: manual model ID' }
    await changeModel.click()
    await page.getByText('Enter a model ID yourself').click()
    const manual = page.getByLabel('Model ID')
    await manual.fill('bad id!')
    await page.getByRole('button', { name: 'Use this ID' }).click()
    row.invalidError = await page.getByText('A model ID is 1-128 letters').isVisible()
    row.searchDisabledOnInvalid = await questionDisabled()
    await manual.fill('my-custom-model')
    await manual.press('Enter')
    row.confirmed = await proposalText()
    row.searchEnabled = !(await questionDisabled(false))
    check(row.invalidError && row.searchDisabledOnInvalid && row.confirmed === 'Using my-custom-model.' && row.searchEnabled, `manual: ${JSON.stringify(row)}`)
    results.push(row)
  }
  await ask('request_rejected (manual model)', err(502, { error: COPY.req, code: 'request_rejected' }), {
    text: COPY.req,
    click: 'Choose another model',
    focus: 'Model ID',
  })
  await page.getByLabel('Model ID').fill('gpt-5-mini')
  await page.getByRole('button', { name: 'Use this ID' }).click()
  await ask('provider_rate_limited / own', err(502, { error: COPY.ownRl, code: 'provider_rate_limited', source: 'own' }), {
    text: COPY.ownRl,
  })
  await ask('provider_unavailable / own copy', err(502, { error: COPY.ownUn, code: 'provider_unavailable' }), {
    text: COPY.ownUn,
    ...retrySucceeds('own', 'provider couldn'),
  })

  // ---- No rung qualifies → manual entry, focused ----
  await page.getByLabel('Provider', { exact: true }).selectOption('grok')
  await page.getByLabel('Grok API key').fill('xai-fake-stepb-000000000')
  await findModel()
  await proposal.waitFor()
  {
    const row = { scenario: 'picker: nothing qualifies (grok, mocked)', text: await proposalText(), focus: await focused() }
    check(row.text === "Couldn't pick a model automatically. Enter a model ID below." && row.focus === 'Model ID', `no rungs: ${JSON.stringify(row)}`)
    check(await questionDisabled(), 'no rungs: search enabled')
    results.push(row)
  }

  // ---- Experimental provider, unclassified ----
  await page.getByLabel('Provider', { exact: true }).selectOption('anthropic')
  await page.getByLabel('Claude API key').fill('sk-ant-fake-stepb-000000')
  await findModel()
  await useModel.waitFor()
  check((await proposalText()) === "We'll use claude-sonnet-5-5 (Balanced) · Recommended", `anthropic proposal: ${await proposalText()}`)
  await useModel.click()
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
    await live.getByRole('button', { name: 'Find a model' }).click()
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

  await stepD(browser, pageErrors)

  check(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`)
  console.log(JSON.stringify({ results, answerCalls, pageErrors, failures }, null, 2))
  await browser.close()
  if (failures.length) process.exit(1)
}

// ---- Step D: retry countdowns, under Playwright's clock ----
// Own context: a fixed zone (IST, UTC+5:30 all year) so local times are exact, and the
// clock installed before load. Time flows normally until fastForward jumps it. All
// mocked; the Worker's resetAt values are what breaker.ts computes for these instants.
async function stepD(browser, pageErrors) {
  const T0 = new Date('2026-10-31T23:00:00.000Z') // the night before US DST ends
  const MIDNIGHT_PDT = '2026-11-01T07:00:00.000Z' // = 12:30 PM IST
  const MIDNIGHT_PST = '2026-11-02T08:00:00.000Z' // = 1:30 PM IST
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Kolkata', locale: 'en-US' })
  await context.addInitScript(() => localStorage.setItem('pocketrag:has-visited-app', 'true'))
  let handler = null
  let calls = 0
  const route = async (r) => {
    const req = r.request()
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS })
    if (req.url().endsWith('/models')) {
      return r.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ models: [{ id: 'gpt-5-mini', displayName: 'gpt-5-mini' }] }) })
    }
    calls++
    if (!handler) return r.abort()
    const reply = handler(req)
    return r.fulfill({ status: reply.status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(reply.body) })
  }
  await context.route(`${API}/**`, route)
  const page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(`stepD: ${String(e)}`))
  await page.clock.install({ time: T0 })
  await page.goto(APP)
  await page.setInputFiles('input[type="file"][accept="application/pdf"]', writeTestPdf())
  await page.waitForFunction(() => document.querySelector('form input[type="text"]')?.disabled === false, null, { timeout: 300_000 })
  const input = page.locator('form input[type="text"]')
  const ticker = page.locator('p[aria-hidden="true"]', { hasText: 'Try again in' })
  const err = (status, body) => () => ({ status, body })

  // Records each aria-live container's text on every mutation, so we can count what a
  // screen reader would be handed.
  const watchLive = () =>
    page.evaluate(() => {
      window.__live = []
      window.__liveObs?.disconnect()
      const regions = [...document.querySelectorAll('[aria-live]')]
      window.__liveObs = new MutationObserver(() => {
        regions.forEach((el, i) => {
          const t = el.textContent
          const log = (window.__live[i] ||= [])
          if (log.at(-1) !== t) log.push(t)
        })
      })
      regions.forEach((el) => window.__liveObs.observe(el, { subtree: true, childList: true, characterData: true, attributes: true }))
    })
  // Distinct non-empty texts of the region holding the banner (start, then any change).
  const liveChanges = (needle) =>
    page.evaluate((n) => (window.__live.find((log) => log.some((t) => t.includes(n))) || []).filter((t) => t.includes(n)), needle)

  async function askD(name, reply, expect) {
    handler = reply
    const before = calls
    await watchLive()
    await input.fill(`What does the mitochondrion do? (D: ${name})`)
    await page.getByRole('button', { name: 'Search' }).click()
    // Two scenarios in a row can share a banner prefix: wait for this one's request (the
    // app clears the previous banner before sending), so the locator can't match the old one.
    for (let i = 0; i < 300 && calls === before; i++) await page.waitForTimeout(100)
    await page.waitForTimeout(300)
    const banner = page.locator('[aria-live="polite"] p', { hasText: expect.text.slice(0, 30) }).first()
    await banner.waitFor({ timeout: 60_000 })
    const row = {
      scenario: `Step D: ${name}`,
      text: (await banner.innerText()).replace(/\s+/g, ' ').trim(),
      buttons: await banner.locator('button').allInnerTexts(),
      ariaDisabled: await banner.locator('button').first().getAttribute('aria-disabled').catch(() => null),
      tickerVisible: await ticker.isVisible(),
      calls: calls - before,
    }
    check(row.calls === 1, `${name}: ${row.calls} /answer calls`)
    for (const piece of expect.contains ?? [expect.text]) check(row.text.includes(piece), `${name}: banner lacks ${JSON.stringify(piece)}: ${row.text}`)
    if (expect.buttons) check(JSON.stringify(row.buttons.map((b) => b.replace(/\d{1,2}:\d{2}\s?[AP]M/, 'TIME'))) === JSON.stringify(expect.buttons), `${name}: buttons ${JSON.stringify(row.buttons)}`)
    check(row.tickerVisible === Boolean(expect.ticker), `${name}: ticker visible ${row.tickerVisible}`)
    results.push(row)
    return { row, banner }
  }

  // A. Breaker below the cap: ticks, enables at zero, announces only at start and zero.
  {
    const name = 'breaker 120 s (shared, no hint)'
    const { row, banner } = await askD(
      name,
      err(502, { error: COPY.sharedRl, code: 'provider_rate_limited', source: 'shared', retryAfterSeconds: 120, resetAt: MIDNIGHT_PDT }),
      {
        text: COPY.sharedRl,
        contains: [COPY.sharedRl, 'PocketRAG will try Google again at', "If the free tier's daily quota is used up, it resets at midnight Pacific (12:30 PM your time)."],
        buttons: ['Try again at TIME', 'Use your own key'],
        ticker: true,
      },
    )
    check(row.ariaDisabled === 'true', `${name}: Try again not aria-disabled`)
    check((await ticker.evaluate((el) => !el.closest('[aria-live]'))) === true, `${name}: ticker inside a live region`)
    const t0 = await ticker.innerText()
    // An aria-disabled click does nothing.
    const beforeClick = calls
    // force: Playwright treats aria-disabled as not clickable; a real click still lands.
    await banner.locator('button').first().click({ force: true })
    await page.waitForTimeout(300)
    check(calls === beforeClick, `${name}: disabled Try again sent a request`)
    await page.clock.fastForward(60_000)
    const t60 = await ticker.innerText()
    row.tickerAt0 = t0
    row.tickerAfter60s = t60
    check(t0 !== t60 && /^Try again in 1:0\d$/.test(t60), `${name}: ticker didn't count down (${t0} → ${t60})`)

    // Reload (fresh tab, same history DB): the restored failure has no timer.
    const tab = await context.newPage()
    await tab.goto(APP)
    const restored = tab.locator('p', { hasText: COPY.sharedRl.slice(0, 30) }).first()
    await restored.waitFor({ timeout: 30_000 })
    const restoredRow = {
      scenario: 'Step D: restored breaker failure (fresh tab)',
      text: (await restored.innerText()).replace(/\s+/g, ' ').trim(),
      tickerVisible: await tab.locator('p[aria-hidden="true"]', { hasText: 'Try again in' }).isVisible(),
    }
    check(!restoredRow.tickerVisible, 'restored: ticker shown')
    check(!/Try again at|try Google again|your time/.test(restoredRow.text), `restored: timer text: ${restoredRow.text}`)
    results.push(restoredRow)
    await tab.close()

    await page.clock.fastForward(61_000)
    await page.getByText('You can try again now.').waitFor({ timeout: 5000 })
    row.buttonsAtZero = await banner.locator('button').allInnerTexts()
    row.ariaDisabledAtZero = await banner.locator('button').first().getAttribute('aria-disabled')
    row.tickerAtZero = await ticker.isVisible()
    row.liveRegionTexts = (await liveChanges('PocketRAG will try Google again')).length
    check(row.buttonsAtZero[0] === 'Try again' && row.ariaDisabledAtZero === null, `${name}: not enabled at zero ${JSON.stringify(row.buttonsAtZero)}`)
    check(!row.tickerAtZero, `${name}: ticker still shown at zero`)
    // Exactly two states handed to the live region: the banner, then the zero update.
    check(row.liveRegionTexts === 2, `${name}: live region changed ${row.liveRegionTexts} times`)
    handler = successFor('stepD')
    await banner.getByRole('button', { name: 'Try again', exact: true }).click()
    row.retryAnswerShown = await page.getByText('Retried answer stepD').first().waitFor({ timeout: 60_000 }).then(() => true, () => false)
    check(row.retryAnswerShown, `${name}: retry after zero didn't answer`)
  }

  // B. Unknown wait: no countdown, no timed button — just the Step B action.
  await askD('shared 502, no retry fields', err(502, { error: COPY.sharedRl, code: 'provider_rate_limited', source: 'shared' }), {
    text: COPY.sharedRl,
    buttons: ['Use your own key'],
    ticker: false,
  })

  // C. Our own 429 with retryAfterSeconds: ticks and enables at zero.
  {
    const name = 'our 429, retryAfterSeconds 30'
    const { row, banner } = await askD(name, err(429, { error: COPY.ours, resetAt: '2026-11-01T00:00:00.000Z', retryAfterSeconds: 30 }), {
      text: "You've hit today's request limit",
      buttons: ['Try again at TIME', 'Use your own key'],
      ticker: true,
    })
    await page.clock.fastForward(31_000)
    await page.getByText('You can try again now.').waitFor({ timeout: 5000 })
    row.buttonsAtZero = await banner.locator('button').allInnerTexts()
    check(row.buttonsAtZero[0] === 'Try again', `${name}: not enabled at zero`)
  }

  // D. Our 429 without retryAfterSeconds (older Worker): resetAt only, > 15 min → absolute time, no ticker.
  await askD('our 429, resetAt only', err(429, { error: COPY.ours, resetAt: '2026-11-01T02:00:00.000Z' }), {
    text: "You've hit today's request limit",
    buttons: ['Try again at TIME', 'Use your own key'],
    ticker: false,
  })

  // E. Breaker at its cap, no hint: the escalated copy, before the DST change. The button
  // waits only for the breaker's own cooldown (cooldownSeconds), never for midnight Pacific.
  {
    const name = 'escalated (cap, no hint), before DST change'
    const { row, banner } = await askD(
      name,
      err(502, { error: COPY.sharedRl, code: 'provider_rate_limited', source: 'shared', resetAt: MIDNIGHT_PDT, cooldownSeconds: 900 }),
      {
        text: 'The free shared tier looks used up for today.',
        contains: ['The free shared tier looks used up for today. It normally resets at midnight Pacific (12:30 PM your time). Or use your own key.'],
        buttons: ['Try again at TIME', 'Use your own key'],
        ticker: true,
      },
    )
    check(row.ariaDisabled === 'true', `${name}: Try again not aria-disabled during the cooldown`)
    check(!row.buttons[0].includes('12:30'), `${name}: button waits for midnight: ${row.buttons[0]}`)
    await page.clock.fastForward(901_000)
    await page.getByText('You can try again now.').waitFor({ timeout: 5000 })
    row.buttonsAtZero = await banner.locator('button').allInnerTexts()
    row.ariaDisabledAtZero = await banner.locator('button').first().getAttribute('aria-disabled')
    check(row.buttonsAtZero[0] === 'Try again' && row.ariaDisabledAtZero === null, `${name}: not enabled after the 15-min cooldown ${JSON.stringify(row.buttonsAtZero)}`)
  }

  // F. …and after it (PST): midnight Pacific is an hour later in UTC. An older Worker (no
  // cooldownSeconds) → Try again enabled at once (a retry during the cooldown is free).
  await page.clock.setSystemTime(new Date('2026-11-01T12:00:00.000Z'))
  {
    const name = 'escalated, after DST change, no cooldownSeconds'
    const { row } = await askD(name, err(502, { error: COPY.sharedRl, code: 'provider_rate_limited', source: 'shared', resetAt: MIDNIGHT_PST }), {
      text: 'The free shared tier looks used up for today.',
      contains: ['It normally resets at midnight Pacific (1:30 PM your time). Or use your own key.'],
      buttons: ['Try again', 'Use your own key'],
      ticker: false,
    })
    check(row.ariaDisabled === null, `${name}: Try again disabled with no cooldown known`)
  }

  // G. Own key: a provider hint ticks with no own-key button; no hint → no timer.
  await page.getByLabel('Use your own API key').check()
  await page.getByLabel('Provider', { exact: true }).selectOption('openai')
  await page.getByLabel('OpenAI API key').fill('sk-fake-stepd-0000000000')
  await page.getByRole('button', { name: 'Find a model' }).click()
  await page.getByRole('button', { name: 'Use this model' }).click()
  await askD('own-key 502, retryAfterSeconds 20', err(502, { error: COPY.ownRl, code: 'provider_rate_limited', source: 'own', retryAfterSeconds: 20 }), {
    text: COPY.ownRl,
    contains: [COPY.ownRl, 'Try again at'],
    buttons: ['Try again at TIME'],
    ticker: true,
  })
  await askD('own-key 502, no retry fields', err(502, { error: COPY.ownRl, code: 'provider_rate_limited', source: 'own' }), {
    text: COPY.ownRl,
    buttons: [],
    ticker: false,
  })
  await context.close()
}

main().catch((e) => {
  console.error(e)
  console.log(JSON.stringify({ results, failures }, null, 2))
  process.exit(1)
})
