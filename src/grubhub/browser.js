'use strict';

const fs = require('fs');
const path = require('path');
const { chromium: stealthChromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { chromium: vanillaChromium } = require('playwright');
const { logger } = require('../logger');

// Stealth is only useful when we LAUNCH our own Chromium. When attaching
// via CDP to a real Chrome the user opened, the user's browser already
// has the right fingerprint and stealth init scripts can't apply anyway.
stealthChromium.use(StealthPlugin());

const SESSIONS_DIR = path.resolve(process.cwd(), 'sessions');
const SCREENSHOTS_DIR = path.resolve(process.cwd(), 'screenshots');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const GRUBHUB_HOME = 'https://www.grubhub.com/';
const GRUBHUB_LOGIN = 'https://www.grubhub.com/login';

class BotError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function ensureDirs() {
  for (const d of [SESSIONS_DIR, SCREENSHOTS_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function sessionFile(accountId) {
  return path.join(SESSIONS_DIR, `${accountId}.json`);
}

async function launchContext(accountId, { headless } = {}) {
  ensureDirs();
  const storageStatePath = sessionFile(accountId);
  const hasSession = fs.existsSync(storageStatePath);

  // CDP attach mode — connect to a real Chrome the user launched manually.
  // This gets us a fully real browser fingerprint that bot-detection trusts.
  // Use vanilla playwright here (stealth plugin can't apply to a remote browser).
  const cdpUrl = process.env.BROWSER_CDP_URL;
  if (cdpUrl) {
    // Long timeout: pages on grubhub.com accumulate 100+ ad/tracking iframes
    // and Playwright's initial Target.getTargets enumeration can be slow.
    const browser = await vanillaChromium.connectOverCDP(cdpUrl, { timeout: 120000 });
    const contexts = browser.contexts();
    if (!contexts.length) {
      throw new BotError('CDP_NO_CONTEXT', `No existing browser context at ${cdpUrl}. Open a tab and retry.`);
    }
    const context = contexts[0];
    logger.info(
      { accountId, cdpUrl, reusedContexts: contexts.length, hasSessionFile: hasSession },
      'attached to existing Chrome via CDP',
    );
    return { browser, context, accountId, storageStatePath, cdpAttached: true };
  }

  const useHeadless = headless != null ? headless : (process.env.HEADLESS || 'true') === 'true';

  const browser = await stealthChromium.launch({
    headless: useHeadless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  const context = await browser.newContext({
    storageState: hasSession ? storageStatePath : undefined,
    userAgent: USER_AGENT,
    viewport: { width: 1366, height: 850 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  });

  logger.info({ accountId, hasSession, headless: useHeadless }, 'browser context launched');

  return { browser, context, accountId, storageStatePath, cdpAttached: false };
}

async function detectBlockers(page) {
  const content = (await page.content()).toLowerCase();
  if (
    content.includes('captcha') ||
    content.includes('are you a robot') ||
    content.includes('verify you are human') ||
    content.includes('press and hold')
  ) {
    throw new BotError('CAPTCHA_DETECTED', 'Captcha challenge detected on page');
  }
  const twoFa =
    (await page.getByRole('textbox', { name: /verification code|one[- ]time|2fa/i }).count()) > 0 ||
    /enter the code|verification code sent/i.test(content);
  if (twoFa) {
    throw new BotError('TWO_FACTOR_REQUIRED', '2FA challenge detected on page');
  }
}

async function isLoggedIn(page) {
  try {
    const accountButton = page.getByRole('button', { name: /account|sign out|hi,/i });
    if ((await accountButton.count()) > 0) return true;
    const signInLink = page.getByRole('link', { name: /sign in|log in/i });
    if ((await signInLink.count()) > 0) return false;
    const signInBtn = page.getByRole('button', { name: /sign in|log in/i });
    if ((await signInBtn.count()) > 0) return false;
    return true;
  } catch {
    return false;
  }
}

async function ensureLoggedIn({ context, accountId }) {
  const page = await context.newPage();
  await page.goto(GRUBHUB_HOME, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await detectBlockers(page);
  const loggedIn = await isLoggedIn(page);
  if (!loggedIn) {
    await page.close();
    throw new BotError(
      'SESSION_EXPIRED',
      `Session for account ${accountId} is expired or invalid. Run: npm run login -- ${accountId}`,
    );
  }
  logger.info({ accountId }, 'session valid');
  return page;
}

async function loginFresh({ context, accountId, email, password }) {
  if (!email || !password) {
    throw new BotError('CREDENTIALS_REQUIRED', 'email and password required for fresh login');
  }
  const page = await context.newPage();
  await page.goto(GRUBHUB_LOGIN, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await detectBlockers(page);

  await page.getByRole('textbox', { name: /email/i }).fill(email);
  await page.getByRole('textbox', { name: /password/i }).fill(password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();

  await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
  await detectBlockers(page);

  const ok = await isLoggedIn(page);
  if (!ok) throw new BotError('LOGIN_FAILED', 'Login submitted but session not detected');

  await context.storageState({ path: sessionFile(accountId) });
  logger.info({ accountId }, 'fresh login saved');
  return page;
}

async function manualLoginAndSave(accountId) {
  ensureDirs();
  const browser = await stealthChromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1366, height: 850 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  await page.goto(GRUBHUB_LOGIN, { waitUntil: 'domcontentloaded' });

  logger.info({ accountId }, 'manual login: a browser window has opened');
  // eslint-disable-next-line no-console
  console.log(
    '\n========================================================',
  );
  // eslint-disable-next-line no-console
  console.log(
    `MANUAL LOGIN for account "${accountId}"\n` +
      `1. Complete login in the opened browser window (handle 2FA / captcha manually).\n` +
      `2. Wait until you see the Grubhub home page logged in.\n` +
      `3. Return here and press ENTER to save the session.\n`,
  );
  // eslint-disable-next-line no-console
  console.log('========================================================\n');

  await new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => resolve());
  });

  const loggedIn = await isLoggedIn(page);
  if (!loggedIn) {
    await browser.close();
    throw new BotError('LOGIN_NOT_DETECTED', 'Could not detect a logged-in state — try again');
  }

  await context.storageState({ path: sessionFile(accountId) });
  logger.info({ accountId, file: sessionFile(accountId) }, 'session saved');
  await browser.close();
}

// Click the global-nav address pill and replace whatever's bound with the
// resident's address from the sheet. The pill is the role="button" wrapper
// whose data-testid="tag" descendant has the location icon (use[#position])
// — that disambiguates it from the time pill ("Now") which uses a clock
// icon. After clicking, we type the address into the autocomplete input
// and pick the top Google Places suggestion. Returns true on success.
// Dismiss promotional / subscription / consent popups that Grubhub fires
// on restaurant pages (Grubhub+ pitch, cart-edit modal, upsell, etc.).
//
// Critical: the cart sidebar uses role="dialog" too. We must NOT close it.
// Two guardrails:
//   1. If the cart's checkout button is currently visible, the cart sidebar
//      is open and nothing else is overlaying it — skip dismiss entirely.
//   2. Selector list is intentionally tight — only EXPLICIT popup testids
//      and known "no thanks"-style buttons. No broad `*="close"` matching.
async function dismissPopups(page) {
  const cartButtonVisible = await page.locator('#ghs-cart-checkout-button').first()
    .isVisible({ timeout: 150 }).catch(() => false);
  if (cartButtonVisible) {
    // Cart sidebar is open with checkout button accessible — nothing to dismiss.
    return;
  }

  const before = page.url();

  const closeSelectors = [
    // Specific Grubhub modal close buttons — known testids only.
    '[data-testid="close-cart-edit-modal"]',
    '[data-testid="modal-close"]',
    // Upsell / post-add modals — scope close-button patterns INSIDE the
    // upsell container so we never click outside of it.
    '[data-testid*="upsell"] button[aria-label*="lose" i]',
    '[data-testid*="upsell"] button[aria-label*="ismiss" i]',
    '[data-testid*="recommended"] button[aria-label*="lose" i]',
    '[data-testid*="bundle"] button[aria-label*="lose" i]',
    '[data-testid*="add-on"] button[aria-label*="lose" i]',
    '[data-testid*="post-add"] button[aria-label*="lose" i]',
    // Text-based fallbacks for promotional / upsell popups. No "Skip" or
    // generic "Close" — those can match too broadly (e.g. the cart's own
    // close-X). "No thanks" / "Maybe later" / "Not now" are unique to
    // promo / upsell popups.
    'button:has-text("Not now")',
    'button:has-text("No thanks")',
    'button:has-text("No, thanks")',
    'button:has-text("No thanks!")',
    'button:has-text("Maybe later")',
    'button:has-text("Continue without")',
  ];
  let closed = 0;
  for (const sel of closeSelectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 200 }).catch(() => false)) {
      await loc.click({ timeout: 1500 }).catch(() => {});
      closed += 1;
      await page.waitForTimeout(200);
    }
  }
  if (closed) {
    logger.info({ closed, urlBefore: before, urlAfter: page.url() }, 'dismissed popups');
  }
}

// Google Places autocomplete returns zero suggestions when the typed string
// has non-standard suffixes like ", Unit: 4016" or trailing ", USA". Strip
// those so we get a real suggestion list. Verification + saved-row matching
// still use the original (street number is preserved either way).
function placesNormalize(addr) {
  return String(addr || '')
    .replace(/,\s*Unit\s*:?\s*[^,]+/gi, '')
    .replace(/,\s*Apt\s*\.?\s*:?\s*[^,]+/gi, '')
    .replace(/,\s*Suite\s*:?\s*[^,]+/gi, '')
    .replace(/,\s*Ste\s*\.?\s*:?\s*[^,]+/gi, '')
    .replace(/,\s*#\s*\S+/g, '')
    .replace(/,\s*USA\s*$/i, '')
    .replace(/,\s*United States\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function setResidentAddressViaPill(page, address) {
  if (!address) throw new BotError('NO_ADDRESS', 'setResidentAddressViaPill called without address');

  const placesAddress = placesNormalize(address);
  if (placesAddress !== address) {
    logger.info({ original: address, forPlaces: placesAddress }, 'address normalized for Places autocomplete (Unit/USA stripped)');
  }

  // Dismiss any overlay (Grubhub+ pitch, etc.) so it doesn't intercept our
  // pill click or subsequent autocomplete clicks.
  await dismissPopups(page);

  // Step 0 — Fast path: peek at the pill's current text WITHOUT clicking.
  // If it already shows the resident's address, the whole type+Update
  // flow is a no-op and Grubhub will disable Update (nothing changed),
  // hanging the bot. Skip entirely.
  const streetNumMatch = String(address).match(/^\s*(\d+)\s+([A-Za-z]+)/);
  if (streetNumMatch) {
    const streetNum = streetNumMatch[1];
    const firstWord = streetNumMatch[2];
    const pillText = await page
      .evaluate(() => {
        const buttons = document.querySelectorAll('div[role="button"], button[role="button"]');
        for (const btn of buttons) {
          const tag = btn.querySelector('[data-testid="tag"]');
          if (!tag) continue;
          const useEl = btn.querySelector('use');
          const href = useEl && (useEl.getAttribute('xlink:href') || useEl.getAttribute('href'));
          if (href !== '#position') continue;
          return (btn.innerText || '').trim();
        }
        return '';
      })
      .catch(() => '');
    if (pillText) {
      const startsWithNum = pillText.startsWith(streetNum + ' ') || pillText.startsWith(streetNum + ',');
      const wordRe = new RegExp('\\b' + firstWord + '\\b', 'i');
      if (startsWithNum && wordRe.test(pillText)) {
        logger.info({ pillText, wantedAddress: '[REDACTED]' }, 'pill already shows resident address — skipping setResidentAddressViaPill (no-op)');
        return true;
      }
    }
  }

  // Step 1 — wait for the SPA to hydrate, then find and click the pill.
  // Grubhub's restaurant page often takes 3–8s to render the global nav
  // after `goto` resolves. Poll until the pill is visible or we time out.
  async function findAndClickPill() {
    return page
      .evaluate(() => {
        const buttons = document.querySelectorAll('div[role="button"], button[role="button"]');
        for (const btn of buttons) {
          // The pill has data-testid="tag" + class global-nav-dropdown__toggle-tag,
          // and a <use xlink:href="#position"> inside (location icon).
          const tag = btn.querySelector('[data-testid="tag"]');
          if (!tag) continue;
          const useEl = btn.querySelector('use');
          const href = useEl && (useEl.getAttribute('xlink:href') || useEl.getAttribute('href'));
          if (href !== '#position') continue;
          const r = btn.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) continue;
          btn.scrollIntoView({ block: 'center' });
          btn.click();
          return { ok: true, text: (btn.innerText || '').trim().slice(0, 80) };
        }
        return { ok: false };
      })
      .catch(() => ({ ok: false }));
  }

  // Step 1a — detect "Outside of delivery range" modal that Grubhub fires
  // when the page loads with an address the restaurant doesn't serve. The
  // modal overlays the pill, so we can't click the pill. Instead click the
  // modal's "Change" button (or the page-banner "Update address" button)
  // which opens the same address-input dialog the pill normally opens.
  const outOfRangeSignal = await page
    .evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      // Look for the modal headline text first.
      const allText = document.body.innerText || '';
      const hasOutOfRange = /outside of delivery range|doesn'?t deliver to (the|your) selected address|this store doesn'?t deliver to your address/i.test(allText);
      if (!hasOutOfRange) return null;
      // Find a clickable "Change" or "Update address" / "Edit address" button.
      const candidates = Array.from(document.querySelectorAll('button, [role="button"], a[role="button"]'));
      const targets = ['change', 'update address', 'edit address'];
      for (const t of targets) {
        for (const el of candidates) {
          if (!visible(el)) continue;
          const text = (el.innerText || '').trim().toLowerCase();
          if (text === t || text.startsWith(t)) {
            el.scrollIntoView({ block: 'center' });
            el.click();
            return { matched: text, viaTarget: t };
          }
        }
      }
      return { matched: null, viaTarget: null, htmlSnippet: allText.slice(0, 200) };
    })
    .catch(() => null);
  if (outOfRangeSignal && outOfRangeSignal.matched) {
    logger.info({ via: outOfRangeSignal.viaTarget, matched: outOfRangeSignal.matched }, 'out-of-range modal: clicked Change/Update address');
    // Fall through to Step 2 — the input field should now be visible.
  } else if (outOfRangeSignal) {
    logger.warn({ snippet: outOfRangeSignal.htmlSnippet }, 'out-of-range modal detected but no Change/Update button matched — will try pill anyway');
  }

  let clicked = { ok: false };
  // If we already clicked Change/Update above, the input dialog should be
  // open — skip the pill search. Otherwise look for the pill.
  if (outOfRangeSignal && outOfRangeSignal.matched) {
    clicked = { ok: true, text: '(via Change/Update button)' };
  } else {
    const pillDeadline = Date.now() + 10000;
    while (Date.now() < pillDeadline) {
      clicked = await findAndClickPill();
      if (clicked.ok) break;
      await page.waitForTimeout(400);
    }
  }
  if (!clicked.ok) {
    logger.warn('address-pill not found after 10s wait — page may not expose it on this route');
    return false;
  }
  logger.info({ previous: clicked.text }, 'address dialog opened');
  // No fixed sleep — the input-poll loop below handles "dropdown not yet rendered".

  // Step 1.5 — Fast path: if the resident's address is already in the
  // account's saved-address list shown in the dropdown, click that row
  // instead of typing + autocomplete + Update. Saves ~10s and dodges the
  // brittle Update-button click flow entirely.
  const savedRowMatch = String(address).match(/^\s*(\d+)\s+([A-Za-z]+)/);
  if (savedRowMatch) {
    const streetNum = savedRowMatch[1];
    const firstWord = savedRowMatch[2];
    const savedRowClicked = await page
      .evaluate(({ num, word }) => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        };
        const rows = document.querySelectorAll(
          '.s-list-item-primary, [data-testid*="address-item"], [data-testid*="saved-address"], [role="option"]',
        );
        for (const row of rows) {
          if (!visible(row)) continue;
          const t = (row.innerText || '').trim();
          // Must start with the same street number AND contain the first
          // street word — defends against matching the wrong saved address.
          if (!t) continue;
          const startsWithNum = t.startsWith(num + ' ') || t.startsWith(num + ',');
          const hasFirstWord = new RegExp('\\b' + word + '\\b', 'i').test(t);
          if (!startsWithNum || !hasFirstWord) continue;
          // Click the row (or its nearest clickable ancestor).
          const clickable = row.closest('[role="option"], li, button, [role="button"]') || row;
          clickable.scrollIntoView({ block: 'center' });
          clickable.click();
          return { ok: true, text: t.slice(0, 80) };
        }
        return { ok: false };
      }, { num: streetNum, word: firstWord })
      .catch(() => ({ ok: false }));
    if (savedRowClicked.ok) {
      logger.info({ text: savedRowClicked.text }, 'clicked saved-address row (skipped type+autocomplete+Update)');
      await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
      return true;
    }
  }

  // Step 2 — find the address input that appears in the dropdown/dialog.
  //
  // Two inputs can match a loose selector on this page:
  //   (a) the ADDRESS input — lives inside the pill dropdown OR inside the
  //       "out-of-range → Change address" modal. It may be type="search".
  //   (b) the restaurant MENU search bar (#search-autocomplete-input /
  //       [data-testid="search-autocomplete-input"], also type="search"),
  //       which sits OUTSIDE any modal on the restaurant page.
  // The earlier bug typed the address into (b). The fix is NOT to ban
  // type="search" (that also kills the modal's address input) — it's to:
  //   1. prefer inputs scoped INSIDE the open modal/dialog (so (b), which is
  //      outside the modal, can't be reached), then
  //   2. fall back to address-SPECIFIC selectors on the whole page, and
  //   3. exclude ONLY the known menu-search element by id/testid.
  const EXCLUDE_MENU_SEARCH =
    ':not(#search-autocomplete-input):not([data-testid="search-autocomplete-input"])';
  // Containers that hold the address dialog/dropdown. Any input inside one of
  // these is the address input — the menu search bar is never inside a modal.
  const DIALOG_SCOPES = [
    '[role="dialog"]',
    '[aria-modal="true"]',
    '.global-nav-dropdown',
    '[class*="modal" i]',
    '[class*="Dialog" i]',
    '[class*="overlay" i]',
  ];
  const scopedInputSel = `input[type="text"]${EXCLUDE_MENU_SEARCH}, input[type="search"]${EXCLUDE_MENU_SEARCH}, input:not([type])${EXCLUDE_MENU_SEARCH}`;
  const inputSelectors = [
    // (1) Scoped-to-modal first — most reliable, can't reach the menu bar.
    ...DIALOG_SCOPES.map((scope) => `${scope} ${scopedInputSel}`),
    // (2) Address-specific selectors anywhere on the page.
    'input[placeholder="Enter an address"]',
    'input.addressInput-textInput',
    'input[type="text"][aria-label*="address" i]',
    `input[name="searchTerm"]${EXCLUDE_MENU_SEARCH}`,
  ];
  let inputHit = null;
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && !inputHit) {
    for (const sel of inputSelectors) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 250 }).catch(() => false)) {
        inputHit = { loc, sel };
        break;
      }
    }
    if (!inputHit) await page.waitForTimeout(200);
  }
  if (!inputHit) {
    logger.warn('address pill/modal opened but no address input field appeared — refusing to type');
    return false;
  }
  // Hard guard: never type the address into the MENU search bar. Identify it
  // by its specific id/testid (NOT by type="search" — the modal's address
  // input can also be type="search"). Better to bail than pollute the menu.
  const looksLikeMenuSearch = await inputHit.loc
    .evaluate((el) => {
      const id = (el.id || '').toLowerCase();
      const testid = (el.getAttribute('data-testid') || '').toLowerCase();
      const ph = (el.getAttribute('placeholder') || '').toLowerCase();
      const hay = `${id} ${testid} ${ph}`;
      return /search-autocomplete|search the menu|menu search/.test(hay);
    })
    .catch(() => false);
  if (looksLikeMenuSearch) {
    logger.warn({ via: inputHit.sel }, 'address input resolved to the menu search bar — refusing to type address into it');
    return false;
  }
  logger.info({ via: inputHit.sel }, 'address input found');

  // Step 3 — clear, type character-by-character (Google Places autocomplete
  // listens on real keystrokes; fill() drops one bulk event and the dropdown
  // never opens), then wait for autocomplete to render.
  await inputHit.loc.click({ timeout: 2000 }).catch(() => {});
  // Wipe whatever was there. Ctrl+A then Delete is the most reliable way
  // when the input has the saved address pre-filled.
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Delete').catch(() => {});
  await inputHit.loc.fill('').catch(() => {});
  // pressSequentially fires keydown/keypress/keyup per character — the
  // events Google Places actually listens on. Delay between keystrokes
  // gives the autocomplete debounce time to fire its xhr and render.
  //
  // React re-renders mid-typing can detach the input element and silently
  // drop the remaining keystrokes (seen on Webster, TX address: only
  // "450 E" landed, dropdown showed unrelated NY suggestions). Verify
  // the input value after typing and retype the missing tail.
  await inputHit.loc.pressSequentially(placesAddress, { delay: 45 }).catch(() => {});
  let typedFinal = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.waitForTimeout(250);
    typedFinal = (await inputHit.loc.inputValue().catch(() => '')) || '';
    if (typedFinal === placesAddress) break;
    const tail = placesAddress.startsWith(typedFinal) ? placesAddress.slice(typedFinal.length) : null;
    if (tail === null) {
      // Input diverged (autocomplete replaced text) — clear and retype fully.
      await inputHit.loc.click({ timeout: 1000 }).catch(() => {});
      await page.keyboard.press('Control+A').catch(() => {});
      await page.keyboard.press('Delete').catch(() => {});
      await inputHit.loc.pressSequentially(placesAddress, { delay: 45 }).catch(() => {});
    } else if (tail) {
      // Partial value — focus end of input, type the missing suffix.
      await inputHit.loc.focus().catch(() => {});
      await page.keyboard.press('End').catch(() => {});
      await page.keyboard.type(tail, { delay: 45 }).catch(() => {});
    }
  }
  if (typedFinal !== placesAddress) {
    logger.warn(
      { wanted: placesAddress, got: typedFinal },
      'address input did not retain full typed value after retries — autocomplete may not match wanted address',
    );
  }
  // Give the autocomplete network call time to round-trip (typical 300-800ms).
  await page.waitForTimeout(900);
  await page
    .waitForSelector(
      '[role="option"], .pac-container .pac-item, ul[role="listbox"] li',
      { timeout: 3500 },
    )
    .catch(() => {});

  // Screenshot the dropdown state so we can see what selectors should match.
  // Viewport-only — fullPage stalls on Grubhub's lazy-image homepage and
  // silently times out, leaving us blind when address swaps fail.
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, `${stamp}_pill-after-typing.png`),
      fullPage: false,
      timeout: 5000,
      animations: 'disabled',
    });
  } catch (_) { /* screenshot failure is non-fatal */ }

  const optionSelectors = [
    '[role="listbox"] [role="option"]',
    '[role="option"]',
    '.pac-container .pac-item',
    'ul[role="listbox"] li',
    // Broader patterns to cover non-ARIA autocomplete widgets.
    '[id^="downshift-"][role]',
    '[id*="suggestion"]',
    '[class*="suggestion"]',
    '[data-testid*="address"] [role="option"]',
    '[data-testid*="autocomplete"] [role="option"]',
    '[data-testid*="result"]',
    '[data-testid*="address-result"]',
  ];

  // Fuzzy-pick the autocomplete option that best matches the typed address.
  // Score: +5 for matching street number prefix, +3 for first street word,
  // +2 for zip, +1 for city. Picks highest score >= 8 (street num + word).
  // Falls back to first visible if no option clears the threshold.
  const want = (() => {
    const num = (String(address).match(/^\s*(\d+)/) || [])[1] || '';
    const firstWord = (String(address).match(/^\s*\d+\s+([A-Za-z]+)/) || [])[1] || '';
    const zip = (String(address).match(/\b(\d{5})(?:-\d{4})?\b/) || [])[1] || '';
    const cityMatch = String(address).match(/,\s*([^,]+),\s*[A-Z]{2}/);
    const city = cityMatch ? cityMatch[1].trim() : '';
    return { num, firstWord, zip, city };
  })();

  function scoreOption(text) {
    const t = String(text || '');
    if (!t) return 0;
    let s = 0;
    if (want.num && (t.startsWith(want.num + ' ') || t.startsWith(want.num + ','))) s += 5;
    if (want.firstWord && new RegExp('\\b' + want.firstWord + '\\b', 'i').test(t)) s += 3;
    if (want.zip && t.includes(want.zip)) s += 2;
    if (want.city && new RegExp('\\b' + want.city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(t)) s += 1;
    return s;
  }

  // Collect every visible option across all selectors, dedup by text.
  const candidates = [];
  const seenText = new Set();
  for (const sel of optionSelectors) {
    const handles = await page.locator(sel).elementHandles().catch(() => []);
    for (const h of handles) {
      const visible = await h.isVisible().catch(() => false);
      if (!visible) continue;
      const text = (await h.innerText().catch(() => '')).trim();
      if (!text || seenText.has(text)) continue;
      seenText.add(text);
      candidates.push({ handle: h, text, sel, score: scoreOption(text) });
    }
  }

  // Fallback: Grubhub's homepage uses a custom Places widget where the rows
  // don't have role="option" / .pac-item / standard classes. If our selector
  // sweep above found nothing, scan the visible DOM for any clickable
  // element whose text starts with the wanted street number — that's a
  // dropdown row in practice. Limits: visible only, text < 200 chars, near
  // the input (skip distant page chrome).
  if (!candidates.length && want.num) {
    const fallback = await page
      .evaluate((wantedNum) => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        };
        const startsWithNum = (t) =>
          t.startsWith(wantedNum + ' ') || t.startsWith(wantedNum + ',');
        const out = [];
        for (const el of document.querySelectorAll('li, button, [role="button"], div, a')) {
          if (!visible(el)) continue;
          const t = (el.innerText || '').trim();
          if (!t || t.length > 200) continue;
          if (!startsWithNum(t)) continue;
          // Tag with a unique data-attr so the host code can re-locate it.
          if (!el.hasAttribute('data-bot-autocomplete-row')) {
            el.setAttribute('data-bot-autocomplete-row', String(out.length));
          }
          out.push({ idx: out.length, text: t.slice(0, 120) });
          if (out.length >= 8) break;
        }
        return out;
      }, want.num)
      .catch(() => []);
    for (const row of fallback) {
      if (seenText.has(row.text)) continue;
      seenText.add(row.text);
      const loc = page.locator(`[data-bot-autocomplete-row="${row.idx}"]`).first();
      const handle = await loc.elementHandle().catch(() => null);
      if (!handle) continue;
      candidates.push({ handle, text: row.text, sel: 'fallback:starts-with-num', score: scoreOption(row.text) });
    }
    if (candidates.length) {
      logger.info({ count: candidates.length }, 'fallback DOM scan found dropdown rows that standard selectors missed');
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  logger.info(
    { wanted: { num: want.num, firstWord: want.firstWord, zip: want.zip, city: want.city }, top: candidates.slice(0, 4).map((c) => ({ score: c.score, text: c.text.slice(0, 80) })) },
    'autocomplete candidates ranked',
  );

  let picked = false;
  if (candidates.length && candidates[0].score >= 8) {
    await candidates[0].handle.click().catch(() => {});
    picked = true;
    logger.info({ via: candidates[0].sel, score: candidates[0].score, text: candidates[0].text.slice(0, 80) }, 'picked best-match autocomplete option');
  } else if (candidates.length) {
    // Fallback: no high-confidence match. Take the first visible to keep the
    // flow moving, but warn loudly — the resulting delivery address will
    // very likely be wrong and downstream phases should fail safely.
    await candidates[0].handle.click().catch(() => {});
    picked = true;
    logger.warn(
      { topScore: candidates[0].score, topText: candidates[0].text.slice(0, 80), wanted: want },
      'no high-confidence autocomplete match — picking first option (address may be wrong)',
    );
  } else {
    logger.warn('no autocomplete options visible — proceeding to Update click with typed text');
  }

  // Step 4 — click the "Update" button that commits the address change.
  // Grubhub's nav-bar address widget uses `.logistics-menu-update-button`;
  // fall back to a text-based match if the class hashes change.
  const updateSelectors = [
    'button.logistics-menu-update-button',
    '[data-testid*="logistics"] button:has-text("Update")',
    '[role="dialog"] button:has-text("Update")',
    'button:has-text("Update")',
  ];

  async function findUpdateBtn() {
    for (const sel of updateSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 250 }).catch(() => false)) return { btn, sel };
    }
    return null;
  }

  // Paste-based fill skips per-character keystrokes, so debounced
  // autocomplete listeners may not register the address until they see a
  // real keystroke. Wait for the Update button to be both visible AND
  // enabled; if it stays disabled, type one trailing space + backspace to
  // force the listener, then try again.
  let updateHit = null;
  const updateDeadline = Date.now() + 3000;
  while (Date.now() < updateDeadline) {
    updateHit = await findUpdateBtn();
    if (updateHit && !(await updateHit.btn.isDisabled().catch(() => true))) break;
    await page.waitForTimeout(200);
  }
  if (!updateHit || (await updateHit.btn.isDisabled().catch(() => true))) {
    logger.info('Update still disabled after paste — nudging with keystroke');
    await inputHit.loc.focus().catch(() => {});
    await page.keyboard.press('Space').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    const nudgeDeadline = Date.now() + 2000;
    while (Date.now() < nudgeDeadline) {
      updateHit = await findUpdateBtn();
      if (updateHit && !(await updateHit.btn.isDisabled().catch(() => true))) break;
      await page.waitForTimeout(200);
    }
  }

  let updated = false;
  if (updateHit) {
    await updateHit.btn.click({ timeout: 3000 }).catch(() => {});
    updated = true;
    logger.info({ via: updateHit.sel }, 'clicked Update button');
  }
  if (!updated) {
    logger.warn('no Update button found — address may not have been committed');
    // Diagnostic: dump every visible button whose text looks Update-ish,
    // plus a screenshot, so we can see what's actually on the page.
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `${stamp}_update-btn-missing.png`), fullPage: true }).catch(() => {});
    } catch (_) { /* non-fatal */ }
    const diag = await page
      .evaluate(() => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        };
        const out = [];
        for (const el of document.querySelectorAll('button, [role="button"]')) {
          if (!visible(el)) continue;
          const t = (el.innerText || '').trim();
          if (!/update|save|done|confirm|apply|submit/i.test(t)) continue;
          out.push({
            tag: el.tagName.toLowerCase(),
            text: t.slice(0, 60),
            testid: el.getAttribute('data-testid') || null,
            disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
            cls: (el.className || '').toString().slice(0, 120),
          });
          if (out.length >= 12) break;
        }
        return { url: location.href, candidates: out };
      })
      .catch(() => null);
    logger.warn({ diag }, 'Update-button diagnostic — paste the candidates list so we can add the right selector');
  }

  // Step 5 — after Update, Grubhub may pop a "Save this address?" dialog
  // asking if we want to add it to the account address book. We don't —
  // each order is for a different resident, so we dismiss without saving.
  // Try common "don't save" / "no thanks" / cancel patterns.
  await page.waitForTimeout(800);
  const dontSaveSelectors = [
    'button:has-text("Don\'t save")',
    'button:has-text("Don\'t Save")',
    'button:has-text("Do not save")',
    'button:has-text("No, thanks")',
    'button:has-text("No thanks")',
    'button:has-text("Not now")',
    'button:has-text("Skip")',
    '[role="dialog"] button:has-text("Cancel")',
    '[data-testid*="dismiss-save-address"]',
    '[data-testid*="dont-save"]',
  ];
  let dismissedSave = false;
  for (const sel of dontSaveSelectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 400 }).catch(() => false)) {
      await loc.click({ timeout: 2000 }).catch(() => {});
      dismissedSave = true;
      logger.info({ via: sel }, 'dismissed save-address prompt');
      break;
    }
  }
  // If a dialog is still open but no known "don't save" button matched,
  // dump its HTML so we can identify the button selector and add it.
  if (!dismissedSave) {
    const dialogStillOpen = await page.locator('[role="dialog"]:visible, body.openDialog').first()
      .isVisible({ timeout: 200 }).catch(() => false);
    if (dialogStillOpen) {
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const dumpPath = path.join(SCREENSHOTS_DIR, `${stamp}_save-address-prompt.html`);
        const html = await page.evaluate(() => {
          const d = document.querySelector('[role="dialog"], [aria-modal="true"], .openDialog');
          return d ? d.outerHTML : '';
        }).catch(() => '');
        if (html) {
          fs.writeFileSync(dumpPath, html, 'utf8');
          logger.warn({ dumpPath, bytes: html.length }, 'save-address prompt visible but no known dismiss button — HTML dumped');
        }
      } catch (_) { /* non-fatal */ }
    }
  }

  await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});

  // Verify the pill text actually changed to the resident's address. Clicking
  // Update with no autocomplete option picked sometimes succeeds at the UI
  // level but Grubhub silently ignores the unresolved string. Read the pill
  // again and check it now starts with the resident's street number.
  const afterPillText = await page
    .evaluate(() => {
      const btns = document.querySelectorAll('div[role="button"], button[role="button"]');
      for (const b of btns) {
        const useEl = b.querySelector('use');
        const href = useEl && (useEl.getAttribute('xlink:href') || useEl.getAttribute('href'));
        if (href === '#position') return (b.innerText || '').trim();
      }
      return '';
    })
    .catch(() => '');
  const wantedNum = (String(address).match(/^\s*(\d+)/) || [])[1] || '';
  const verified = wantedNum && (afterPillText.startsWith(wantedNum + ' ') || afterPillText.startsWith(wantedNum + ','));

  logger.info(
    { picked, updated, dismissedSave, verified, pillBefore: clicked.text, pillAfter: afterPillText.slice(0, 80) },
    'resident address set via pill',
  );

  if (!verified) {
    logger.warn(
      { pillAfter: afterPillText.slice(0, 80), wanted: wantedNum },
      'pill text did NOT change to resident address after Update — address swap silently failed',
    );
    return false;
  }
  return true;
}

// Grubhub stores the delivery-vs-pickup mode in localStorage under the
// key `ngStorage-cartState` as a JSON blob. The orderType field is:
//   - 'standard' → delivery
//   - 'pickup'   → pickup
// There's no visible tab on the restaurant page to toggle this — the SPA
// reads it on mount. So we must set it BEFORE navigating to the
// restaurant URL. Pass `orderType` as 'delivery' | 'pickup' (the values
// the rest of the codebase uses), this function maps to Grubhub's wire
// format. A no-op if orderType is null/empty (don't disturb the user's
// existing setting).
async function setGrubhubOrderType(page, orderType) {
  if (!orderType) return { skipped: true, reason: 'no orderType' };
  const wire = orderType === 'pickup' ? 'pickup' : 'standard';
  await page.goto(GRUBHUB_HOME, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  const res = await page
    .evaluate((wireMode) => {
      const KEY = 'ngStorage-cartState';
      let parsed;
      try {
        const raw = window.localStorage.getItem(KEY);
        parsed = raw ? JSON.parse(raw) : {};
      } catch (_) { parsed = {}; }
      const before = parsed.orderType || null;
      parsed.orderType = wireMode;
      try {
        window.localStorage.setItem(KEY, JSON.stringify(parsed));
      } catch (e) {
        return { ok: false, error: e.message, before };
      }
      return { ok: true, before, after: wireMode };
    }, wire)
    .catch((e) => ({ ok: false, error: e.message }));
  logger.info({ orderType, wire, ...res }, 'set Grubhub orderType in localStorage');
  return res;
}

// Per-order state reset: navigate to grubhub.com and remove ONLY the stale
// per-order keys (bound delivery address, cart state, recently-viewed
// restaurants) that leak from the previous row and trigger the
// "save this address?" / out-of-range modal on order #2+.
//
// IMPORTANT: do NOT wipe all of localStorage. Grubhub's SPA keeps part of the
// logged-in session in localStorage (not only cookies), so a full clear makes
// the nav rehydrate in a SIGNED-OUT state on reload and assertSignedIn then
// throws SESSION_EXPIRED even though the auth cookie is still valid. So we
// remove a denylist of cart/address keys and explicitly preserve anything that
// looks like auth/token/user/session/login.
async function clearGrubhubStorage(page) {
  await page.goto(GRUBHUB_HOME, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  const res = await page
    .evaluate(() => {
      // Keys that carry the stale per-order state we want gone.
      const STALE_RE = /cart|address|location|delivery|recent|restaurant|logistics|ngStorage-cartState/i;
      // Keys we must never touch — they carry the login/session.
      const KEEP_RE = /auth|token|session|login|user|account|credential|jwt|oauth|perimeterx|_px/i;
      const out = { removed: [], kept: 0, localStorageKeys: 0, sessionStorageKeys: 0 };
      try {
        const keys = Object.keys(window.localStorage);
        out.localStorageKeys = keys.length;
        for (const k of keys) {
          if (KEEP_RE.test(k)) { out.kept += 1; continue; }
          if (STALE_RE.test(k)) {
            window.localStorage.removeItem(k);
            out.removed.push(k);
          }
        }
      } catch (_) { /* storage may be disabled */ }
      // sessionStorage is per-tab and safe to clear fully — it does not hold
      // the persisted login (that lives in cookies + localStorage).
      try {
        out.sessionStorageKeys = window.sessionStorage.length;
        window.sessionStorage.clear();
      } catch (_) { /* storage may be disabled */ }
      return out;
    })
    .catch(() => ({ removed: [], kept: 0, localStorageKeys: 0, sessionStorageKeys: 0 }));
  logger.info(
    { removed: res.removed, removedCount: res.removed.length, kept: res.kept, localStorageKeys: res.localStorageKeys },
    'cleared stale per-order localStorage keys (auth/session keys preserved)',
  );
  // Reload so the SPA re-initializes without the stale cart/address state.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(800);
  return res;
}

async function saveScreenshot(page, label) {
  ensureDirs();
  const safe = String(label || 'screenshot').replace(/[^a-z0-9_-]/gi, '_');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(SCREENSHOTS_DIR, `${ts}_${safe}.png`);
  // fullPage on Grubhub menus can stall past 30s waiting for lazy images.
  // Viewport-only with a short timeout is enough for debugging and never blocks the run.
  try {
    await page.screenshot({ path: file, fullPage: false, timeout: 10000, animations: 'disabled' });
    logger.info({ file, label }, 'screenshot saved');
    return file;
  } catch (err) {
    logger.warn({ label, err: err && err.message }, 'screenshot failed — continuing');
    return null;
  }
}

module.exports = {
  BotError,
  launchContext,
  ensureLoggedIn,
  loginFresh,
  manualLoginAndSave,
  saveScreenshot,
  detectBlockers,
  isLoggedIn,
  clearGrubhubStorage,
  setResidentAddressViaPill,
  setGrubhubOrderType,
  dismissPopups,
};
