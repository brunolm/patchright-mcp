/**
 * Detects a captcha on the current page and tries to clear it.
 *
 * Checkbox widgets (Cloudflare Turnstile, reCAPTCHA, hCaptcha) are clicked
 * in-page. Turnstile keeps its checkbox in a closed shadow root, so when no
 * selector matches we click the left side of the widget iframe. Image grids
 * are solved by a local object detector (captcha-detector.js).
 */

const { pickTiles, targetLabels } = require('./captcha-detector');

const TILE_SELECTOR = '.rc-imageselect-tile, .task-image';
const IMAGE_ROUNDS = 10;

const CAPTCHA_TYPES = ['cloudflare', 'recaptcha', 'hcaptcha', 'press-and-hold'];

const IMAGE_WIDGETS = [
  {
    id: 'recaptcha image',
    type: 'recaptcha',
    matches: ({ url, src }) => /\/recaptcha\/(?:api2|enterprise)\/bframe/i.test(`${url} ${src}`),
  },
  {
    id: 'hcaptcha image',
    type: 'hcaptcha',
    matches: ({ url, src }) => /hcaptcha\.com/i.test(`${url} ${src}`) && /frame=challenge/i.test(`${url} ${src}`),
  },
];

const CHECKBOX_WIDGETS = [
  {
    id: 'turnstile',
    type: 'cloudflare',
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
    type: 'recaptcha',
    matches: ({ url, src }) => /\/recaptcha\/(?:api2|enterprise)\/anchor/i.test(`${url} ${src}`),
    selectors: ['#recaptcha-anchor'],
  },
  {
    id: 'hcaptcha',
    type: 'hcaptcha',
    matches: ({ url, src, title }) => {
      const haystack = `${url} ${src} ${title}`;
      return /hcaptcha/i.test(haystack) && !/frame=challenge/i.test(haystack);
    },
    selectors: ['#checkbox', '#anchor'],
  },
];

const DEFAULTS = {
  types: [],
  solveTimeoutMs: 12000,
  appearTimeoutMs: 8000,
  interstitialTimeoutMs: 30000,
  maxAttempts: 2,
  holdMs: 4000,
};

const PENDING_SELECTORS = {
  cloudflare: ['.cf-turnstile', '#cf-turnstile', 'iframe[src*="challenges.cloudflare.com"]', 'iframe[title*="security challenge" i]'],
  recaptcha: ['.g-recaptcha', 'iframe[src*="recaptcha"]'],
  hcaptcha: ['.h-captcha', 'iframe[src*="hcaptcha"]'],
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withDefaults(options) {
  return { ...DEFAULTS, ...options };
}

/**
 * Expands the captcha type names the user chose into the types the solver
 * handles. `all` means every type; unknown names are dropped.
 */
function resolveCaptchaTypes(names) {
  if (names.includes('all')) return [...CAPTCHA_TYPES];
  return CAPTCHA_TYPES.filter((type) => names.includes(type));
}

/**
 * Solves only captchas whose type is listed in `options.types`. With no types
 * it does nothing.
 */
async function solveCaptcha(page, options) {
  const settings = withDefaults(options);
  const { types } = settings;
  if (!types.length || !page || page.isClosed()) return { action: null };
  if (await responseTokenFilled(page)) return { action: null };

  const notes = [];
  let pending = null;
  for (let attempt = 0; attempt < settings.maxAttempts; attempt++) {
    if (await responseTokenFilled(page)) break;
    let widget = await findActionable(page, types);
    if (!widget && attempt === 0) {
      if (types.includes('cloudflare') && await isInterstitialTitle(page)) {
        const waited = await waitUntilWidgetOrClear(page, types, settings.appearTimeoutMs);
        if (waited === 'cleared') {
          notes.push('Solved cloudflare interstitial.');
          break;
        }
        if (waited === 'stuck') {
          notes.push('Captcha still present (cloudflare interstitial).');
          break;
        }
        widget = waited;
      } else if (await captchaHostPending(page, types)) {
        widget = await waitForActionable(page, types, settings.appearTimeoutMs);
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

async function captchaHostPending(page, types) {
  const selector = types.flatMap((type) => PENDING_SELECTORS[type] || []).join(', ');
  if (!selector) return false;
  const count = await page.locator(selector).count().catch(() => 0);
  return count > 0;
}

async function waitForActionable(page, types, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await responseTokenFilled(page)) return null;
    const widget = await findActionable(page, types);
    if (widget) return widget;
    await sleep(250);
  }
  if (await responseTokenFilled(page)) return null;
  return findActionable(page, types);
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
  const outcome = await waitForClear(page, widget, settings.types, timeoutMs);
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

async function waitForClear(page, widget, types, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await clearanceState(page, widget, types);
    if (state) return state;
    await sleep(200);
  }
  return (await clearanceState(page, widget, types)) || { cleared: false };
}

// A reloaded widget is a new attempt, not a pass. An interstitial whose frame
// disappeared is still in progress until the title leaves the challenge.
async function clearanceState(page, widget, types) {
  const image = await findVisibleImageWidget(page, types);
  if (image) return { cleared: false, image };
  if (page.isClosed() || (await responseTokenFilled(page))) return { cleared: true };
  if (!widget.frame.isDetached() && (await checkboxSolved(widget.frame, widget)))
    return { cleared: true };
  if (!widget.frame.isDetached()) return null;

  const next = await findActionable(page, types);
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

async function findVisibleImageWidget(page, types) {
  for (const frame of page.frames()) {
    if (frame === page.mainFrame() || frame.isDetached()) continue;
    const url = frame.url() || '';
    const widget = IMAGE_WIDGETS.find((item) => types.includes(item.type) && item.matches({ url, src: '', title: '' }));
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
  let unknownTarget = null;
  for (let round = 0; round < IMAGE_ROUNDS; round++) {
    if (widget.frame.isDetached() || (await responseTokenFilled(widget.frame.page())))
      return { ok: true, note: `Solved ${widget.id} captcha.` };
    if (!(await imageTileCount(widget.frame)))
      return { ok: true };

    await waitForTileSwaps(widget.frame);
    await waitForTiles(widget.frame);
    const tiles = await tileBoxes(widget.frame);
    if (!tiles) {
      await sleep(500);
      continue;
    }

    const choice = await chooseTiles(widget.frame, tiles);
    if (choice.unknownTarget) {
      unknownTarget = choice.unknownTarget;
      await clickReload(widget.frame);
      await sleep(1500);
      continue;
    }
    if (!choice.picked.length) {
      await clickVerify(widget.frame);
      await sleep(700);
      continue;
    }

    const before = await tileSignature(widget.frame);
    await clickTiles(widget.frame, choice.picked);
    if (widget.frame.isDetached() || (await responseTokenFilled(widget.frame.page())))
      return { ok: true, note: `Solved ${widget.id} captcha.` };
    await sleep(700);
    if (await tilesSwapping(widget.frame)) continue;
    const after = await tileSignature(widget.frame);
    if (after && before && after !== before) continue;
    await clickVerify(widget.frame);
    await sleep(700);
  }

  if (widget.frame.isDetached() || !(await frameBox(widget.frame)) || (await responseTokenFilled(widget.frame.page())))
    return { ok: true, note: `Solved ${widget.id} captcha.` };
  const reason = unknownTarget ? ` The detector cannot find "${unknownTarget}".` : '';
  return { ok: false, note: `Captcha still present (${widget.id}).${reason}` };
}

/**
 * Tile boxes in page coordinates, in DOM order, with whether each tile is
 * already selected. Null when any tile has no layout box.
 */
async function tileBoxes(frame) {
  const tiles = frame.locator(TILE_SELECTOR);
  const count = await tiles.count().catch(() => 0);
  if (!count) return null;
  const selected = await tiles.evaluateAll((elements) => elements.map((element) =>
    element.classList.contains('rc-imageselect-tileselected') || element.getAttribute('aria-pressed') === 'true',
  )).catch(() => []);

  const boxes = [];
  for (let index = 0; index < count; index++) {
    const box = await tiles.nth(index).boundingBox().catch(() => null);
    if (!box) return null;
    boxes.push({ ...box, selected: Boolean(selected[index]) });
  }
  return boxes;
}

// PATCHRIGHT_CAPTCHA_SQUARES ("row,col row,col") replaces the detector, so
// tests can drive the click flow without the model.
async function chooseTiles(frame, tiles) {
  const columns = await tileColumns(frame, tiles.length);
  const fixed = process.env.PATCHRIGHT_CAPTCHA_SQUARES;
  let picked;
  if (fixed) {
    picked = parseSquares(fixed).map(({ row, col }) => (row - 1) * columns + (col - 1));
  } else {
    const instructions = await instructionText(frame);
    const labels = targetLabels(instructions);
    if (!labels) return { unknownTarget: instructions || 'the requested object' };
    picked = await detectTiles(frame, tiles, columns, labels);
  }
  return { picked: picked.filter((index) => tiles[index] && !tiles[index].selected) };
}

async function instructionText(frame) {
  const texts = await frame.locator('.rc-imageselect-instructions, .prompt-text').allInnerTexts().catch(() => []);
  return texts.join(' ').replace(/\s+/g, ' ').trim();
}

async function detectTiles(frame, tiles, columns, labels) {
  const left = Math.min(...tiles.map((tile) => tile.x));
  const top = Math.min(...tiles.map((tile) => tile.y));
  const right = Math.max(...tiles.map((tile) => tile.x + tile.width));
  const bottom = Math.max(...tiles.map((tile) => tile.y + tile.height));
  const png = await frame.page().screenshot({
    type: 'png',
    scale: 'css',
    animations: 'disabled',
    timeout: 8000,
    clip: { x: left, y: top, width: right - left, height: bottom - top },
  });
  const relative = tiles.map((tile) => ({ x: tile.x - left, y: tile.y - top, width: tile.width, height: tile.height }));
  return pickTiles(png, relative, columns, labels);
}

async function clickTiles(frame, indices) {
  const tiles = frame.locator(TILE_SELECTOR);
  for (const index of indices) {
    await tiles.nth(index).click({ timeout: 3000 }).catch((error) => {
      if (!isGoneError(error)) throw error;
    });
    if (frame.isDetached()) return;
    await sleep(200);
  }
}

async function clickReload(frame) {
  const button = frame.locator('#recaptcha-reload-button, .refresh.button').first();
  if (await button.count().catch(() => 0))
    await button.click({ timeout: 3000 }).catch(() => {});
}

async function imageTileCount(frame) {
  return frame.locator(TILE_SELECTOR).count().catch(() => 0);
}

async function waitForTileSwaps(frame) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (!(await tilesSwapping(frame))) return;
    await sleep(250);
  }
}

// reCAPTCHA grids that say "click verify once there are none left" fade a
// clicked tile out and a new picture in over several seconds. The old src
// stays until the fade-out ends, so a src comparison alone misses the swap.
async function tilesSwapping(frame) {
  return frame.locator(TILE_SELECTOR).evaluateAll((elements) => elements.some((element) =>
    element.classList.contains('rc-imageselect-dynamic-selected') || Number(getComputedStyle(element).opacity) < 0.95,
  )).catch(() => false);
}

async function waitForTiles(frame) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (await tilesReady(frame)) return;
    await sleep(200);
  }
}

async function tilesReady(frame) {
  return frame.locator(TILE_SELECTOR).evaluateAll((elements) => {
    if (!elements.length) return false;
    return elements.every((element) => {
      const image = element.querySelector('img');
      if (image) return image.complete && image.naturalWidth > 0;
      const background = getComputedStyle(element).backgroundImage;
      return Boolean(background) && background !== 'none';
    });
  }).catch(() => false);
}

async function tileSignature(frame) {
  return frame.locator(TILE_SELECTOR).evaluateAll((elements) => elements.map((element) => {
    const image = element.querySelector('img');
    if (image && image.src) return image.src.slice(-48);
    return getComputedStyle(element).backgroundImage.slice(-48);
  }).join('|')).catch(() => '');
}

async function tileColumns(frame, count) {
  const className = await frame.locator('table').first().getAttribute('class').catch(() => null);
  const match = className && className.match(/rc-imageselect-table-(\d)/);
  if (match) return Number(match[1]);
  const side = Math.round(Math.sqrt(count));
  return side >= 1 ? side : count;
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

async function findActionable(page, types) {
  const described = [];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame() || frame.isDetached()) continue;
    described.push({ frame, meta: await describeFrame(frame) });
  }

  for (const widget of IMAGE_WIDGETS) {
    if (!types.includes(widget.type)) continue;
    for (const entry of described) {
      if (!widget.matches(entry.meta)) continue;
      const box = await frameBox(entry.frame);
      if (!box || box.height < 20) continue;
      if (!(await imageTileCount(entry.frame))) continue;
      return { ...widget, frame: entry.frame, image: true };
    }
  }

  for (const widget of CHECKBOX_WIDGETS) {
    if (!types.includes(widget.type)) continue;
    for (const entry of described) {
      if (!widget.matches(entry.meta)) continue;
      if (await checkboxSolved(entry.frame, widget)) continue;
      const box = await frameBox(entry.frame);
      if (!box || box.height < 10) continue;
      return { ...widget, frame: entry.frame };
    }
  }

  if (!types.includes('press-and-hold')) return null;
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

async function waitUntilWidgetOrClear(page, types, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isInterstitialTitle(page))) return 'cleared';
    const widget = await findActionable(page, types);
    if (widget) return widget;
    await sleep(250);
  }
  return (await isInterstitialTitle(page)) ? 'stuck' : 'cleared';
}

module.exports = {
  CAPTCHA_TYPES,
  resolveCaptchaTypes,
  solveCaptcha,
  parseSquares,
};
