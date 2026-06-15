'use strict';

const { logger } = require('../logger');

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
  const priceMatch = String(text).match(/\$(\d+(?:\.\d{1,2})?)/);
  const price = priceMatch ? parseFloat(priceMatch[1]) : null;
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
  return found.map(parseFromInnerText).filter((x) => x && x.name);
}

// Accumulating scroll-and-collect: Grubhub virtualizes its menu list,
// so items get unmounted once scrolled past. A single pass after a full
// scroll-to-bottom yields only the items still in viewport (~5 on
// Taco Cabana). Instead, scroll incrementally, harvesting innerText of
// whatever menu-item nodes are currently rendered, and dedupe by name.
async function collectAllItemsByAccumulating(page, selector, { maxScrolls = 40, scrollStep = 900 } = {}) {
  const seen = new Map();
  let stableTicks = 0;
  let lastSize = -1;
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(120);

  for (let i = 0; i < maxScrolls; i++) {
    const got = await page
      .$$eval(selector, (els) => els.map((el) => (el.innerText || '').trim()))
      .catch(() => []);
    for (const text of got) {
      const item = parseFromInnerText(text);
      if (item && item.name) {
        const key = item.name.toLowerCase();
        if (!seen.has(key)) seen.set(key, item);
      }
    }
    if (seen.size === lastSize) {
      stableTicks += 1;
      // Two stable ticks is enough — virtualization is deterministic.
      if (stableTicks >= 2) break;
    } else {
      stableTicks = 0;
      lastSize = seen.size;
    }
    await page.evaluate((step) => window.scrollBy(0, step), scrollStep).catch(() => {});
    await page.waitForTimeout(230);
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  return Array.from(seen.values());
}

async function scrapeMenu(page) {
  // 8s is enough on a hot SPA — the page has already had time to render
  // by the time we get here (the dry-run waits for menu items first).
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

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
      for (const dlg of document.querySelectorAll('[role="dialog"], [aria-modal="true"]')) {
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

  // Discover category tabs in the sidebar nav, if any.
  const categories = await page
    .$$eval(CATEGORY_SELECTOR, (els) =>
      els.map((el) => ({
        testid: el.getAttribute('data-testid'),
        name: (el.innerText || '').trim().split('\n')[0],
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
      // Scroll this section, harvesting virtualized items as they mount.
      // Early-stop once two consecutive scrolls add nothing new instead of
      // always burning the full 8 iterations.
      const before = itemsByName.size;
      let stable = 0;
      let prevSize = itemsByName.size;
      for (let s = 0; s < 8; s++) {
        const got = await page
          .$$eval(winningSelector, (els) => els.map((el) => (el.innerText || '').trim()))
          .catch(() => []);
        for (const text of got) addText(text, cat.name);
        if (itemsByName.size === prevSize) {
          stable += 1;
          if (stable >= 2) break;
        } else {
          stable = 0;
          prevSize = itemsByName.size;
        }
        await page.evaluate(() => window.scrollBy(0, 700)).catch(() => {});
        await page.waitForTimeout(120);
      }
      logger.info({ category: cat.name, added: itemsByName.size - before }, 'category scraped');
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

// Parse a slot label like "7:45am" / "9:00 AM" into minutes-from-midnight,
// so we can find the slot closest to a target time. Returns null if the
// label doesn't look like a clock time.
function slotLabelToMinutes(label) {
  const m = String(label || '').match(/\b(\d{1,2}):(\d{2})\s*([AaPp])\.?\s*[Mm]\.?/);
  if (!m) return null;
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
      for (const dlg of document.querySelectorAll('[role="dialog"], [aria-modal="true"]')) {
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
    if (candidates.length) {
      candidates.sort((a, b) => Math.abs(a.mins - targetTime.minutesFromMidnight) - Math.abs(b.mins - targetTime.minutesFromMidnight));
      const best = candidates[0];
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
        for (const el of root.querySelectorAll('button, [role="option"], [role="button"], li')) {
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
    for (const dlg of document.querySelectorAll('[role="dialog"], [aria-modal="true"]')) {
      if (!visible(dlg)) continue;
      for (const btn of dlg.querySelectorAll('button, a, [role="button"]')) {
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

module.exports = { scrapeMenu, tryPreorder, switchToPickup, SELECTORS };
