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
    // v1.2: its own browser context, not just its own tab — in a tab of the main context the
    // request hung twice running in a row (it answered in ~1s in a fresh context and from curl).
    const liveContext = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await liveContext.addInitScript(() => localStorage.setItem('pocketrag:has-visited-app', 'true'))
    const live = await liveContext.newPage()
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
    await liveContext.close()
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
  await modelDownloadBlocked(browser, pageErrors)
  await workedExamples(browser, pageErrors)
  await reindexOutdated(browser, pageErrors)
  await branching(browser, pageErrors)
  await streaming(browser, pageErrors)

  check(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`)
  console.log(JSON.stringify({ results, answerCalls, pageErrors, failures }, null, 2))
  await browser.close()
  if (failures.length) process.exit(1)
}

// ---- Step D: retry countdowns, under Playwright's clock ----
// Own context: a fixed zone (IST, UTC+5:30 all year) so local times are exact, and the
// clock installed before load. Time flows normally until fastForward jumps it. All
// mocked; the Worker's resetAt values are what breaker.ts computes for these instants.
// Phase 5b: the search-model host is blocked (aborted requests, as an offline network or a
// blocker would) → the document row shows the plain message, never the raw TypeError, and
// a Try again button. Unblock, press it: the download is re-attempted and the doc is ready.
async function modelDownloadBlocked(browser, pageErrors) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.addInitScript(() => localStorage.setItem('pocketrag:has-visited-app', 'true'))
  let blocked = true
  let blockedHits = 0
  const hf = async (r) => {
    if (blocked) {
      blockedHits++
      return r.abort('internetdisconnected')
    }
    return r.continue()
  }
  await context.route(/^https:\/\/([a-z0-9-]+\.)*(huggingface\.co|hf\.co)\//, hf)
  const page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(`modelBlocked: ${String(e)}`))
  await page.goto(APP)
  await page.setInputFiles('input[type="file"][accept="application/pdf"]', writeTestPdf())
  const MESSAGE = "Couldn't download the search model. Check your connection or network blocking, then try again."
  const row = { scenario: 'Phase 5b: model host blocked → plain message + Try again' }
  const status = page.locator('li p', { hasText: MESSAGE })
  await status.waitFor({ timeout: 60_000 }).catch(() => {})
  row.message = await status.count()
  row.rawTypeErrorShown = await page.locator('li', { hasText: /tokenizer_class|TypeError|Failed to fetch/ }).count()
  row.blockedHits = blockedHits
  const retry = page.getByRole('button', { name: 'Try again: cells.pdf' })
  row.retryButton = await retry.count()
  check(row.message === 1, 'modelBlocked: plain message not shown')
  check(row.rawTypeErrorShown === 0, 'modelBlocked: raw error text shown')
  check(row.retryButton === 1, 'modelBlocked: no Try again button')
  check(blockedHits > 0, 'modelBlocked: the model host was never requested')
  if (row.retryButton === 1) {
    blocked = false
    await retry.click()
    await page.locator('li p', { hasText: /^\d+ chunks?$/ }).first().waitFor({ timeout: 300_000 }).catch(() => {})
    row.readyAfterRetry = await page.locator('li p', { hasText: /^\d+ chunks?$/ }).count()
    row.messageAfterRetry = await status.count()
    check(row.readyAfterRetry === 1, 'modelBlocked: retry did not re-download and index the document')
    check(row.messageAfterRetry === 0, 'modelBlocked: message still shown after a successful retry')
  }
  results.push(row)
  await context.close()
}

// v1.1 worked-example fidelity, on the committed eval fixture (eval/fixtures/maths-notes.pdf):
// a paraphrase → no source block, no followMethod; new numbers → followMethod with the
// example first, and the example + arithmetic note beside the answer; the document's own
// question → "From your notes (page 1)" with the solution verbatim, kept after a reload.
async function workedExamples(browser, pageErrors) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.addInitScript(() => localStorage.setItem('pocketrag:has-visited-app', 'true'))
  const page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(`worked: ${String(e)}`))
  const bodies = []
  await context.route(`${API}/answer`, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const body = JSON.parse(req.postData() || '{}')
    bodies.push(body)
    const ids = [...new Set(body.chunks.map((c) => c.documentId))]
    return route.fulfill({
      status: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: `Worked answer ${bodies.length} (Doc 1, page 1).`, groundingWarning: false, docLabels: ids.map((d, i) => ({ label: i + 1, documentId: d })) }),
    })
  })
  await page.goto(APP)
  await page.setInputFiles('input[type="file"][accept="application/pdf"]', path.join(__dirname, '../eval/fixtures/maths-notes.pdf'))
  await page.waitForFunction(() => document.querySelector('form input[type="text"]')?.disabled === false, null, { timeout: 300_000 })
  const askW = async (question) => {
    const n = bodies.length
    await page.locator('form input[type="text"]').fill(question)
    await page.getByRole('button', { name: 'Search' }).click()
    await page.getByText(`Worked answer ${n + 1}`).first().waitFor({ timeout: 120_000 })
    await page.waitForTimeout(300) // the source block reads IndexedDB after the answer renders
    return bodies[n]
  }
  const blockText = async (kind) => {
    const block = page.locator(`section[data-source-match="${kind}"]`)
    return (await block.count()) ? (await block.innerText()).replace(/\s+/g, ' ').trim() : null
  }
  const row = { scenario: 'v1.1 worked examples (maths fixture)' }

  const para = await askW('How do I calculate interest that is added to the principal every year?')
  row.paraphrase = { followMethod: para.followMethod ?? null, verbatim: await blockText('verbatim'), method: await blockText('method') }
  check(para.followMethod === undefined && !row.paraphrase.verbatim && !row.paraphrase.method, `worked paraphrase: ${JSON.stringify(row.paraphrase)}`)

  const nums = await askW('Find the amount and the compound interest when ₹25,000 is invested at 6% per annum, compounded annually, for 4 years.')
  const method = await blockText('method')
  row.numbers = { followMethod: nums.followMethod, firstPassage: nums.chunks[0].text.slice(0, 60), firstPassageChars: nums.chunks[0].text.length, passages: nums.chunks.length, method: method && method.slice(0, 80), verbatim: await blockText('verbatim') }
  check(nums.followMethod === true, 'worked numbers: followMethod not sent')
  check(/Compound interest/.test(nums.chunks[0].text) && /Step 5/.test(nums.chunks[0].text) && nums.chunks[0].text.length <= 2000, `worked numbers: first passage ${row.numbers.firstPassage}`)
  check(!!method && method.startsWith('Method from your notes (page 1)') && method.includes('Check the arithmetic: the model can make calculation mistakes.'), `worked numbers: method block ${method}`)
  check(!row.numbers.verbatim, 'worked numbers: verbatim block shown for new numbers')

  const exact = await askW('Find the amount and the compound interest when ₹12,000 is invested at 8% per annum, compounded annually, for 3 years.')
  const verbatim = await blockText('verbatim')
  row.exact = { followMethod: exact.followMethod ?? null, verbatim: verbatim && verbatim.slice(0, 80) }
  check(exact.followMethod === undefined, 'worked exact: followMethod sent')
  check(!!verbatim && verbatim.startsWith('From your notes (page 1)') && verbatim.includes('Step 5: Compound interest = A − P = 15116.54 − 12000 = ₹3,116.54.'), `worked exact: verbatim block ${verbatim}`)
  check(!verbatim?.includes('Check the arithmetic'), 'worked exact: arithmetic note on a verbatim block')
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  check(overflow <= 0, `worked: page scrolls horizontally by ${overflow}px`)

  await page.reload()
  await page.locator('section[data-source-match="verbatim"]').waitFor({ timeout: 30_000 }).catch(() => {})
  row.verbatimAfterReload = !!(await blockText('verbatim'))
  check(row.verbatimAfterReload, 'worked exact: verbatim block not restored after reload')
  row.answerCalls = bodies.length
  results.push(row)
  await context.close()
}

// v1.3 streaming, with real chunked streams: a local HTTPS mock Worker (self-signed cert,
// made here; ignoreHTTPSErrors for this context only) that /answer is redirected to, so the
// SSE arrives in timed pieces. Complete (text grows, stages, start/end announcements only,
// Receipt OK), mid-stream error (Worker copy verbatim, partial "Stopped", Receipt
// Interrupted), Stop (partial kept as interrupted across a reload), a cut-off stream, a
// non-streaming provider's note, and the skeleton under reduced motion.
async function streaming(browser, pageErrors) {
  const https = require('https')
  const { execFileSync } = require('child_process')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrag-sse-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' })
  let mode = 'complete'
  let lastBody = null
  const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  const server = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (req, res) => {
    const cors = { 'Access-Control-Allow-Origin': req.headers.origin || '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end()
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', async () => {
      lastBody = JSON.parse(raw)
      const ids = [...new Set(lastBody.chunks.map((c) => c.documentId))]
      res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' })
      const pause = (ms) => new Promise((r) => setTimeout(r, ms))
      res.write(ev('meta', { provider: 'gemini', model: 'gemini-3.5-flash-lite' }))
      const pieces = ['Mitochondria ', 'produce ', 'ATP ', 'through respiration ', '(Doc 1, page 1).']
      const send = mode === 'complete' ? pieces : pieces.slice(0, 2)
      for (const t of send) {
        await pause(400)
        res.write(ev('delta', { t }))
        res.write(': keep-alive\n\n')
      }
      if (mode === 'complete') res.end(ev('done', { groundingWarning: false, docLabels: ids.map((d, i) => ({ label: i + 1, documentId: d })) }))
      else if (mode === 'error') res.end(ev('error', { error: COPY.sharedUn, code: 'provider_unavailable' }))
      else if (mode === 'cut') res.destroy()
      // 'hang': left open until the client goes away (Stop).
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const mock = `https://127.0.0.1:${server.address().port}/answer`

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true })
  await context.addInitScript(() => localStorage.setItem('pocketrag:has-visited-app', 'true'))
  await context.route(`${API}/answer`, (route) => route.continue({ url: mock }))
  const page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(`streaming: ${String(e)}`))
  await page.goto(APP)
  await page.setInputFiles('input[type="file"][accept="application/pdf"]', writeTestPdf())
  await page.waitForFunction(() => document.querySelector('form input[type="text"]')?.disabled === false, null, { timeout: 300_000 })
  const row = { scenario: 'v1.3 streaming (chunked mock Worker)' }
  const announcements = []
  await page.exposeFunction('__announce', (t) => announcements.push(t))
  await page.evaluate(() => {
    const el = document.querySelector('[data-answer-announcement]')
    new MutationObserver(() => window.__announce(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true })
  })
  const streamed = page.locator('[data-streamed-answer]')
  const receiptStatus = async () => {
    const receipt = page.locator('#answer-area details[data-receipt]').last()
    await receipt.evaluate((d) => (d.open = true))
    return (await receipt.innerText()).replace(/\s+/g, ' ')
  }
  const ask = async (q) => {
    await page.locator('form input[type="text"]').fill(q)
    await page.getByRole('button', { name: 'Search' }).click()
  }

  // Complete: skeleton, then text that grows, stage "Writing", announcements start/end only.
  mode = 'complete'
  announcements.length = 0
  await ask('What do mitochondria do?')
  await page.locator('[data-answer-progress="asking"]').waitFor({ timeout: 60_000 })
  row.skeletonBeforeText = await page.locator('[data-answer-progress] [aria-hidden="true"] .motion-safe\\:animate-pulse').count()
  await streamed.waitFor({ timeout: 30_000 })
  const firstText = await streamed.innerText()
  row.currentStage = await page.locator('[data-answer-progress] li[aria-current="step"]').innerText()
  row.stopVisible = await page.getByRole('button', { name: 'Stop' }).count()
  await page.getByText('(Doc 1, page 1).').first().waitFor({ timeout: 30_000 })
  await page.waitForTimeout(300)
  row.complete = { firstText, requestStream: lastBody.stream, announcements: [...new Set(announcements.filter(Boolean))], receipt: (await receiptStatus()).match(/OK|Interrupted[^·]*|Receiving…/)?.[0] }
  check(row.skeletonBeforeText === 3, `streaming: skeleton bars ${row.skeletonBeforeText}`)
  check(firstText.length > 0 && firstText !== 'Mitochondria produce ATP through respiration (Doc 1, page 1).', `streaming: text did not arrive progressively (${firstText})`)
  check(/Writing/.test(row.currentStage) && row.stopVisible === 1, `streaming: stage ${row.currentStage}, stop ${row.stopVisible}`)
  check(row.complete.requestStream === true, 'streaming: stream not requested')
  check(JSON.stringify(row.complete.announcements) === JSON.stringify(['Writing the answer…', 'Answer complete.']), `streaming: announcements ${JSON.stringify(row.complete.announcements)}`)
  check(row.complete.receipt === 'OK', `streaming: receipt ${row.complete.receipt}`)

  // Mid-stream error event: the Worker's copy verbatim, the partial text marked Stopped.
  mode = 'error'
  await ask('What do ribosomes do?')
  const errorView = page.locator('#answer-area [data-interrupted="stream-error"]')
  await errorView.waitFor({ timeout: 60_000 })
  row.error = { text: (await errorView.innerText()).replace(/\s+/g, ' '), receipt: (await receiptStatus()).match(/OK|Interrupted \(partial answer\)/)?.[0] }
  check(row.error.text.includes(COPY.sharedUn) && /stopped/i.test(row.error.text) && row.error.text.includes('Mitochondria produce') && row.error.text.includes('Try again'), `streaming: error view ${row.error.text}`)
  check(row.error.receipt === 'Interrupted (partial answer)', `streaming: error receipt ${row.error.receipt}`)

  // Stop: the partial answer is kept, as interrupted, across a reload.
  mode = 'hang'
  announcements.length = 0
  await ask('What does the nucleus store?')
  await page.getByText('produce').first().waitFor({ timeout: 60_000 })
  await streamed.filter({ hasText: 'produce' }).waitFor({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Stop' }).click()
  const stoppedView = page.locator('#answer-area [data-interrupted="stopped"]')
  await stoppedView.waitFor({ timeout: 10_000 })
  await page.waitForTimeout(300)
  row.stop = {
    text: (await stoppedView.innerText()).replace(/\s+/g, ' '),
    focus: await page.evaluate(() => (document.activeElement === document.body ? 'BODY' : document.activeElement?.id || document.activeElement?.tagName)),
    announcements: [...new Set(announcements.filter(Boolean))],
    receipt: (await receiptStatus()).match(/OK|Interrupted \(partial answer\)/)?.[0],
  }
  check(/stopped/i.test(row.stop.text) && /Mitochondria produce/.test(row.stop.text), `streaming: stop view ${row.stop.text}`)
  check(row.stop.focus !== 'BODY', 'streaming: focus dropped to <body> after Stop')
  check(row.stop.announcements.at(-1) === 'Answer stopped.', `streaming: stop announcements ${JSON.stringify(row.stop.announcements)}`)
  check(row.stop.receipt === 'Interrupted (partial answer)', `streaming: stop receipt ${row.stop.receipt}`)
  await page.reload()
  await page.locator('#answer-area [data-interrupted="stopped"]').waitFor({ timeout: 30_000 }).catch(() => {})
  row.stopAfterReload = (await page.locator('#answer-area [data-interrupted="stopped"]').innerText().catch(() => '')).replace(/\s+/g, ' ')
  check(/stopped/i.test(row.stopAfterReload) && /Mitochondria produce/.test(row.stopAfterReload), `streaming: stopped turn after reload ${row.stopAfterReload}`)

  // A stream cut off with no event: the client's own copy.
  await page.locator('li button', { hasText: 'cells.pdf' }).first().click()
  mode = 'cut'
  await ask('What makes proteins?')
  const cutView = page.locator('#answer-area [data-interrupted="stream-error"]')
  await cutView.waitFor({ timeout: 60_000 })
  row.cut = (await cutView.innerText()).replace(/\s+/g, ' ')
  check(row.cut.includes('The connection ended before the answer finished.'), `streaming: cut view ${row.cut}`)

  // Reduced motion: the skeleton doesn't animate.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  mode = 'hang'
  await ask('Skeleton check?')
  await page.locator('[data-answer-progress="asking"]').waitFor({ timeout: 60_000 })
  row.reducedMotionAnimation = await page.locator('[data-answer-progress] [aria-hidden="true"] div').first().evaluate((el) => getComputedStyle(el).animationName)
  check(row.reducedMotionAnimation === 'none', `streaming: skeleton animates under reduced motion (${row.reducedMotionAnimation})`)
  await page.getByRole('button', { name: 'Stop' }).click()
  await page.emulateMedia({ reducedMotion: 'no-preference' })

  // A provider that can't stream: the note, and no stream requested.
  await page.unroute(`${API}/answer`)
  let grokBody = null
  await page.route(`${API}/models`, (route) =>
    route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers: CORS })
      : route.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ models: [{ id: 'grok-4', displayName: 'grok-4' }] }) }),
  )
  await page.route(`${API}/answer`, async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    grokBody = JSON.parse(route.request().postData())
    await new Promise((r) => setTimeout(r, 1500))
    const ids = [...new Set(grokBody.chunks.map((c) => c.documentId))]
    return route.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: 'Grok whole answer (Doc 1, page 1).', groundingWarning: false, docLabels: ids.map((d, i) => ({ label: i + 1, documentId: d })), provider: 'grok', model: 'grok-4' }) })
  })
  await page.getByLabel('Use your own API key').check()
  await page.getByLabel('Provider', { exact: true }).selectOption('grok')
  await page.getByLabel('Grok API key').fill('xai-fake-stream-0000000000')
  await page.getByRole('button', { name: 'Find a model' }).click()
  const useModelButton = page.getByRole('button', { name: 'Use this model' })
  if (await useModelButton.waitFor({ timeout: 10_000 }).then(() => true, () => false)) await useModelButton.click()
  else {
    await page.getByText('Enter a model ID yourself').click()
    await page.getByLabel('Model ID').fill('grok-4')
    await page.getByRole('button', { name: 'Use this ID' }).click()
  }
  await ask('What powers the cell (grok)?')
  const note = page.getByText("Streaming isn't available for this provider yet; your answer will appear when it is complete.")
  row.nonStreaming = { noteShown: await note.waitFor({ timeout: 10_000 }).then(() => true, () => false) }
  await page.getByText('Grok whole answer').first().waitFor({ timeout: 30_000 })
  row.nonStreaming.stream = grokBody.stream ?? null
  row.nonStreaming.noteIsError = await note.evaluate((el) => !!el.closest('[role="alert"]')).catch(() => false)
  check(row.nonStreaming.noteShown && row.nonStreaming.stream === null && !row.nonStreaming.noteIsError, `streaming: non-streaming provider ${JSON.stringify(row.nonStreaming)}`)

  results.push(row)
  await context.close()
  server.close()
}

// v1.2 branching: regenerate an answer (sibling, same question), step between versions with
// ‹ › (mouse and keyboard; focus stays on the button; a polite announcement), edit an earlier
// question (sibling with a fresh retrieval; history from its ancestors only), reload keeps
// the active branch, 360px has no horizontal scroll, delete removes the whole tree.
// SHOTS_DIR also writes the README screenshots (branching-360.png / branching-1280.png).
async function branching(browser, pageErrors) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.addInitScript(() => localStorage.setItem('pocketrag:has-visited-app', 'true'))
  const page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(`branching: ${String(e)}`))
  const bodies = []
  await context.route(`${API}/answer`, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const body = JSON.parse(req.postData() || '{}')
    bodies.push(body)
    const ids = [...new Set(body.chunks.map((c) => c.documentId))]
    return route.fulfill({
      status: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: `Branch answer ${bodies.length} (Doc 1, page 1).`, groundingWarning: false, docLabels: ids.map((d, i) => ({ label: i + 1, documentId: d })) }),
    })
  })
  await page.goto(APP)
  await page.setInputFiles('input[type="file"][accept="application/pdf"]', writeTestPdf())
  await page.waitForFunction(() => document.querySelector('form input[type="text"]')?.disabled === false, null, { timeout: 300_000 })
  const row = { scenario: 'v1.2 branching (edit, regenerate, navigate, reload, delete)' }
  const answerArea = page.locator('#answer-area')
  const waitAnswer = (n) => page.getByText(`Branch answer ${n} `).first().waitFor({ timeout: 120_000 })
  const leafControls = answerArea.locator('[data-turn-controls]').first()
  const counter = async (controls) => ((await controls.locator('[role="group"] span').count()) ? (await controls.locator('[role="group"] span').innerText()).trim() : null)
  const announcement = () => page.locator('[data-branch-announcement]').innerText()
  const focusedLabel = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName)
  const ask = async (q, n) => {
    await page.locator('form input[type="text"]').fill(q)
    await page.getByRole('button', { name: 'Search' }).click()
    await waitAnswer(n)
  }

  await ask('What does the mitochondrion do?', 1)
  await ask('What do ribosomes do?', 2)
  check(bodies[1].history.length === 1, `branching: Q2 history ${bodies[1].history.length}`)

  // Regenerate the leaf: a sibling with the same question; history = Q1/A1 only.
  await leafControls.getByRole('button', { name: 'Regenerate answer' }).click()
  await waitAnswer(3)
  row.regenerate = { question: bodies[2].question, history: bodies[2].history.map((h) => h.answer), counter: await counter(leafControls), announced: await announcement() }
  check(bodies[2].question === 'What do ribosomes do?' && row.regenerate.history.length === 1 && /answer 1/.test(row.regenerate.history[0]), `branching: regenerate ${JSON.stringify(row.regenerate)}`)
  check(row.regenerate.counter === '2/2', `branching: counter after regenerate ${row.regenerate.counter}`)

  // ‹ by mouse: back to the original answer; focus stays on the ‹ button; announced.
  await leafControls.getByRole('button', { name: 'Previous version' }).click()
  await page.getByText('Branch answer 2 ').first().waitFor({ timeout: 10_000 })
  await page.waitForTimeout(200)
  row.navigateMouse = { counter: await counter(leafControls), focus: await focusedLabel(), announced: await announcement(), answer3Shown: await answerArea.getByText('Branch answer 3 ').count() }
  check(row.navigateMouse.counter === '1/2' && row.navigateMouse.answer3Shown === 0, `branching: previous ${JSON.stringify(row.navigateMouse)}`)
  check(row.navigateMouse.focus === 'Previous version', `branching: focus after ‹ on ${row.navigateMouse.focus}`)
  check(/Showing version 1 of 2/.test(row.navigateMouse.announced), `branching: announcement ${row.navigateMouse.announced}`)
  // At the first version ‹ is aria-disabled (still focusable) and does nothing.
  row.firstDisabled = await leafControls.getByRole('button', { name: 'Previous version' }).getAttribute('aria-disabled')
  check(row.firstDisabled === 'true', 'branching: ‹ not aria-disabled at version 1')

  // › by keyboard.
  await leafControls.getByRole('button', { name: 'Next version' }).focus()
  await page.keyboard.press('Enter')
  await page.getByText('Branch answer 3 ').first().waitFor({ timeout: 10_000 })
  await page.waitForTimeout(200)
  row.navigateKeyboard = { counter: await counter(leafControls), focus: await focusedLabel() }
  check(row.navigateKeyboard.counter === '2/2' && row.navigateKeyboard.focus === 'Next version', `branching: keyboard › ${JSON.stringify(row.navigateKeyboard)}`)

  // Edit the first question (an earlier turn, under "Conversation"): a sibling root turn,
  // fresh retrieval, no history.
  await page.locator('summary', { hasText: /^Conversation/ }).click()
  const firstControls = page.locator('details li [data-turn-controls]').first()
  await firstControls.getByRole('button', { name: 'Edit question' }).click()
  await page.getByLabel('Edit question').fill('What powers the cell?')
  await page.getByRole('button', { name: 'Send edited question' }).click()
  await waitAnswer(4)
  row.edit = { question: bodies[3].question, history: bodies[3].history.length, chunks: bodies[3].chunks.length, counter: await counter(leafControls), pastTurns: await page.locator('summary', { hasText: /^Conversation/ }).count() }
  check(row.edit.question === 'What powers the cell?' && row.edit.history === 0 && row.edit.chunks > 0, `branching: edit ${JSON.stringify(row.edit)}`)
  check(row.edit.counter === '2/2' && row.edit.pastTurns === 0, `branching: after edit ${JSON.stringify(row.edit)}`)

  // Back to the original first question: its branch opens at its newest leaf (answer 3).
  await leafControls.getByRole('button', { name: 'Previous version' }).click()
  await page.getByText('Branch answer 3 ').first().waitFor({ timeout: 10_000 })
  await page.waitForTimeout(300)
  if (SHOTS_DIR) {
    await page.locator('summary', { hasText: /^Conversation/ }).click()
    fs.mkdirSync(SHOTS_DIR, { recursive: true })
    await page.locator('main').screenshot({ path: path.join(SHOTS_DIR, 'branching-1280.png') })
  }
  // Reload: the active branch (original Q1 → regenerated Q2) comes back.
  await page.reload()
  await page.getByText('Branch answer 3 ').first().waitFor({ timeout: 30_000 }).catch(() => {})
  row.afterReload = { answer3: await answerArea.getByText('Branch answer 3 ').count(), answer4: await answerArea.getByText('Branch answer 4 ').count(), leafCounter: await counter(leafControls) }
  check(row.afterReload.answer3 === 1 && row.afterReload.answer4 === 0 && row.afterReload.leafCounter === '2/2', `branching: reload ${JSON.stringify(row.afterReload)}`)

  // Restore selects no document (by design), which disables Edit/Regenerate; select it so the
  // 360px view (and its screenshot) shows the controls usable.
  await page.locator('li button', { hasText: 'cells.pdf' }).first().click()
  row.editEnabledAfterSelect = await leafControls.getByRole('button', { name: 'Edit question' }).isEnabled()
  check(row.editEnabledAfterSelect, 'branching: Edit question disabled with a document selected')
  await page.setViewportSize({ width: 360, height: 800 })
  await page.waitForTimeout(300)
  row.overflow360 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  check(row.overflow360 <= 0, `branching: 360px scrolls horizontally by ${row.overflow360}px`)
  if (SHOTS_DIR) {
    await page.locator('summary', { hasText: /^Conversation/ }).click()
    await page.locator('#answer-area').scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(SHOTS_DIR, 'branching-360.png'), fullPage: false })
  }
  await page.setViewportSize({ width: 1280, height: 900 })

  // Delete the conversation: every version goes, and stays gone after a reload.
  await page.getByRole('button', { name: /^Delete conversation:/ }).first().click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.waitForTimeout(500)
  await page.reload()
  await page.waitForTimeout(1500)
  row.afterDelete = {
    conversations: await page.getByRole('button', { name: /^Delete conversation:/ }).count(),
    storedTurns: await page.evaluate(
      () =>
        new Promise((resolve) => {
          const open = indexedDB.open('pocketrag-history')
          open.onsuccess = () => {
            const req = open.result.transaction('turns').objectStore('turns').count()
            req.onsuccess = () => resolve(req.result)
          }
        }),
    ),
  }
  check(row.afterDelete.conversations === 0 && row.afterDelete.storedTurns === 0, `branching: delete ${JSON.stringify(row.afterDelete)}`)
  row.answerCalls = bodies.length
  results.push(row)
  await context.close()
}

// v1.1: a document saved before v1.1 (no embeddingModel) is re-embedded once from its stored
// text — "Updating search index" on its row, then ready, stamped with the new model.
async function reindexOutdated(browser, pageErrors) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.addInitScript(() => localStorage.setItem('pocketrag:has-visited-app', 'true'))
  const page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(`reindex: ${String(e)}`))
  await page.goto(APP)
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('pocketrag', 1)
        open.onupgradeneeded = () => {
          open.result.createObjectStore('documents', { keyPath: 'id' })
          open.result.createObjectStore('chunks', { keyPath: 'id' }).createIndex('documentId', 'documentId')
        }
        open.onsuccess = () => {
          const tx = open.result.transaction(['documents', 'chunks'], 'readwrite')
          tx.objectStore('documents').put({ id: 'old-doc', fileName: 'old-notes.pdf', uploadedAt: 1, chunkCount: 2, source: 'document' })
          const zero = Array(384).fill(0)
          tx.objectStore('chunks').put({ id: 'old-doc:0', documentId: 'old-doc', index: 0, text: 'Mitochondria produce ATP.', tokenCount: 5, page: 1, embedding: zero, hasImage: false })
          tx.objectStore('chunks').put({ id: 'old-doc:1', documentId: 'old-doc', index: 1, text: 'Ribosomes make proteins.', tokenCount: 4, page: 1, embedding: zero, hasImage: false })
          tx.oncomplete = () => {
            open.result.close()
            resolve()
          }
          tx.onerror = () => reject(tx.error)
        }
        open.onerror = () => reject(open.error)
      }),
  )
  await page.reload()
  const row = { scenario: 'v1.1 re-index of a pre-v1.1 document' }
  const updating = page.locator('li p', { hasText: 'Updating search index' })
  await updating.first().waitFor({ timeout: 30_000 }).catch(() => {})
  row.updatingShown = await updating.count()
  await page.locator('li p', { hasText: /^2 chunks$/ }).waitFor({ timeout: 300_000 }).catch(() => {})
  row.readyAfter = await page.locator('li p', { hasText: /^2 chunks$/ }).count()
  row.stored = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('pocketrag', 1)
        open.onsuccess = () => {
          const tx = open.result.transaction(['documents', 'chunks'])
          const doc = tx.objectStore('documents').get('old-doc')
          const chunk = tx.objectStore('chunks').get('old-doc:0')
          tx.oncomplete = () => resolve({ embeddingModel: doc.result?.embeddingModel, nonZero: chunk.result?.embedding.some((x) => x !== 0) })
        }
      }),
  )
  check(row.updatingShown === 1, 'reindex: "Updating search index" never shown')
  check(row.readyAfter === 1, 'reindex: document not ready after re-indexing')
  check(/^Xenova\/multilingual-e5-small@[0-9a-f]{40}$/.test(row.stored.embeddingModel ?? '') && row.stored.nonZero, `reindex: stored ${JSON.stringify(row.stored)}`)
  results.push(row)
  await context.close()
}

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
