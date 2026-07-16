'use strict';

// Read-only Grubhub API capture.
//
// Attaches to the Chrome you started with `npm run chrome` (over CDP) and
// records every Grubhub XHR/fetch (request + response JSON) that happens while
// you use the site normally. It places NO orders and changes NOTHING — it only
// listens. The goal is to learn the real API contract (menu + modifier groups +
// cart) so we can read modifier requirements as JSON instead of scraping the
// DOM modal.
//
// Usage:
//   1. npm run chrome           (Chrome opens, signed in, address set)
//   2. node scripts/captureApi.js
//   3. In that Chrome: open a restaurant, open an item that has required
//      choices, pick options, and Add to bag. Maybe open the cart + checkout.
//   4. Ctrl+C here. Output lands in ./api-capture/
//
// Output:
//   api-capture/index.jsonl       one summary line per captured exchange
//   api-capture/NNNN-<slug>.json  full detail (url, headers, post body, response)
//   api-capture/auth-storage.json localStorage/sessionStorage snapshot (token lives here)
//
// NOTE: api-capture/ can contain your live auth token — it's gitignored. Don't
// share those files.

require('dotenv/config');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const CDP = process.env.BROWSER_CDP_URL || 'http://localhost:9222';
const OUT = path.resolve(process.cwd(), 'api-capture');
const INDEX = path.join(OUT, 'index.jsonl');
const MAX_BODY = 3 * 1024 * 1024; // cap stored response body at 3MB

// Skip noise: only keep XHR/fetch to *.grubhub.com, and drop analytics/tracking/
// media even on grubhub hosts.
const DENY = [
  'scribe', 'analytics', 'beacon', 'perimeterx', 'px-cdn', 'px-cloud', 'captcha',
  'sentry', 'datadog', 'doubleclick', 'googletag', 'google-analytics', 'branch.io',
  'segment.', 'amplitude', 'optimizely', 'mparticle', '/metrics', '/telemetry',
  'media-cdn', 'images/', '.jpg', '.jpeg', '.png', '.gif', '.css', '.woff', '.svg',
  '.js', '.ico', 'fonts.', 'tracking',
  // analytics/content noise seen on grubhub hosts
  'clickstream', 'featureflags', '/v1/events', 'consumer_engagement',
  'diner_events', 'topics-gateway', 'topics_gateway',
];

function isApi(url, type) {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith('grubhub.com')) return false;
    if (type !== 'xhr' && type !== 'fetch') return false;
    const low = url.toLowerCase();
    if (DENY.some((d) => low.includes(d))) return false;
    return true;
  } catch (_) {
    return false;
  }
}

function slugify(url) {
  return url
    .replace(/^https?:\/\//, '')
    .replace(/\?.*$/, '')
    .replace(/[^a-z0-9]+/gi, '_')
    .slice(0, 60);
}

let n = 0;

async function onResponse(resp) {
  let req;
  try {
    req = resp.request();
  } catch (_) {
    return;
  }
  const url = req.url();
  const type = req.resourceType();
  if (!isApi(url, type)) return;

  n += 1;
  const id = String(n).padStart(4, '0');
  const method = req.method();
  const status = resp.status();

  let body = '';
  let bodyBytes = 0;
  let isJson = false;
  let parsed = null;
  try {
    const buf = await resp.body();
    bodyBytes = buf.length;
    body = buf.toString('utf8');
    try {
      parsed = JSON.parse(body);
      isJson = true;
    } catch (_) { /* not json */ }
  } catch (e) {
    body = `<<no body: ${e.message}>>`;
  }

  let postData = null;
  let postJson = null;
  try {
    postData = req.postData();
    if (postData) {
      try { postJson = JSON.parse(postData); } catch (_) { /* keep raw */ }
    }
  } catch (_) { /* ignore */ }

  // allHeaders() (async) includes security headers like Authorization / Cookie
  // that the sync headers() omits — we need those to replicate calls.
  let reqHeaders = {};
  try { reqHeaders = await req.allHeaders(); } catch (_) {
    try { reqHeaders = req.headers(); } catch (_) { reqHeaders = {}; }
  }
  let resHeaders = {};
  try { resHeaders = await resp.allHeaders(); } catch (_) {
    try { resHeaders = resp.headers(); } catch (_) { resHeaders = {}; }
  }

  const summary = {
    id,
    ts: new Date().toISOString(),
    method,
    status,
    url: url.split('?')[0].slice(0, 160),
    type,
    bodyBytes,
    isJson,
    hasAuth: !!reqHeaders.authorization,
    hasPost: !!postData,
  };
  try { fs.appendFileSync(INDEX, JSON.stringify(summary) + '\n'); } catch (_) {}

  const detail = {
    ...summary,
    fullUrl: url,
    requestHeaders: reqHeaders,
    requestPostData: postJson || postData || null,
    responseHeaders: resHeaders,
    responseBody: isJson
      ? parsed
      : (typeof body === 'string' ? body.slice(0, MAX_BODY) : body),
  };
  try {
    fs.writeFileSync(path.join(OUT, `${id}-${slugify(url)}.json`), JSON.stringify(detail, null, 2));
  } catch (e) {
    console.log(`  (could not write detail for ${id}: ${e.message})`);
  }

  const flags = `${bodyBytes}b${isJson ? ' json' : ''}${postData ? ' +POST' : ''}${reqHeaders.authorization ? ' +auth' : ''}`;
  console.log(`[${id}] ${method} ${status}  ${url.split('?')[0].slice(0, 100)}  (${flags})`);
}

async function dumpStorage(context) {
  const ghPage = context.pages().find((p) => {
    try { return p.url().includes('grubhub.com'); } catch (_) { return false; }
  });
  if (!ghPage) {
    console.log('No grubhub.com tab open yet — storage snapshot skipped (navigate there, it is re-read on exit).');
    return;
  }
  try {
    const store = await ghPage.evaluate(() => {
      const out = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        out['local:' + k] = localStorage.getItem(k);
      }
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        out['session:' + k] = sessionStorage.getItem(k);
      }
      return out;
    });
    fs.writeFileSync(path.join(OUT, 'auth-storage.json'), JSON.stringify(store, null, 2));
    const tokenish = Object.keys(store).filter((k) => /token|auth|bearer|session|access|credential/i.test(k));
    console.log('Saved storage snapshot → api-capture/auth-storage.json');
    console.log('Token-ish keys:', tokenish.length ? tokenish.join(', ') : '(none matched — inspect the file)');
  } catch (e) {
    console.log('Storage snapshot failed:', e.message);
  }
}

async function main() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  console.log(`Connecting to Chrome at ${CDP} ...`);
  const browser = await chromium.connectOverCDP(CDP, { timeout: 30000 });
  const context = browser.contexts()[0] || (await browser.newContext());

  const wire = (page) => {
    page.on('response', (r) => { onResponse(r).catch(() => {}); });
  };
  context.pages().forEach(wire);
  context.on('page', wire); // catch newly opened tabs too

  await dumpStorage(context);

  console.log('');
  console.log('● LISTENING — go to the Chrome window and:');
  console.log('   1. open a restaurant menu');
  console.log('   2. open an item that has required choices');
  console.log('   3. pick options and Add to bag');
  console.log('   4. (optional) open the cart / start checkout');
  console.log('   Then press Ctrl+C here to stop. Captures → ./api-capture/');
  console.log('');

  const shutdown = async () => {
    console.log(`\nCaptured ${n} Grubhub API exchange(s) → ${OUT}`);
    try { await dumpStorage(context); } catch (_) {}
    try { await browser.close(); } catch (_) {} // CDP: just disconnects, leaves Chrome running
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  browser.on('disconnected', () => {
    console.log(`\nChrome connection closed. Captured ${n} exchange(s) → ${OUT}`);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('captureApi failed:', err.message);
  if (/ECONNREFUSED|connect/i.test(err.message)) {
    console.error('Is Chrome running with the debug port? Start it: npm run chrome');
  }
  process.exit(1);
});
