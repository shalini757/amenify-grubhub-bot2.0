'use strict';

// Headless browser pool for the external API path.
//
// The Sheet/CDP path attaches to ONE human-launched Chrome (browser.js). That
// can't run 5 orders on 5 different signed-in emails at once, so this pool
// launches one Playwright PERSISTENT context per account (its own profile dir,
// its own Grubhub login) via playwright-extra + stealth. Stealth mitigates the
// bot-detection that a plain Playwright-launched Chromium otherwise trips — it
// does NOT eliminate it, so validate one real order before trusting all five.
//
// One context per account is enough for concurrency: the email busy-lock
// (emailPool) guarantees at most one in-flight order per account at a time. Each
// order opens its own page in that context and closes it when done.

const path = require('path');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { logger } = require('../logger');

chromium.use(stealth);

// headless by default; set HEADLESS_POOL=false to watch/debug.
const HEADLESS = String(process.env.HEADLESS_POOL || 'true').toLowerCase() !== 'false';

function profileDir(accountId) {
  const safe = String(accountId).replace(/[^a-z0-9._-]+/gi, '_');
  return path.resolve(process.cwd(), `chrome-profile-${safe}`);
}

const _contexts = new Map(); // accountId -> BrowserContext

async function launch(accountId, { headless = HEADLESS } = {}) {
  const dir = profileDir(accountId);
  const context = await chromium.launchPersistentContext(dir, {
    headless,
    viewport: { width: 1280, height: 900 },
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  logger.info({ accountId, dir, headless }, 'launched persistent browser context');
  return context;
}

// Return a launchContext-shaped handle for an account, reusing a cached
// persistent context (launched once). Matches { browser, context, accountId,
// cdpAttached } so ensureLoggedIn() and the order pipeline work unchanged.
async function acquireCtx(accountId) {
  let context = _contexts.get(accountId);
  if (!context) {
    context = await launch(accountId);
    _contexts.set(accountId, context);
    context.on('close', () => _contexts.delete(accountId));
  }
  return { browser: context.browser(), context, accountId, cdpAttached: false };
}

// Open a headful context so a human can sign in once; profile persists on disk.
async function loginContext(accountId) {
  return launch(accountId, { headless: false });
}

async function closeAll() {
  for (const [id, ctx] of Array.from(_contexts.entries())) {
    try {
      await ctx.close();
    } catch (_) { /* ignore */ }
    _contexts.delete(id);
  }
}

module.exports = { acquireCtx, loginContext, profileDir, closeAll };
