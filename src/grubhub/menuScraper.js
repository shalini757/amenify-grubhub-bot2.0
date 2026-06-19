const { logger } = require('../logger');

// ---- Menu via Grubhub's API (robust alternative to DOM scraping) ----
//
// Grubhub's web menu is virtualized: items lazily load (the `menu_items` API
// returns small batches as you scroll). Rather than parse the rendered DOM
// text (fragile — virtualization, layout, timing), we PASSIVELY capture those
// API JSON responses while the page loads/scrolls and read items straight from
// the structured payload (exact name, price in cents, category, availability).
// attachMenuApiCapture(page) wires a response listener that accumulates items;
// the caller scrolls (scrapeMenu deep already walks every category) and then
// reads getItems(). No auth replication — we only listen to calls the page
// already makes.

// Pull top-level menu items out of any Grubhub API JSON. A real menu item has a
// name, a `menu_category_id` (distinguishes it from a modifier/choice option,
// which also has name+price but no category id), and a price object with an
// integer `amount` in cents.
function extractMenuItemsFromApi(j) {
  const out = [];
  const push = (name, cents, category, available) => {
    if (!name) return;
    out.push({
      name: String(name).trim(),
      price: cents != null ? cents / 100 : null,
      category: category || null,
      available: available !== false,
    });
  };
  const visit = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { for (const v of o) visit(v); return; }
    // Shape A — /menu_items endpoint: name + menu_category_id + price.amount
    // (cents). menu_category_id distinguishes a real item from a modifier
    // option (which also has name+price but no category id).
    const priceObj = o.price || o.delivery_price || o.pickup_price;
    if (
      o.name &&
      o.menu_category_id != null &&
      priceObj && typeof priceObj === 'object' && typeof priceObj.amount === 'number'
    ) {
      push(o.name, priceObj.amount, o.menu_category_name, o.available);
    }
    // Shape B — restaurant_gateway feed entity: item_name + item_price with a
    // per-order-type {delivery|pickup}.value in cents. This is how the bulk of
    // a category's items arrive as you walk category tabs.
    if (o.item_name && o.item_price && typeof o.item_price === 'object') {
      const p = o.item_price;
      let cents = null;
      for (const key of ['delivery', 'pickup']) {
        if (p[key] && typeof p[key].value === 'number') { cents = p[key].value; break; }
      }
      if (cents == null && typeof p.value === 'number') cents = p.value;
      push(o.item_name, cents, o.menu_category_name || o.category_name || null, o.available);
    }
    for (const k of Object.keys(o)) visit(o[k]);
  };
  visit(j);
  return out;
}

// Attach a passive accumulator of menu items seen via the menu API. Returns
// { getItems, size, detach }. Safe to attach once per page for the whole run.
function attachMenuApiCapture(page) {
  const byName = new Map(); // name(lower) -> { name, price, category, available }
  const handler = (resp) => {
    (async () => {
      try {
        const req = resp.request();
        const url = req.url();
        const rt = req.resourceType();
        if (rt !== 'xhr' && rt !== 'fetch') return;
        // Menu payloads come from .../menu_items, the restaurant feed, or the
        // restaurant_gateway info endpoints. Match broadly, then let the
        // extractor decide what's actually an item.
        if (!/grubhub\.com/.test(url)) return;
        if (!/\/menu_items|restaurant_gateway\/(feed|info)|\/restaurants\/\d+(\/|$|\?)/.test(url)) return;
        const buf = await resp.body().catch(() => null);
        if (!buf || buf.length < 200) return;
        let j;
        try { j = JSON.parse(buf.toString('utf8')); } catch (_) { return; }
        for (const it of extractMenuItemsFromApi(j)) {
          if (!it.name) continue;
          const k = it.name.toLowerCase();
          if (!byName.has(k)) byName.set(k, it);
        }
      } catch (_) { /* passive — never throw */ }
    })().catch(() => {});
  };
  page.on('response', handler);
  return {
    getItems: () => Array.from(byName.values()),
    size: () => byName.size,
    detach: () => { try { page.off('response', handler); } catch (_) {} },
  };
}

// Grubhub mangles class names, so we try several selector candidates and
// fall back to scanning text-rich containers. The first run against a real
// restaurant page will tell us which selector wins — update SELECTORS
// based on what we see in the saved menu screenshot.
// Selector candidates in priority order. "restaurant-menu-item" is the
// outer wrapper on Grubhub's restaurant menu page — narrower than the
// catch-all "menu-item" wildcard which also matches upsell pills.
const SELECTORS = [
  '[data-testid="restaurant-menu-item"]',
  // Wawa-style: each product card is data-testid="Item-<numericId>".
  // Exclude the sibling -quickAdd div so we don't double-count.
  '[data-testid^="Item-"]:not([data-testid$="-quickAdd"])',
  '[data-testid*="menu-item"]',
  '[data-testid*="menuItem"]',
  'article[id^="menuItem"]',
  '[itemtype*="MenuItem"]',
  'a[href*="/menuItem/"]',
];

// Grubhub renders one category at a time. The sidebar nav exposes each
// category as <li data-testid="category_NAME">. We click through them all.
const CATEGORY_SELECTOR = '[data-testid^="category_"]';

// Matches strings that are just a price ("$2.19", "$4.89+", " $10.00 ").
// Such elements are sibling price labels and should not become menu items.
const PRICE_ONLY_RE = /^\s*\$?\s*\d+(?:\.\d{1,2})?\s*\+?\s*$/;

// Scrolls in steps and waits for item count to stabilize. Lazy-loaded menu
// sections render as you scroll past them; a fixed-distance scroll can miss
// items further down the page.
async function scrollUntilStable(page, itemSelector, maxIterations = 30) {
  let stableCount = 0;
  let lastCount = -1;
  for (let i = 0; i < maxIterations; i++) {
    await page.evaluate(() => window.scrollBy(0, 900)).catch(() => {});
    await page.waitForTimeout(280);
    const count = await page
      .$$eval(itemSelector, (els) => els.length)
      .catch(() => 0);
    if (count === lastCount) {
      stableCount += 1;
      if (stableCount >= 3) break;
    } else {
      stableCount = 0;
      lastCount = count;
    }
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(500);
  return lastCount;
}

function parseFromInnerText(text) {
  const lines = String(text || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  // Some restaurants render price BEFORE the name in the card (e.g. Wawa:
  // "$2.69\nFritos Original, 3.375 oz"). Take the first non-price line as
  // the name so price-first cards aren't rejected outright.
  const nameIdx = lines.findIndex((l) => !PRICE_ONLY_RE.test(l));
  if (nameIdx === -1) return null;
  const name = lines[nameIdx];
  if (name == null) return null;
  const priceMatch = String(text).match(/\$(\d+(?:\.\d{1,2})?)/);
  const price = priceMatch && priceMatch[1] != null ? parseFloat(priceMatch[1]) : null;
  const description = lines
    .filter((_, i) => i !== nameIdx)
    .join(' ')
    .replace(/\$\d+(?:\.\d{1,2})?/g, '')
    .trim();
  return { name, price, description };
}

async function collectVisibleItems(page, selector) {
  await scrollUntilStable(page, selector);
  const found = await page
    .$$eval(selector, (els) => els.map((el) => (el.innerText || '').trim()))
    .catch(() => []);
  return found
    .map(parseFromInnerText)
    .filter((x) => !!x && !!x.name);
}

// Accumulating scroll-and-collect: Grubhub virtualizes its menu list,
// so items get unmounted once scrolled past. A single pass after a full
// scroll-to-bottom yields only the items still in viewport (~5 on
// Taco Cabana). Instead, scroll incrementally, harvesting innerText of
// whatever menu-item nodes are currently rendered, and dedupe by name.
async function collectAllItemsByAccumulating(
  page,
  selector,
  { maxScrolls = 60 } = {},
) {
  const seen = new Map();
  let zeroAdds = 0;
  await page.evaluate(() => { const e = document.scrollingElement || document.documentElement; e.scrollTo(0, 0); }).catch(() => {});
  await page.waitForTimeout(120);

  // Bottom-driven: scroll by ~60% of the viewport, harvest each pass, and only
  // stop once we're at the TRUE bottom AND a confirming pass added nothing.
  // Early-exiting on a flat deduped count (the old stableTicks>=2) stopped on a
  // lazy-mount gap before lower rows rendered — same virtualization bug as the
  // category walk. maxScrolls is a safety valve, not the primary stop.
  for (let i = 0; i < maxScrolls; i++) {
    const got = await page
      .$$eval(selector, (els) => els.map((el) => (el.innerText || '').trim()))
      .catch(() => []);
    const sizeBefore = seen.size;
    for (const text of got) {
      const item = parseFromInnerText(text);
      if (item && item.name) {
        const key = item.name.toLowerCase();
        if (!seen.has(key)) seen.set(key, item);
      }
    }
    const addedNow = seen.size - sizeBefore;
    const geo = await page
      .evaluate(() => {
        const e = document.scrollingElement || document.documentElement;
        return { top: e.scrollTop, ch: e.clientHeight, sh: e.scrollHeight };
      })
      .catch(() => null);
    const atBottom = geo ? (geo.top + geo.ch >= geo.sh - 2) : true;
    if (addedNow === 0) zeroAdds += 1; else zeroAdds = 0;
    if (atBottom && zeroAdds >= 1) break;
    const step = geo ? Math.floor(geo.ch * 0.6) : 900;
    const prevSh = geo ? geo.sh : 0;
    await page.evaluate((st) => {
      const e = document.scrollingElement || document.documentElement;
      e.scrollBy(0, st);
    }, step).catch(() => {});
    await page
      .waitForFunction((prev) => {
        const e = document.scrollingElement || document.documentElement;
        return e.scrollHeight > prev || (e.scrollTop + e.clientHeight >= e.scrollHeight - 2);
      }, prevSh, { timeout: 350 })
      .catch(() => {});
  }
  await page.evaluate(() => { const e = document.scrollingElement || document.documentElement; e.scrollTo(0, 0); }).catch(() => {});
  return Array.from(seen.values());
}

async function scrapeMenu(page, { deep = true } = {}) {
  // Wait for the menu to be ACTIONABLE — item cards mounted OR a blocker
  // (closed/out-of-range/pickup/schedule) signal — and return the instant that
  // is true. We do NOT wait on networkidle: Grubhub's ad/tracking requests
  // never go idle, so the old `networkidle` wait always burned the full 8s on
  // every page even when the menu had already rendered in ~1s.
  await page
    .waitForFunction(() => {
      const hasItems = document.querySelector(
        '[data-testid="restaurant-menu-item"], [data-testid^="Item-"], [data-testid*="menu-item"], a[href*="/menuItem/"]',
      );
      const txt = (document.body.innerText || '').toLowerCase();
      const blocker = /delivery range|pickup[- ]only|location is pickup|not taking orders|currently closed|no longer on grubhub|schedule (my )?order/.test(txt);
      return !!hasItems || blocker;
    }, { timeout: 8000 })
    .catch(() => {});

  // Detect the "restaurant not taking orders right now" state explicitly.
  // Grubhub renders an empty menu region + a carousel of alternative
  // restaurants when the place is closed / paused / outside hours. We
  // need to distinguish this from a real selector mismatch so the human
  // review queue can route it differently (retry later vs. fix code).
  const closedSignal = await page
    .evaluate(() => {
      const sels = [
        '[data-testid="unorderable-menu-prompt"]',
        '[data-testid="unorderable-menu-prompt-body"]',
        '[data-testid="not-taking-orders-carousels"]',
        '[data-testid="closed-restaurant-message"]',
      ];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el) return { hit: s, text: (el.innerText || '').slice(0, 240) };
      }
      // Auto-opened "Schedule my order" modal — Grubhub fires this when a
      // restaurant is currently closed but accepts preorders. The modal
      // blocks the menu so any items the scraper finds behind/around it
      // are unreliable. Treat as closed so the preorder flow runs.
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      for (const dlg of Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'))) {
        if (!visible(dlg)) continue;
        const t = (dlg.innerText || '').trim();
        // "This location is pickup-only" — Grubhub blocks the menu with a modal
        // offering "Switch to pickup" / "Find delivery nearby". Detect it so the
        // caller can switch to pickup (when the order wants pickup) or route a
        // delivery order to human review (it can't be delivered from here).
        if (/pickup[- ]only|location is pickup/i.test(t)) {
          return { hit: 'pickup-only-modal', text: t.slice(0, 240) };
        }
        if (/schedule (my )?order|select a delivery time|select a pickup time/i.test(t)) {
          return { hit: 'schedule-order-modal', text: t.slice(0, 240) };
        }
      }
      return null;
    })
    .catch(() => null);
  if (closedSignal) {
    // Grubhub reuses "unorderable" UI for several distinct situations.
    // Classify by the visible text so the human review queue can route
    // out-of-range (fix address, retry) separately from actually-closed
    // (retry later / preorder).
    const t = (closedSignal.text || '').toLowerCase();
    let classification = 'unknown';
    if (closedSignal.hit === 'pickup-only-modal') {
      classification = 'pickup_only';
    } else if (closedSignal.hit === 'schedule-order-modal') {
      // Grubhub auto-opens the schedule modal only when the restaurant is
      // currently closed but accepts preorders — always classify as closed
      // so the preorder flow can pick up.
      classification = 'closed';
    } else if (
      /delivery area|out of range|doesn'?t deliver|not in (your )?(delivery|service) (area|range|zone)|outside (the )?(delivery|service) area|outside .* delivery|too far/i.test(t)
    ) {
      classification = 'out_of_range';
    } else if (
      /opens at|opens on|currently closed|closed for|not taking orders|currently unavailable|paused|will be back/i.test(t)
    ) {
      classification = 'closed';
    } else if (
      /not available on grubhub anymore|no longer on grubhub|find something that will satisfy|explore more options/i.test(t)
    ) {
      classification = 'removed';
    }
    const reason =
      classification === 'out_of_range'
        ? 'out_of_range'
        : classification === 'pickup_only'
          ? 'pickup_only'
          : 'restaurant_closed';
    logger.warn(
      { hit: closedSignal.hit, classification, visibleText: closedSignal.text },
      classification === 'out_of_range'
        ? 'restaurant marked unorderable — address out of delivery range (check pill address)'
        : 'restaurant is not taking orders right now',
    );
    return {
      items: [], count: 0, selector: null,
      reason,
      classification,
      closedSignal,
    };
  }

  let winningSelector = null;
  for (const sel of SELECTORS) {
    const n = await page.$$eval(sel, (els) => els.length).catch(() => 0);
    if (n > 0) {
      winningSelector = sel;
      break;
    }
  }

  let items = [];
  if (!winningSelector) {
    logger.warn('no menu-item selector matched anything on this page');
    return { items: [], count: 0, selector: null, reason: 'no_selector_match' };
  }

  // Shallow mode: the menu is present and NOT blocked (closed/out-of-range/
  // pickup were ruled out above). Return quickly without the heavy category-
  // walk / scroll accumulation. The caller drives item discovery via the
  // in-page search box (searchMenuItems) instead, and only falls back to a
  // deep scrape if search finds nothing. count uses the matched element count
  // so a present menu never looks "empty".
  if (!deep) {
    const elCount = await page.$$eval(winningSelector, (els) => els.length).catch(() => 0);
    const quick = await page
      .$$eval(winningSelector, (els) => els.map((el) => (el.innerText || '').trim()))
      .catch(() => []);
    const quickItems = quick
      .map(parseFromInnerText)
      .filter((x) => !!x && !!x.name);
    logger.info({ winningSelector, elCount, parsed: quickItems.length }, 'menu scrape (shallow — search will drive discovery)');
    return { items: quickItems, count: elCount, selector: winningSelector, shallow: true };
  }

  // Discover category tabs in the sidebar nav, if any.
  const categories = await page
    .$$eval(CATEGORY_SELECTOR, (els) =>
      els.map((el) => ({
        testid: el.getAttribute('data-testid'),
        name: (el.innerText || '').trim().split('\n')[0] || '',
      })),
    )
    .catch(() => []);

  // Accumulate items into a name-keyed map so dedupe happens inline and we
  // can early-stop scrolling the moment new items stop appearing.
  const itemsByName = new Map();
  const addText = (text, category) => {
    const it = parseFromInnerText(text);
    if (!it || !it.name) return;
    const key = it.name.toLowerCase();
    if (!itemsByName.has(key)) itemsByName.set(key, category ? { ...it, category } : it);
  };

  if (categories.length) {
    // Sidebar exposes category tabs. Walking each tab mounts that category's
    // (virtualized) items, which we harvest in-place. We do NOT run the
    // upfront accumulating scroll here — the tab walk covers the whole menu,
    // and running both doubled the work for no extra items.
    logger.info({ count: categories.length, names: categories.map((c) => c.name) }, 'walking category tabs for full menu');
    for (const cat of categories) {
      const escaped = String(cat.testid).replace(/"/g, '\\"');
      const sel = `[data-testid="${escaped}"]`;
      const tab = page.locator(sel).first();
      if (!(await tab.isVisible({ timeout: 800 }).catch(() => false))) continue;
      await tab.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(300);
      // Harvest this section by scrolling to its TRUE bottom. The old version
      // capped at 8 short scrolls and early-exited after 2 ticks where the
      // GLOBAL deduped size didn't grow — but a virtualized section whose lower
      // rows (e.g. a long sushi/rolls list) haven't lazily mounted yet shows no
      // growth for a couple of ticks and the walk stopped before "Salmon Mango
      // Roll" ever rendered. Now: step by ~60% of the viewport, harvest each
      // pass, and only stop once we're actually at the bottom AND a confirming
      // pass added nothing — never before bottom. Safety cap guards runaways.
      const before = itemsByName.size;
      let zeroAdds = 0;
      let reachedBottom = false;
      for (let s = 0; s < 60; s++) {
        const got = await page
          .$$eval(winningSelector, (els) => els.map((el) => (el.innerText || '').trim()))
          .catch(() => []);
        const sizeBeforeHarvest = itemsByName.size;
        for (const text of got) addText(text, cat.name);
        const addedNow = itemsByName.size - sizeBeforeHarvest;
        const geo = await page
          .evaluate(() => {
            const e = document.scrollingElement || document.documentElement;
            return { top: e.scrollTop, ch: e.clientHeight, sh: e.scrollHeight };
          })
          .catch(() => null);
        const atBottom = geo ? (geo.top + geo.ch >= geo.sh - 2) : true;
        if (atBottom) reachedBottom = true;
        if (addedNow === 0) zeroAdds += 1; else zeroAdds = 0;
        // Stop only at the bottom with at least one confirming empty pass.
        if (atBottom && zeroAdds >= 1) break;
        const step = geo ? Math.floor(geo.ch * 0.6) : 700;
        const prevSh = geo ? geo.sh : 0;
        await page.evaluate((st) => {
          const e = document.scrollingElement || document.documentElement;
          e.scrollBy(0, st);
        }, step).catch(() => {});
        // Condition-based settle: wait until the list grows or we hit bottom,
        // capped so a static section doesn't stall (replaces the fixed 120ms).
        await page
          .waitForFunction((prev) => {
            const e = document.scrollingElement || document.documentElement;
            return e.scrollHeight > prev || (e.scrollTop + e.clientHeight >= e.scrollHeight - 2);
          }, prevSh, { timeout: 350 })
          .catch(() => {});
      }
      await page.evaluate(() => { const e = document.scrollingElement || document.documentElement; e.scrollTo(0, 0); }).catch(() => {});
      logger.info({ category: cat.name, added: itemsByName.size - before, reachedBottom }, 'category scraped');
    }
  } else {
    // No category tabs: it's one long virtualized list. Use the accumulating
    // collector, which already early-stops on stable item count.
    const acc = await collectAllItemsByAccumulating(page, winningSelector);
    for (const it of acc) {
      const key = it.name.toLowerCase();
      if (!itemsByName.has(key)) itemsByName.set(key, it);
    }
    logger.info({ winningSelector, count: itemsByName.size }, 'menu scrape (accumulated across scroll)');
  }

  items = Array.from(itemsByName.values());

  logger.info(
    { selector: winningSelector, count: items.length },
    'menu scrape result',
  );

  return { items, count: items.length, selector: winningSelector };
}

// Each restaurant page has its own in-page search box
// (data-testid="menu-search-input") that filters THIS restaurant's menu — not
// a global Grubhub search. Typing a requested item name into it narrows the
// menu to the relevant cards, which both (a) sidesteps list virtualization
// that can hide items during a full scroll-scrape, and (b) gives the matcher
// a focused candidate set per requested item.
//
// Returns a deduped array of { name, price, description, matchedQuery } across
// all queries — same item shape as scrapeMenu so it can be merged straight in.

// Grubhub's per-restaurant search is fairly literal, so a single spelling of
// the requested name can come up empty (e.g. "Macaroni & Cheese" vs "Mac and
// Cheese" vs "Macaroni Cheese"). Expand a requested name into a small ordered
// set of normalized variants; searchMenuItems tries them in order and stops at
// the first that returns cards.
function expandQueryVariants(name) {
  const base = String(name || '').trim();
  if (!base) return [];
  const variants = [];
  const push = (v) => {
    const t = String(v || '').replace(/\s+/g, ' ').trim();
    if (t && !variants.some((x) => x.toLowerCase() === t.toLowerCase())) variants.push(t);
  };
  push(base);
  if (/&/.test(base)) push(base.replace(/\s*&\s*/g, ' and '));
  if (/\band\b/i.test(base)) push(base.replace(/\s+and\s+/gi, ' & '));
  // Drop a trailing parenthetical and leading size/Kids qualifiers.
  push(base.replace(/\([^)]*\)/g, ''));
  push(base.replace(/^\s*(kids?|small|medium|large|regular|lg|sm)\b\s*/i, ''));
  // Punctuation-stripped form ("Macaroni & Cheese" -> "Macaroni Cheese").
  push(base.replace(/[^a-z0-9 ]+/gi, ' '));
  // Core: the two longest significant words (covers partial-name matches).
  const words = base.replace(/[^a-z0-9 ]+/gi, ' ').split(/\s+/).filter((w) => w.length > 2);
  if (words.length > 2) push(words.slice().sort((a, b) => b.length - a.length).slice(0, 2).join(' '));
  return variants;
}

async function searchMenuItems(
  page,
  queries,
  { maxWaitMs = 5000 } = {},
) {
  const SEARCH_SELECTORS = [
    '#menu-search-input',
    '[data-testid="menu-search-input"]',
    'input[aria-label^="Search" i]',
    'input[placeholder^="Search" i]',
  ];
  let input = null;
  for (const sel of SEARCH_SELECTORS) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 1000 }).catch(() => false)) { input = loc; break; }
  }
  if (!input) {
    logger.warn('searchMenuItems: no menu search input found — skipping search-based collection');
    return [];
  }

  const seen = new Map();
  for (const raw of queries) {
    const original = String(raw || '').trim();
    if (!original) continue;
    // Grubhub's menu search is fairly literal: "Macaroni & Cheese", "Mac and
    // Cheese" and "Macaroni Cheese" surface different (or no) results. Try a
    // few normalized variants per requested item and stop at the first that
    // returns cards — so a punctuation/wording difference doesn't come up empty
    // and force a full-menu deep scrape.
    const variants = expandQueryVariants(original);
    let foundForItem = false;
    for (const query of variants) {
      // Clear then type the requested item name. The SPA's filter listens on
      // real keystrokes — input.fill() sets the value in one bulk event and the
      // filter never fires (same lesson as the address autocomplete and
      // findMenuItemViaSearch). Type character-by-character so it runs.
      await input.click({ timeout: 2000 }).catch(() => {});
      await input.fill('').catch(() => {});
      await page.waitForTimeout(120);
      await input.pressSequentially(query, { delay: 30 }).catch(() => {});

      // Wait for the filtered results to actually render and settle — condition-
      // based, NOT a blind sleep. A fixed wait either snapshots too early (0
      // results → wrongly triggers a full-menu fallback) or wastes time. We poll
      // until a menu-item selector has cards AND the count holds steady for two
      // ticks (the SPA filters incrementally), capped by maxWaitMs.
      let sel = null;
      let lastCount = -1;
      let stable = 0;
      const deadline = Date.now() + maxWaitMs;
      while (Date.now() < deadline) {
        let foundSel = null;
        let count = 0;
        for (const s of SELECTORS) {
          const n = await page.$$eval(s, (els) => els.length).catch(() => 0);
          if (n > 0) { foundSel = s; count = n; break; }
        }
        if (foundSel) {
          sel = foundSel;
          if (count === lastCount) { stable += 1; if (stable >= 2) break; }
          else { stable = 0; lastCount = count; }
        }
        await page.waitForTimeout(200);
      }
      if (!sel) {
        logger.info({ query, original }, 'searchMenuItems: no results rendered for query variant within wait');
        continue;
      }
      // Collect ALL filtered cards, scrolling through them — the search keeps
      // category headers and can spread matches down the whole page, so a single
      // viewport snapshot would miss the exact item (e.g. the real "Grilled
      // Shrimp" entrée sitting below a salad/bowl that merely mention it). Scroll
      // in steps, harvesting cards, until the harvested set stops growing.
      let added = 0;
      let totalSeenForQuery = 0;
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      let prevSize = -1;
      let stableScroll = 0;
      for (let i = 0; i < 12; i++) {
        const got = await page.$$eval(sel, (els) => els.map((el) => (el.innerText || '').trim())).catch(() => []);
        for (const text of got) {
          const it = parseFromInnerText(text);
          if (!it || !it.name) continue;
          totalSeenForQuery += 1;
          const key = it.name.toLowerCase();
          if (!seen.has(key)) { seen.set(key, { ...it, matchedQuery: original }); added += 1; }
        }
        if (seen.size === prevSize) { stableScroll += 1; if (stableScroll >= 2) break; }
        else { stableScroll = 0; prevSize = seen.size; }
        await page.evaluate(() => window.scrollBy(0, 700)).catch(() => {});
        await page.waitForTimeout(180);
      }
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      logger.info({ query, original, cardsSeen: totalSeenForQuery, newItems: added, sel }, 'searchMenuItems: query scraped (scrolled)');
      if (totalSeenForQuery > 0) { foundForItem = true; break; }
    }
    if (!foundForItem) {
      logger.info({ original, variants }, 'searchMenuItems: no results for any variant of requested item');
    }
  }

  // Clear the search box so it doesn't leave the menu filtered for later steps.
  await input.fill('').catch(() => {});
  await page.waitForTimeout(300);

  const items = Array.from(seen.values());
  logger.info({ queries: queries.length, uniqueItems: items.length }, 'searchMenuItems: done');
  return items;
}

// Parse a slot label like "7:45am" / "9:00 AM" into minutes-from-midnight,
// so we can find the slot closest to a target time. Returns null if the
// label doesn't look like a clock time.
function slotLabelToMinutes(label) {
  const m = String(label || '').match(/\b(\d{1,2}):(\d{2})\s*([AaPp])\.?\s*[Mm]\.?/);
  if (!m || m[1] == null || m[2] == null || m[3] == null) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 1 || h > 12 || min > 59) return null;
  if (h === 12) h = 0;
  if (/p/i.test(m[3])) h += 12;
  return h * 60 + min;
}

// Opens the "Schedule order" modal and picks a time slot. When `targetTime`
// is provided (parsed `{ minutesFromMidnight }`), picks the slot whose label
// is closest to that target. Otherwise picks the first valid slot — the
// closed-restaurant fallback behavior.
// Returns { ok, reason, picked } where `picked` is the slot label we chose.
async function tryPreorder(page, { saveScreenshot, targetTime } = {}) {
  // Grubhub auto-opens the Schedule modal on closed-restaurant pages, so
  // before clicking the opener button, check if it's already on screen.
  // Saves a redundant click that can race the modal mount.
  const modalAlreadyOpen = await page
    .evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      for (const dlg of Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'))) {
        if (!visible(dlg)) continue;
        const t = (dlg.innerText || '').trim();
        if (/schedule (my )?order|select a delivery time|select a pickup time/i.test(t)) return true;
      }
      return false;
    })
    .catch(() => false);

  if (!modalAlreadyOpen) {
    const opener = await page.$('[data-testid="schedule-order-button"]');
    if (!opener) return { ok: false, reason: 'no_schedule_button' };
    if (!(await opener.isVisible().catch(() => false))) {
      return { ok: false, reason: 'schedule_button_not_visible' };
    }
    await opener.click().catch(() => {});
    logger.info('clicked schedule-order-button');
    await page.waitForTimeout(1500);
  } else {
    logger.info('preorder modal already open — skipping opener click');
  }
  if (saveScreenshot) await saveScreenshot(page, 'preorder-modal-opened').catch(() => {});

  // The modal has two sections: date tabs (Now / Today / Tomorrow) and an
  // Hour dropdown. "Today" is pre-selected. We need to:
  //   1. Open the Hour dropdown (it's a select or combobox in the modal).
  //   2. Pick the first time option (e.g. "7:45am").
  //   3. Click Submit/Schedule.
  // The earlier version clicked the "Today" date tab and then "Save",
  // which submitted with no time picked and Grubhub silently no-op'd.

  // Step 1 — open the hour dropdown. Try a <select>, then a custom
  // role=combobox, then any clickable element labeled with hour/time.
  let hourOpened = false;
  const hourOpeners = [
    '[role="dialog"] select',
    '[role="dialog"] [role="combobox"]',
    '[role="dialog"] [aria-haspopup="listbox"]',
    '[role="dialog"] button:has-text("Hour")',
    '[role="dialog"] [aria-label*="hour" i]',
    '[role="dialog"] [aria-label*="time" i]',
  ];
  for (const sel of hourOpeners) {
    const el = await page.$(sel);
    if (el && (await el.isVisible().catch(() => false))) {
      await el.click().catch(() => {});
      logger.info({ via: sel }, 'opened hour dropdown');
      hourOpened = true;
      break;
    }
  }
  await page.waitForTimeout(700);

  // Step 2 — pick a time option. With `targetTime` provided, gather every
  // time-shaped option across selectors and pick the one nearest to target.
  // Without a target, fall back to "first valid slot" (closed-restaurant
  // path). The dropdown may render options inside the modal or in a sibling
  // portal, so we search the whole document, not just the dialog.
  let picked = null;
  const timeRe = /\b\d{1,2}:\d{2}\s*[ap]\.?m\.?/i;
  const optionSelectors = [
    '[role="listbox"] [role="option"]:not([aria-disabled="true"])',
    '[role="dialog"] [role="option"]:not([aria-disabled="true"])',
    'select option',
    '[role="dialog"] li:not([aria-disabled="true"])',
  ];

  async function clickOption(el, text, sel) {
    const isOptionTag = await el.evaluate((n) => n.tagName.toLowerCase() === 'option').catch(() => false);
    if (isOptionTag) {
      await el.evaluate((n) => {
        const parent = n.closest('select');
        if (parent) {
          parent.value = n.value;
          parent.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }).catch(() => {});
    } else {
      await el.click().catch(() => {});
    }
    picked = text.slice(0, 60);
    logger.info({ via: sel, picked, targetTime: targetTime ? targetTime.raw : null }, 'picked preorder time slot');
  }

  if (targetTime && Number.isFinite(targetTime.minutesFromMidnight)) {
    // Collect all time-shaped candidates across selectors, then pick the
    // one with smallest absolute distance to the target.
    const candidates = [];
    for (const sel of optionSelectors) {
      const els = await page.$$(sel).catch(() => []);
      for (const el of els) {
        const text = (await el.evaluate((n) => (n.innerText || n.textContent || '').trim()).catch(() => '')) || '';
        if (!timeRe.test(text)) continue;
        const mins = slotLabelToMinutes(text);
        if (mins == null) continue;
        candidates.push({ el, text, sel, mins });
      }
      if (candidates.length) break; // first selector that yields options wins
    }
    candidates.sort((a, b) => Math.abs(a.mins - targetTime.minutesFromMidnight) - Math.abs(b.mins - targetTime.minutesFromMidnight));
    const best = candidates[0];
    if (best) {
      logger.info(
        { target: targetTime.raw, chosen: best.text, deltaMins: best.mins - targetTime.minutesFromMidnight, choices: candidates.length },
        'matching preorder slot to target time',
      );
      await clickOption(best.el, best.text, best.sel);
    }
  } else {
    for (const sel of optionSelectors) {
      const els = await page.$$(sel).catch(() => []);
      for (const el of els) {
        const text = (await el.evaluate((n) => (n.innerText || n.textContent || '').trim()).catch(() => '')) || '';
        if (!timeRe.test(text)) continue;
        await clickOption(el, text, sel);
        break;
      }
      if (picked) break;
    }
  }

  // Some Grubhub schedule modals pre-fill the earliest slot in a single
  // time field (no dropdown to expand) and just expect you to click the
  // bottom CTA ("Delivery" / "Pickup"). If we didn't click an option above
  // but the modal already shows a time-shaped string, treat it as picked.
  if (!picked) {
    const defaultTime = await page
      .evaluate((reSrc) => {
        const re = new RegExp(reSrc, 'i');
        const dlg = document.querySelector('[role="dialog"], [aria-modal="true"]');
        if (!dlg) return null;
        const t = (dlg.innerText || '').trim();
        const m = t.match(re);
        return m ? m[0] : null;
      }, timeRe.source)
      .catch(() => null);
    if (defaultTime) {
      picked = defaultTime.slice(0, 60);
      logger.info({ defaultTime }, 'modal showed pre-filled default time — using as picked slot');
    }
  }

  if (!picked) {
    // Diagnostic: dump the modal contents so we can add the right selector.
    const diag = await page
      .evaluate(() => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        };
        const dialog = document.querySelector('[role="dialog"], [data-testid*="modal" i], [data-testid*="schedule" i]');
        const root = dialog || document.body;
        const out = [];
        for (const el of Array.from(root.querySelectorAll('button, [role="option"], [role="button"], li'))) {
          if (!visible(el)) continue;
          const t = (el.innerText || '').trim();
          if (!t) continue;
          out.push({
            text: t.slice(0, 80),
            testid: el.getAttribute('data-testid') || null,
            ariaLabel: el.getAttribute('aria-label'),
            disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
          });
          if (out.length >= 30) break;
        }
        return { dialogFound: !!dialog, candidates: out };
      })
      .catch(() => null);
    logger.warn({ diag }, 'preorder: no time slot matched — diagnostic dump');
    if (saveScreenshot) await saveScreenshot(page, 'preorder-no-slot-matched').catch(() => {});
    return { ok: false, reason: 'no_slot_picked' };
  }

  // After picking a slot, some flows close automatically; others need a
  // "Schedule" / "Save" / "Confirm" / "Apply" button click.
  await page.waitForTimeout(800);
  const confirmSelectors = [
    // Modern Grubhub modal: CTA is "Delivery" / "Pickup" — the order-type
    // word, not "Submit". Listed first because it's now the common case.
    '[role="dialog"] button:has-text("Delivery")',
    '[role="dialog"] button:has-text("Pickup")',
    '[role="dialog"] button:has-text("Submit")',
    '[role="dialog"] button:has-text("Schedule order")',
    '[role="dialog"] button:has-text("Schedule")',
    '[role="dialog"] button:has-text("Confirm")',
    '[role="dialog"] button:has-text("Save")',
    '[role="dialog"] button:has-text("Apply")',
    '[role="dialog"] button:has-text("Done")',
    '[role="dialog"] button:has-text("Continue")',
    'button:has-text("Submit")',
    'button:has-text("Schedule order")',
    '[data-testid*="confirm" i]',
    '[data-testid*="save-schedule"]',
  ];
  for (const sel of confirmSelectors) {
    const el = await page.$(sel);
    if (el && (await el.isVisible().catch(() => false))) {
      await el.click().catch(() => {});
      logger.info({ via: sel }, 'confirmed preorder slot');
      break;
    }
  }

  // Give Grubhub a moment to re-render the menu with the scheduled time.
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2500);
  if (saveScreenshot) await saveScreenshot(page, 'preorder-after-confirm').catch(() => {});
  return { ok: true, picked };
}

// Dismiss the "This location is pickup-only" modal by clicking "Switch to
// pickup". Grubhub then re-renders the menu in pickup mode. Returns true if the
// switch button was found and clicked. Only call this for pickup orders — for a
// delivery order a pickup-only location can't fulfill the request.
async function switchToPickup(page) {
  const clicked = await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    for (const dlg of Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'))) {
      if (!visible(dlg)) continue;
      for (const btn of Array.from(dlg.querySelectorAll('button, a, [role="button"]'))) {
        if (!visible(btn)) continue;
        if (/switch to pickup/i.test((btn.innerText || '').trim())) {
          btn.click();
          return true;
        }
      }
    }
    return false;
  }).catch(() => false);

  if (!clicked) {
    logger.warn('switchToPickup: "Switch to pickup" button not found in modal');
    return false;
  }
  // Wait for the pickup menu to re-render (Grubhub refetches items).
  await page
    .waitForSelector(
      '[data-testid="restaurant-menu-item"], [data-testid^="Item-"]:not([data-testid$="-quickAdd"])',
      { timeout: 8000 },
    )
    .catch(() => {});
  await page.waitForTimeout(800);
  logger.info('switchToPickup: clicked "Switch to pickup", menu re-rendered');
  return true;
}

module.exports = { scrapeMenu, searchMenuItems, tryPreorder, switchToPickup, attachMenuApiCapture, extractMenuItemsFromApi, SELECTORS };
