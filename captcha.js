/**
 * Detects a captcha on the current page and tries to clear it.
 *
 * Checkbox widgets (Cloudflare Turnstile, reCAPTCHA, hCaptcha) are clicked
 * in-page. Turnstile keeps its checkbox in a closed shadow root, so when no
 * selector matches we click the left side of the widget iframe. Image grids
 * are sent to the Claude CLI, which answers with the squares to click.
 */

const { spawn } = require('child_process');
const os = require('os');

const CLAUDE_PROMPT = 'Which squares? Reply with only 1-based row,col pairs separated by spaces. Example: 2,2 3,1. If none, reply none.';

const IMAGE_WIDGETS = [
  {
    id: 'recaptcha image',
    matches: ({ url, src }) => /\/recaptcha\/(?:api2|enterprise)\/bframe/i.test(`${url} ${src}`),
  },
  {
    id: 'hcaptcha image',
    matches: ({ url, src }) => /hcaptcha\.com/i.test(`${url} ${src}`) && /frame=challenge/i.test(`${url} ${src}`),
  },
];

const CHECKBOX_WIDGETS = [
  {
    id: 'turnstile',
    matches: ({ url, src, title }) =>
      /challenges\.cloudflare\.com/i.test(`${url} ${src}`) ||
      /cloudflare security challenge/i.test(title),
    selectors: ['input[type="checkbox"]', '.ctp-checkbox-label', 'label.cb-lb'],
    // Checkbox sits on the left of the ~300x65 widget. Offsets are inside the iframe.
    fallback(box) {
      return { x: 26, y: Math.max(1, box.height / 2) };
    },
  },
  {
    id: 'recaptcha',
    matches: ({ url, src }) => /\/recaptcha\/(?:api2|enterprise)\/anchor/i.test(`${url} ${src}`),
    selectors: ['#recaptcha-anchor'],
  },
  {
    id: 'hcaptcha',
    matches: ({ url, src, title }) => {
      const haystack = `${url} ${src} ${title}`;
      return /hcaptcha/i.test(haystack) && !/frame=challenge/i.test(haystack);
    },
    selectors: ['#checkbox', '#anchor'],
  },
];

const DEFAULTS = {
  solveTimeoutMs: 12000,
  appearTimeoutMs: 8000,
  interstitialTimeoutMs: 30000,
  maxAttempts: 2,
  holdMs: 4000,
};

const PENDING_SELECTOR = [
  '.g-recaptcha',
  '.h-captcha',
  '.cf-turnstile',
  '#cf-turnstile',
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[title*="security challenge" i]',
].join(', ');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withDefaults(options) {
  return { ...DEFAULTS, ...options };
}

async function solveCaptcha(page, options) {
  const settings = withDefaults(options);
  if (!page || page.isClosed()) return { action: null };
  if (await responseTokenFilled(page)) return { action: null };

  const notes = [];
  let pending = null;
  for (let attempt = 0; attempt < settings.maxAttempts; attempt++) {
    if (await responseTokenFilled(page)) break;
    let widget = await findActionable(page);
    if (!widget && attempt === 0) {
      if (await isInterstitialTitle(page)) {
        const waited = await waitUntilWidgetOrClear(page, settings.appearTimeoutMs);
        if (waited === 'cleared') {
          notes.push('Solved cloudflare interstitial.');
          break;
        }
        if (waited === 'stuck') {
          notes.push('Captcha still present (cloudflare interstitial).');
          break;
        }
        widget = waited;
      } else if (await captchaHostPending(page)) {
        widget = await waitForActionable(page, settings.appearTimeoutMs);
      }
    }
    if (!widget) break;

    const outcome = await actOn(page, widget, settings);
    if (outcome.ok) {
      if (outcome.note) notes.push(outcome.note);
      pending = null;
    } else if (outcome.note) {
      pending = outcome.note;
    }
    if (!outcome.ok && !outcome.retry) break;
  }
  if (pending) notes.push(pending);

  return { action: notes.length ? notes.join(' ') : null };
}

async function captchaHostPending(page) {
  const count = await page.locator(PENDING_SELECTOR).count().catch(() => 0);
  return count > 0;
}

async function waitForActionable(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await responseTokenFilled(page)) return null;
    const widget = await findActionable(page);
    if (widget) return widget;
    await sleep(250);
  }
  if (await responseTokenFilled(page)) return null;
  return findActionable(page);
}

async function actOn(page, widget, settings) {
  try {
    if (widget.image) return await solveImage(widget);
    if (widget.hold) return await solvePressAndHold(page, widget, settings.holdMs);
    return await solveCheckbox(page, widget, settings);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, note: `Captcha solver failed (${widget.id}): ${message}` };
  }
}

async function solveCheckbox(page, widget, settings) {
  const clicked = await clickCheckbox(widget);
  if (!clicked)
    return { ok: false, retry: true, note: `Captcha still present (${widget.id}).` };

  const timeoutMs = (await isInterstitialTitle(page))
    ? Math.max(settings.solveTimeoutMs, settings.interstitialTimeoutMs)
    : settings.solveTimeoutMs;
  const outcome = await waitForClear(page, widget, timeoutMs);
  if (outcome.image) return solveImage(outcome.image);
  if (outcome.replacement) return { ok: false, retry: true };
  if (!outcome.cleared)
    return { ok: false, retry: true, note: `Captcha still present (${widget.id}).` };
  return { ok: true, note: `Solved ${widget.id} captcha.` };
}

async function clickCheckbox(widget) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      for (const selector of widget.selectors || []) {
        const locator = widget.frame.locator(selector).first();
        const count = await locator.count().catch(() => 0);
        if (!count) continue;
        if (!(await locator.isVisible().catch(() => false))) continue;
        await locator.click({ timeout: 5000 });
        return true;
      }

      if (!widget.fallback) {
        await sleep(200);
        continue;
      }
      const box = await frameBox(widget.frame);
      if (!box) return false;
      const point = widget.fallback(box);
      await widget.frame.locator('body').click({
        position: point,
        force: true,
        timeout: 5000,
      });
      return true;
    } catch (error) {
      if (isGoneError(error)) return true;
      throw error;
    }
  }
  return false;
}

async function waitForClear(page, widget, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await clearanceState(page, widget);
    if (state) return state;
    await sleep(200);
  }
  return (await clearanceState(page, widget)) || { cleared: false };
}

// A reloaded widget is a new attempt, not a pass. An interstitial whose frame
// disappeared is still in progress until the title leaves the challenge.
async function clearanceState(page, widget) {
  const image = await findVisibleImageWidget(page);
  if (image) return { cleared: false, image };
  if (page.isClosed() || (await responseTokenFilled(page))) return { cleared: true };
  if (!widget.frame.isDetached() && (await checkboxSolved(widget.frame, widget)))
    return { cleared: true };
  if (!widget.frame.isDetached()) return null;

  const next = await findActionable(page);
  if (next?.image) return { cleared: false, image: next };
  if (next) return { cleared: false, replacement: true };
  if (!(await interstitialSettled(page))) return null;
  return { cleared: true };
}

const INTERSTITIAL_TITLE = /just a moment|attention required|checking your browser/i;

function interstitialTitle(title) {
  return INTERSTITIAL_TITLE.test(title);
}

// A blank title is a navigation in progress. Wait until a real title stays.
async function interstitialSettled(page) {
  const title = await page.title().catch(() => '');
  if (!title || interstitialTitle(title)) return false;
  await sleep(500);
  const again = await page.title().catch(() => '');
  return Boolean(again) && !interstitialTitle(again);
}

async function findVisibleImageWidget(page) {
  for (const frame of page.frames()) {
    if (frame === page.mainFrame() || frame.isDetached()) continue;
    const url = frame.url() || '';
    const widget = IMAGE_WIDGETS.find((item) => item.matches({ url, src: '', title: '' }));
    if (!widget) continue;
    const box = await frameBox(frame);
    if (!box || box.height < 20) continue;
    if (!(await imageTileCount(frame))) continue;
    return { ...widget, frame, image: true };
  }
  return null;
}

function isGoneError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /detached|closed|navigation|target closed/i.test(message);
}

async function responseTokenFilled(page) {
  return page
    .locator('textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"], input[name="cf-turnstile-response"]')
    .evaluateAll((elements) => elements.some((element) => typeof element.value === 'string' && element.value.length > 0))
    .catch(() => false);
}

async function solvePressAndHold(page, widget, holdMs) {
  const box = await widget.hold.boundingBox();
  if (!box)
    return { ok: false, note: 'Captcha still present (press and hold).' };

  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await sleep(holdMs);
  await page.mouse.up();

  const stillThere = await widget.hold.isVisible().catch(() => false);
  if (stillThere)
    return { ok: false, note: 'Captcha still present (press and hold).' };
  return { ok: true, note: 'Solved press and hold captcha.' };
}

async function solveImage(widget) {
  for (let round = 0; round < 4; round++) {
    if (widget.frame.isDetached() || (await responseTokenFilled(widget.frame.page())))
      return { ok: true, note: `Solved ${widget.id} captcha.` };
    if (!(await imageTileCount(widget.frame)))
      return { ok: true };

    await waitForTiles(widget.frame);
    const box = await challengeBox(widget.frame) || await frameBox(widget.frame);
    if (!box)
      return { ok: true, note: `Solved ${widget.id} captcha.` };

    const png = await widget.frame.page().screenshot({
      type: 'png',
      animations: 'disabled',
      timeout: 8000,
      clip: {
        x: Math.max(0, box.x),
        y: Math.max(0, box.y),
        width: Math.max(1, box.width),
        height: Math.max(1, box.height),
      },
    });
    const answer = (await askClaude(png)).trim();
    if (/^none$/i.test(answer)) {
      await clickVerify(widget.frame);
      await sleep(700);
      continue;
    }
    const squares = parseSquares(answer);
    if (!squares.length)
      return { ok: false, note: `Captcha still present (${widget.id}). Claude returned no squares.` };

    const before = await tileSignature(widget.frame);
    await clickSquares(widget.frame, squares);
    if (widget.frame.isDetached() || (await responseTokenFilled(widget.frame.page())))
      return { ok: true, note: `Solved ${widget.id} captcha.` };
    await sleep(700);
    const after = await tileSignature(widget.frame);
    if (after && before && after !== before) continue;
    await clickVerify(widget.frame);
    await sleep(700);
  }

  if (widget.frame.isDetached() || !(await frameBox(widget.frame)) || (await responseTokenFilled(widget.frame.page())))
    return { ok: true, note: `Solved ${widget.id} captcha.` };
  return { ok: false, note: `Captcha still present (${widget.id}).` };
}

async function clickSquares(frame, squares) {
  const tiles = frame.locator('.rc-imageselect-tile, .task-image');
  const count = await tiles.count().catch(() => 0);
  if (!count) return;
  const cols = await tileColumns(frame, count);
  for (const square of squares) {
    const index = (square.row - 1) * cols + (square.col - 1);
    if (index < 0 || index >= count) continue;
    await tiles.nth(index).click({ timeout: 3000 }).catch((error) => {
      if (!isGoneError(error)) throw error;
    });
    if (frame.isDetached()) return;
    await sleep(200);
  }
}

async function imageTileCount(frame) {
  return frame.locator('.rc-imageselect-tile, .task-image').count().catch(() => 0);
}

async function waitForTiles(frame) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (await tilesReady(frame)) return;
    await sleep(200);
  }
}

async function tilesReady(frame) {
  return frame.locator('.rc-imageselect-tile, .task-image').evaluateAll((elements) => {
    if (!elements.length) return false;
    return elements.every((element) => {
      const image = element.querySelector('img');
      if (image) return image.complete && image.naturalWidth > 0;
      const background = getComputedStyle(element).backgroundImage;
      return Boolean(background) && background !== 'none';
    });
  }).catch(() => false);
}

async function challengeBox(frame) {
  const grid = await tileGridBox(frame);
  if (!grid) return null;
  const header = frame.locator('.rc-imageselect-instructions, .rc-imageselect-desc-wrapper, .prompt-text, .challenge-header').first();
  if (!(await header.count().catch(() => 0))) return grid;
  const headerBox = await header.boundingBox().catch(() => null);
  if (!headerBox) return grid;
  const x = Math.min(headerBox.x, grid.x);
  const y = Math.min(headerBox.y, grid.y);
  const right = Math.max(headerBox.x + headerBox.width, grid.x + grid.width);
  const bottom = Math.max(headerBox.y + headerBox.height, grid.y + grid.height);
  return { x, y, width: right - x, height: bottom - y };
}

async function tileSignature(frame) {
  return frame.locator('.rc-imageselect-tile, .task-image').evaluateAll((elements) => elements.map((element) => {
    const image = element.querySelector('img');
    if (image && image.src) return image.src.slice(-48);
    return getComputedStyle(element).backgroundImage.slice(-48);
  }).join('|')).catch(() => '');
}

async function tileGridBox(frame) {
  const tiles = frame.locator('.rc-imageselect-tile, .task-image');
  const count = await tiles.count().catch(() => 0);
  if (!count) return null;
  const first = await tiles.first().boundingBox().catch(() => null);
  const last = await tiles.nth(count - 1).boundingBox().catch(() => null);
  if (!first || !last) return null;
  return {
    x: first.x,
    y: first.y,
    width: last.x + last.width - first.x,
    height: last.y + last.height - first.y,
  };
}

async function tileColumns(frame, count) {
  const className = await frame.locator('table').first().getAttribute('class').catch(() => null);
  const match = className && className.match(/rc-imageselect-table-(\d)/);
  if (match) return Number(match[1]);
  const side = Math.round(Math.sqrt(count));
  return side >= 1 ? side : count;
}

async function askClaude(png) {
  if (process.env.PATCHRIGHT_CAPTCHA_CLAUDE_REPLY)
    return process.env.PATCHRIGHT_CAPTCHA_CLAUDE_REPLY;
  return runClaude(png);
}

function runClaude(png) {
  const command = process.env.PATCHRIGHT_CAPTCHA_CLAUDE || 'claude';
  const args = [
    '--tools', '',
    '--max-turns', '1',
    '--system-prompt', 'Reply with only the squares.',
    '-p',
    '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
  ];
  const message = {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') },
        },
        { type: 'text', text: CLAUDE_PROMPT },
      ],
    },
  };

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, cwd: os.tmpdir() });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Claude solver timed out.'));
    }, 90000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0)
        reject(new Error(`Claude solver exited ${code}: ${(stderr || stdout).slice(0, 300)}`));
      else
        resolve(claudeResultText(stdout));
    });
    child.stdin.end(JSON.stringify(message) + '\n');
  });
}

function claudeResultText(stdout) {
  let result = '';
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'result' && typeof event.result === 'string')
      result = event.result;
  }
  return result;
}

function parseSquares(text) {
  const lines = String(text).split(/\r?\n/).map((line) => line.replace(/`/g, '').trim()).filter(Boolean);
  const pairLine = [...lines].reverse().find((line) => /^(\d+\s*,\s*\d+)(\s+\d+\s*,\s*\d+)*$/.test(line));
  if (!pairLine) return [];

  const squares = [];
  for (const match of pairLine.matchAll(/(\d+)\s*,\s*(\d+)/g)) {
    const row = Number(match[1]);
    const col = Number(match[2]);
    if (row < 1 || col < 1 || row > 8 || col > 8) continue;
    squares.push({ row, col });
  }
  return squares;
}

async function clickVerify(frame) {
  const byId = frame.locator('#recaptcha-verify-button').first();
  if (await byId.count().catch(() => 0)) {
    await byId.click({ timeout: 3000 }).catch(() => {});
    return;
  }
  const named = frame.getByRole('button', { name: /verify|next|skip/i }).first();
  if (await named.count().catch(() => 0))
    await named.click({ timeout: 3000 }).catch(() => {});
}



async function findActionable(page) {
  const described = [];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame() || frame.isDetached()) continue;
    described.push({ frame, meta: await describeFrame(frame) });
  }

  for (const widget of IMAGE_WIDGETS) {
    for (const entry of described) {
      if (!widget.matches(entry.meta)) continue;
      const box = await frameBox(entry.frame);
      if (!box || box.height < 20) continue;
      if (!(await imageTileCount(entry.frame))) continue;
      return { ...widget, frame: entry.frame, image: true };
    }
  }

  for (const widget of CHECKBOX_WIDGETS) {
    for (const entry of described) {
      if (!widget.matches(entry.meta)) continue;
      if (await checkboxSolved(entry.frame, widget)) continue;
      const box = await frameBox(entry.frame);
      if (!box || box.height < 10) continue;
      return { ...widget, frame: entry.frame };
    }
  }

  return findPressAndHold(page);
}

async function describeFrame(frame) {
  const url = frame.url() || '';
  const element = await frame.frameElement().catch(() => null);
  if (!element) return { url, src: '', title: '' };
  const title = (await element.getAttribute('title').catch(() => null)) || '';
  const src = (await element.getAttribute('src').catch(() => null)) || '';
  return { url, src, title };
}

async function frameBox(frame) {
  const element = await frame.frameElement().catch(() => null);
  if (!element) return null;
  return element.boundingBox().catch(() => null);
}

async function checkboxSolved(frame, widget) {
  for (const selector of widget.selectors || []) {
    const locator = frame.locator(selector).first();
    if (!(await locator.count().catch(() => 0))) continue;
    const aria = await locator.getAttribute('aria-checked').catch(() => null);
    if (aria === 'true') return true;
    const checked = await locator.evaluate((element) => element.checked === true).catch(() => false);
    if (checked) return true;
  }
  return false;
}

async function findPressAndHold(page) {
  const hold = page
    .locator('button, [role="button"], .px-captcha, #px-captcha')
    .filter({ hasText: /press\s*(?:&|and)\s*hold/i })
    .filter({ hasText: /human|robot|captcha/i })
    .first();
  if (!(await hold.count().catch(() => 0))) return null;
  if (!(await hold.isVisible().catch(() => false))) return null;
  return { id: 'press and hold', hold };
}

async function isInterstitialTitle(page) {
  const title = await page.title().catch(() => '');
  return interstitialTitle(title);
}

async function waitUntilWidgetOrClear(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isInterstitialTitle(page))) return 'cleared';
    const widget = await findActionable(page);
    if (widget) return widget;
    await sleep(250);
  }
  return (await isInterstitialTitle(page)) ? 'stuck' : 'cleared';
}

module.exports = {
  solveCaptcha,
  parseSquares,
};
