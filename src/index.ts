'use strict';

import 'dotenv/config';

import http from 'http';
import { logger } from './logger';
import * as sheetClient from './sheet/sheetClient';
import * as claudeClient from './claude/claudeClient';
import { listAccounts, pickAccount } from './accounts/accountPicker';
import { sendReviewAlert } from './review/reviewQueue';
import {
  launchContext,
  ensureLoggedIn,
  detectBlockers,
  saveScreenshot,
  setGrubhubOrderType,
  setResidentAddressViaPill,
  clearGrubhubStorage,
} from './grubhub/browser';
import { parseNotes, ParsedNotes } from './parse/notesParser';
import { parseItems } from './parse/itemsParser';
import { scrapeMenu, searchMenuItems, tryPreorder, switchToPickup } from './grubhub/menuScraper';
import * as cart from './grubhub/cart';

// The notes parser exposes resident* fields; some legacy call sites also read
// customer* aliases that the parser does not (and never did) populate — at
// runtime these were simply `undefined`. Model that exactly so the strict
// compiler accepts the access without changing behavior.
type ParsedNotesWithAliases = ParsedNotes & {
  customerFirstName?: string;
  customerLastName?: string;
  customerPhone?: string;
};

type CheckResult = { ok?: boolean; [key: string]: unknown };
type VerifyResults = {
  sheet: CheckResult | null;
  claude: CheckResult | null;
  accounts: CheckResult | null;
  slack: CheckResult | null;
};

async function cmdCheck(): Promise<void> {
  logger.info('--- Day 1 verification ---');
  const results: VerifyResults = { sheet: null, claude: null, accounts: null, slack: null };

  try {
    const meta = await sheetClient.verifyConnection();
    results.sheet = { ok: true, title: meta.title, tab: meta.tab };
    logger.info({ title: meta.title, tab: meta.tab }, '[OK] Google Sheets reachable');
  } catch (err: any) {
    results.sheet = { ok: false, error: err.message };
    logger.error({ err: err.message }, '[FAIL] Google Sheets');
  }

  try {
    const r = await claudeClient.helloWorld();
    results.claude = { ok: r.ok, model: r.model };
    if (r.ok) logger.info({ model: r.model }, '[OK] Claude API reachable');
    else logger.warn({ text: r.text }, '[WARN] Claude responded but content unexpected');
  } catch (err: any) {
    results.claude = { ok: false, error: err.message };
    logger.error({ err: err.message }, '[FAIL] Claude API');
  }

  try {
    const accts = listAccounts();
    results.accounts = { ok: true, count: accts.length, ids: accts.map((a) => a.id) };
    logger.info({ count: accts.length, ids: accts.map((a) => a.id) }, '[OK] Grubhub accounts loaded');
  } catch (err: any) {
    results.accounts = { ok: false, error: err.message };
    logger.error({ err: err.message }, '[FAIL] Account config');
  }

  try {
    const slack = await sendReviewAlert({
      severity: 'info',
      title: 'Grubhub bot health check',
      reason: 'Day 1 connectivity test — no real order data.',
      order: { order_id: 'health-check', account: 'n/a', restaurant_name: 'n/a' },
    });
    results.slack = slack as unknown as CheckResult;
    if (slack.sent) logger.info('[OK] Slack webhook reachable');
    else logger.warn({ slack }, '[WARN] Slack webhook not configured or not reachable');
  } catch (err: any) {
    results.slack = { ok: false, error: err.message };
    logger.error({ err: err.message }, '[FAIL] Slack');
  }

  // eslint-disable-next-line no-console
  console.log('\n=== Verification Summary ===');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(results, null, 2));

  const allOk = results.sheet?.ok && results.claude?.ok && results.accounts?.ok;
  process.exit(allOk ? 0 : 1);
}

function cmdLogin(): void {
  // Login is no longer handled by the bot. The bot drives the real Chrome you
  // start with `npm run chrome`; sign in there once and the cookies persist in
  // ./chrome-profile.
  // eslint-disable-next-line no-console
  console.log(
    '\nLogin is now manual, inside the real Chrome:\n' +
      '  1. npm run chrome   (a Chrome window opens using ./chrome-profile)\n' +
      '  2. Go to grubhub.com and sign in (handle any 2FA/captcha yourself)\n' +
      '  3. Leave it signed in — the bot attaches to it over CDP.\n',
  );
  process.exit(0);
}

async function cmdOrder(): Promise<void> {
  const code = await processOneOrder();
  process.exit(code);
}

// Process at most one queued order: claim a row, run Phase 1-7, write back.
// Returns an exit code (0=ok, 1=failure, 2=nothing to do). Never throws —
// errors are written to the sheet and logged so the loop can keep running.
// Pre-flight: is the debug Chrome actually reachable?
//
// When BROWSER_CDP_URL is set the bot attaches to a Chrome the human launched
// (`npm run chrome`). If that Chrome isn't running, Playwright's connectOverCDP
// hangs for the full 120s timeout and THEN throws — and by that point we've
// already locked a row, so it gets marked failed. That's the #1 operational
// pain (WORKFLOW.md 4.1/8): a down browser burns every row instead of pausing.
//
// This does a cheap (3s) HTTP probe of Chrome's DevTools endpoint BEFORE any
// row is locked. Chrome always serves GET /json/version on the debug port.
// Returns { ok, reason } — ok:false means "pause the queue, touch no rows".
function preflightChromeReachable(): Promise<{ ok: boolean; reason?: string }> {
  const cdpUrl = process.env.BROWSER_CDP_URL;
  if (!cdpUrl) return Promise.resolve({ ok: true }); // launch-own-Chrome mode — nothing to probe
  const probeUrl = cdpUrl.replace(/\/+$/, '') + '/json/version';
  return new Promise((resolve) => {
    const req = http.get(probeUrl, { timeout: 3000 }, (res) => {
      // Drain and discard the body; any 2xx means DevTools is alive.
      res.resume();
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, reason: `CDP endpoint returned HTTP ${res.statusCode}` });
      }
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, reason: `no response from ${probeUrl} within 3s` });
    });
    req.on('error', (err: any) => {
      resolve({ ok: false, reason: `${err.code || err.message} connecting to ${probeUrl}` });
    });
  });
}

async function processOneOrder(): Promise<number> {
  const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
  const CONFIDENCE_THRESHOLD = parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.85');
  const MIN_AVG_CONFIDENCE = parseFloat(process.env.MIN_AVG_CONFIDENCE || '0.92');
  // 'all_in' (default): max_total includes fees/tax/tip → enforced on checkout total.
  // 'subtotal':         max_total is item subtotal only → enforced on cart subtotal.
  const MAX_TOTAL_BASIS = (process.env.MAX_TOTAL_BASIS || 'all_in').toLowerCase();

  let exitCode = 0;
  let browser: Awaited<ReturnType<typeof launchContext>>['browser'] | undefined;
  let ctx: Awaited<ReturnType<typeof launchContext>> | undefined;
  let page: Awaited<ReturnType<typeof ensureLoggedIn>> | undefined; // the per-order tab; closed in finally so tabs don't pile up in CDP Chrome
  let lockedRow: number | null = null;

  try {
    // Pre-flight 1: don't lock a row if the debug Chrome isn't even up. Returns
    // code 3 (SESSION_EXPIRED handling) so the drain/run loop PAUSES 60s for the
    // human to start Chrome, instead of locking + failing the row.
    const reach = await preflightChromeReachable();
    if (!reach.ok) {
      logger.warn(
        { reason: reach.reason, cdpUrl: process.env.BROWSER_CDP_URL },
        'PRE-FLIGHT: debug Chrome not reachable — pausing queue, NOT processing any row. Start it with `npm run chrome` and sign in.',
      );
      return 3;
    }

    const orders = await sheetClient.getQueuedOrders();
    logger.info({ count: orders.length, dryRun: DRY_RUN }, 'queued orders fetched');
    if (!orders.length) {
      // eslint-disable-next-line no-console
      console.log('No queued orders to process.');
      return 2;
    }

    // Process the NEWEST ready row (highest row number), not the oldest.
    // getQueuedOrders returns rows top→bottom, so orders[0] was the oldest
    // ready row — which, with the sheet's leftover duplicate rows, meant a
    // brand-new row you just added would lose to an old still-"ready" duplicate
    // (you'd get a Slack card for the PREVIOUS order). Picking the highest row
    // makes "add a row → that row runs" hold.
    const order = orders.slice().sort((a, b) => b._rowNumber - a._rowNumber)[0];
    logger.info(
      { row: order._rowNumber, id: order.id, readyCount: orders.length },
      'processing order (newest ready row)',
    );

    const parsed = parseNotes(order.notes) as ParsedNotesWithAliases;
    if (!parsed.isGrubhub || !parsed.orderUrl) {
      await sheetClient.writeReview(order._rowNumber, 'Notes do not contain a Grubhub order URL');
      exitCode = 1;
      return exitCode;
    }

    // ITEMS — source of truth is the structured product-list column (L,
    // extended_provider_mealme_order_product_list), NOT the free-text notes
    // "Items:" line. The notes blob is hand-written and goes stale: editing
    // the real column would otherwise be ignored and the bot would re-order
    // whatever the notes happened to say. Fall back to notes only if the
    // column is blank (legacy rows), logging which source was used.
    const productListCol = (order['extended_provider_mealme_order_product_list'] || '').toString().trim();
    const itemsSource = productListCol ? 'column_L_product_list' : 'notes_items_line';
    const itemsRaw = productListCol || parsed.items;
    const items = parseItems(itemsRaw);
    if (!items.length) {
      await sheetClient.writeReview(
        order._rowNumber,
        `Could not parse items from ${itemsSource}. Raw: ${(itemsRaw || '').slice(0, 200)}`,
      );
      exitCode = 1;
      return exitCode;
    }
    logger.info(
      { items, itemsSource, store: parsed.store, orderType: parsed.orderType, targetTime: parsed.targetTime, maxTotal: parsed.maxTotal },
      'parsed request',
    );

    // ADDRESS — source of truth is the structured address column (S, `address`)
    // plus unit column (T, `unit`), NOT the free-text notes "Resident address:"
    // line. The column holds the clean, fully-spelled street ("3860 Tallgrass
    // Prairie Lane") that Google Places autocompletes reliably; the notes line
    // is hand-abbreviated ("3860 Tallgrass Pr Ln") and frequently fails to
    // match a Places suggestion → the "address swap failed" review. Fall back
    // to the notes value only if the column is blank (legacy rows).
    const addressCol = (order['address'] || '').toString().trim();
    const unitCol = (order['unit'] || '').toString().trim();
    let deliveryAddress: string;
    let addressSource: string;
    if (addressCol) {
      // Append the unit only if the column value doesn't already carry one.
      deliveryAddress = unitCol && !/\bunit\b|#/i.test(addressCol)
        ? `${addressCol}, Unit: ${unitCol}`
        : addressCol;
      addressSource = 'column_S_address';
    } else {
      deliveryAddress = parsed.deliveryAddress;
      addressSource = 'notes_resident_address';
    }
    // Resident unit/apt for the checkout "Apt., suite, floor" field (#address2).
    // Source order: the unit column, then the address column string, then the
    // NOTES "Resident address:" line — the unit is often ONLY in the notes
    // (e.g. "...USA, Unit: 1B") while the address column has no unit, so we must
    // check the notes too or we silently drop it.
    const UNIT_RE = /\b(?:unit|apt|apartment|suite|ste|#)\s*:?\s*([\w-]+)/i;
    const unitFromAddrCol = ((deliveryAddress || '').match(UNIT_RE) || [])[1] || '';
    const unitFromNotes = ((parsed.deliveryAddress || '').match(UNIT_RE) || [])[1] || '';
    const residentUnit = unitCol || unitFromAddrCol || unitFromNotes || '';
    logger.info({ deliveryAddress, addressSource, residentUnit }, 'resolved delivery address');

    // Delivery orders need a resident address to fill on the checkout page.
    // Pickup orders skip it. If the order type wasn't parseable, default to
    // delivery (the historical behavior) but flag it for review.
    const isPickup = parsed.orderType === 'pickup';
    // Gate: for delivery orders the restaurant URL must NOT be opened until the
    // resident address is set first (every order launches a fresh session, so
    // order #2+ starts with the account's stale address). Pickup orders have no
    // address to set, so they're cleared to navigate immediately.
    let addressReady = isPickup;
    if (!isPickup && !deliveryAddress) {
      await sheetClient.writeReview(order._rowNumber, 'Delivery order is missing an address (column S `address` and notes "Resident address:" both empty) — cannot fill checkout');
      exitCode = 1;
      return exitCode;
    }

    // Pre-flight 2: attach to Chrome and HARD-assert signed-in BEFORE locking
    // the row. If the Chrome session is signed out, assertSignedIn throws
    // SESSION_EXPIRED → caught below → returns code 3 (pause). Because the row
    // isn't locked yet, lockedRow stays null, so the catch block does NOT mark
    // it failed — the row is left untouched and retried after you sign in.
    const account = pickAccount('auto');
    ctx = await launchContext(account.id);
    browser = ctx.browser;

    if (ctx.cdpAttached) {
      logger.warn(
        { accountId: account.id },
        'CDP-attach mode: bot is driving a user-owned Chrome. Any prior cart state, open checkout flow, or active tab interaction in that browser can interfere with this run.',
      );
    }

    page = await ensureLoggedIn(ctx);

    // ensureLoggedIn uses a loose regex that false-positives on "Create an
    // account" links. Run the strong probe before doing anything else — if
    // the Chrome session got kicked between rows (bot detection), fail loudly
    // here instead of walking into the wrong UI and typing addresses into
    // the hero search input.
    await cart.assertSignedIn(page);

    // Chrome is up AND signed in — only NOW claim the row. Everything below this
    // line is a genuine per-order outcome (review/failure), not a "browser not
    // ready" situation, so it's safe to lock and write back to the sheet.
    await sheetClient.lockRow(order._rowNumber, order.id);
    lockedRow = order._rowNumber;

    // Per-order clean slate. Between rows the SAME Grubhub session can carry
    // over the PREVIOUS restaurant's bound address + cart in localStorage
    // (`ngStorage-cartState` etc.), and in CDP-attach mode it's literally the
    // same Chrome. That stale bound address is what makes order #2/#3 throw the
    // "save this address?" / out-of-range modal when we try to swap. Wipe
    // localStorage + sessionStorage (cookies/login kept) so each order starts
    // as a fresh Grubhub before we change the address. Reloads grubhub.com.
    try {
      await clearGrubhubStorage(page);
    } catch (e: any) {
      logger.warn({ err: e.message }, 'clearGrubhubStorage failed (continuing)');
    }

    // Clear any inherited cart state before adding items (defends against
    // cart leak in CDP mode and crash-recovery double-adds).
    try {
      await cart.clearCart(page, { saveScreenshot });
    } catch (e: any) {
      logger.warn({ err: e.message }, 'pre-run cart clear failed (continuing)');
    }

    // Set delivery vs pickup BEFORE navigating to the restaurant page.
    // Grubhub reads ngStorage-cartState.orderType on SPA mount; there's no
    // visible tab to switch later. parsed.orderType comes from the notes
    // ("Store: Wawa - Delivery Order" → "delivery").
    if (parsed.orderType) {
      await setGrubhubOrderType(page, parsed.orderType);
    }

    // Swap to the resident's delivery address on the Grubhub HOMEPAGE — before
    // navigating to the restaurant URL. ensureLoggedIn left us on grubhub.com,
    // so the global-nav address pill is here. Doing the swap up-front means
    // the restaurant page loads with the correct address from the start, so
    // Grubhub never fires the "Outside of delivery range" modal that would
    // otherwise block the pill on the restaurant page. Pickup orders skip.
    if (!isPickup && deliveryAddress) {
      const pillOk = await setResidentAddressViaPill(page, deliveryAddress).catch(
        (e: any) => {
          logger.warn({ err: e.message }, 'setResidentAddressViaPill threw on homepage (continuing)');
          return false;
        },
      );
      logger.info({ pillOk }, 'resident address pill set on homepage (pre-navigation)');
      await saveScreenshot(page, 'address-pill-set-homepage');
      addressReady = pillOk;
      if (!pillOk) {
        await sheetClient.writeReview(
          order._rowNumber,
          'Address pill swap failed — pill still shows account address, refusing to proceed (would order to wrong location)',
        );
        lockedRow = null;
        await sendReviewAlert({
          severity: 'warn',
          title: 'Address swap failed',
          reason: `Could not change Grubhub session address to "${deliveryAddress}". Pill click + Update did not register a verified address change.`,
          order: { order_id: order.id, account: account.id, restaurant_name: parsed.store, max_total: parsed.maxTotal },
        });
        exitCode = 1;
        return exitCode;
      }
    }

    // Hard ordering guard: never open the restaurant URL for a delivery order
    // until the address has been set + verified above. Defends against a future
    // edit reordering these steps and silently ordering to the account's
    // stale address (the #2-order failure mode).
    if (!addressReady) {
      throw new Error('refusing to navigate to restaurant URL: resident address not set first');
    }
    logger.info({ addressReady, url: parsed.orderUrl }, 'address set first — now navigating to notes restaurant URL');
    await page.goto(parsed.orderUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await detectBlockers(page);
    await saveScreenshot(page, 'menu-loaded');

    // Defense-in-depth verification of order type. setGrubhubOrderType above
    // writes localStorage before navigation, which is enough for the happy
    // path. But if Grubhub overrode the value (e.g. restaurant only supports
    // one mode, stale SPA state), the visible #delivery-button / #pickup-button
    // toggle will be on the wrong side. ensureOrderType reads aria-pressed and
    // clicks the right button if there's a mismatch. Non-fatal: if the toggle
    // isn't on this restaurant page, we log and continue.
    if (parsed.orderType) {
      const toggleRes = await cart.ensureOrderType(page, parsed.orderType);
      logger.info({ ...toggleRes, wanted: parsed.orderType }, 'order type toggle verify (post-nav)');
    }

    let menu = await scrapeMenu(page, { deep: false });

    // Out-of-range recovery. Grubhub sometimes loads the restaurant page with
    // the account's stale address instead of the one we set on the homepage,
    // firing the "Outside of delivery range" modal. setResidentAddressViaPill
    // detects that modal, clicks "Change", and re-enters the resident address
    // (browser.js). Try it once on the restaurant page, then re-scrape. Skip
    // for pickup (no delivery address) and when we have no address to re-enter.
    if (menu.count === 0 && menu.reason === 'out_of_range' && !isPickup && deliveryAddress) {
      logger.warn('out-of-range modal on restaurant page — retrying address via Change');
      await saveScreenshot(page, 'out-of-range-before-recovery');
      const recovered = await setResidentAddressViaPill(page, deliveryAddress).catch((e: any) => {
        logger.warn({ err: e.message }, 'out-of-range recovery threw (continuing)');
        return false;
      });
      logger.info({ recovered }, 'out-of-range address recovery result');
      if (recovered) {
        await detectBlockers(page);
        menu = await scrapeMenu(page, { deep: false });
        logger.info({ count: menu.count, reason: menu.reason }, 'post-recovery rescrape');
      }
    }

    // Pickup-only recovery. Some restaurants don't deliver — Grubhub blocks the
    // menu with a "This location is pickup-only" modal ("Switch to pickup" /
    // "Find delivery nearby"). If THIS order is a pickup order, click "Switch to
    // pickup" and re-scrape. If it's a delivery order, the location can't
    // fulfill it — route to human review.
    if (menu.count === 0 && menu.reason === 'pickup_only') {
      await saveScreenshot(page, 'pickup-only-modal');
      if (isPickup) {
        logger.info('pickup-only modal on a pickup order — clicking "Switch to pickup"');
        const switched = await switchToPickup(page).catch((e: any) => {
          logger.warn({ err: e.message }, 'switchToPickup threw (continuing)');
          return false;
        });
        if (switched) {
          await detectBlockers(page);
          menu = await scrapeMenu(page, { deep: false });
          logger.info({ count: menu.count, reason: menu.reason }, 'post-switch-to-pickup rescrape');
        }
      } else {
        const reason = 'Restaurant is pickup-only but this is a delivery order — cannot fulfill delivery here';
        await sheetClient.writeReview(order._rowNumber, reason);
        lockedRow = null;
        await sendReviewAlert({
          severity: 'warn',
          title: 'Restaurant is pickup-only (delivery order)',
          reason,
          order: { order_id: order.id, account: account.id, restaurant_name: parsed.store, max_total: parsed.maxTotal },
        });
        exitCode = 1;
        return exitCode;
      }
    }

    // Preorder is triggered in two cases:
    //   1. Notes carry a target time — pick the slot nearest that time.
    //   2. Restaurant is closed and ALLOW_PREORDER=true — pick earliest slot.
    const allowPreorder = (process.env.ALLOW_PREORDER || '').toLowerCase() === 'true';
    const shouldPreorder = parsed.targetTime || (menu.count === 0 && menu.reason === 'restaurant_closed' && allowPreorder);
    if (shouldPreorder) {
      logger.info({ targetTime: parsed.targetTime, menuCount: menu.count }, 'attempting preorder');
      const pre = await tryPreorder(page, { saveScreenshot, targetTime: parsed.targetTime ?? undefined });
      logger.info({ pre }, 'preorder attempt result');
      if (pre.ok) {
        menu = await scrapeMenu(page, { deep: false });
        logger.info({ count: menu.count, picked: pre.picked }, 'post-preorder rescrape');
      }
    }

    if (menu.count === 0) {
      await saveScreenshot(page, 'menu-empty');
      const visibleText = (menu.closedSignal && menu.closedSignal.text) || '';
      let reason: string;
      let title: string;
      if (menu.reason === 'out_of_range') {
        reason = `Restaurant marked unorderable for this delivery address — check that the pill swap worked. Visible: "${visibleText.slice(0, 200)}"`;
        title = 'Restaurant out of delivery range (address may be wrong)';
      } else if (menu.reason === 'restaurant_closed') {
        reason = `Restaurant is not taking orders right now (signal: ${menu.closedSignal && menu.closedSignal.hit})${allowPreorder ? '; preorder attempt also failed' : ' — retry later'}. Visible: "${visibleText.slice(0, 200)}"`;
        title = 'Restaurant not taking orders';
      } else {
        reason = 'Menu scrape returned 0 items — selectors likely need adjustment for this restaurant';
        title = 'Menu scrape empty';
      }
      await sheetClient.writeReview(order._rowNumber, reason);
      lockedRow = null;
      await sendReviewAlert({
        severity: 'warn',
        title,
        reason,
        order: { order_id: order.id, account: account.id, restaurant_name: parsed.store, max_total: parsed.maxTotal },
      });
      exitCode = 1;
      return exitCode;
    }

    // Phase 1b — SEARCH-FIRST item discovery. Instead of scrolling the whole
    // menu up front, type each requested item into the restaurant's own search
    // box, scrape the filtered results, and use those as the match candidates.
    // The full deep scrape runs ONLY as a fallback when search finds nothing
    // (e.g. the search box is missing or returns no cards). This is faster and
    // more accurate than scraping the entire (often virtualized) menu.
    try {
      const searchItems = await searchMenuItems(page, items.map((i) => i.name));
      if (searchItems.length) {
        // Search results ARE the candidate set — nothing else. We do NOT fold in
        // the whole menu: the point of searching is to narrow to the few cards
        // the search returned and match against only those. Matching the
        // requested item to the right one (by name/price) happens next in
        // matchItemsBudgetAware over exactly these candidates.
        const byName = new Map(searchItems.map((it) => [it.name.toLowerCase(), it]));
        menu.items = Array.from(byName.values());
        menu.count = menu.items.length;
        logger.info(
          { candidatesFromSearch: menu.count },
          'menu candidates = in-page search results only (no full-menu scrape)',
        );
      } else {
        // Fallback: search yielded nothing — do the full deep scroll-scrape.
        logger.info('search returned no items — falling back to deep menu scrape');
        const deepMenu = await scrapeMenu(page, { deep: true });
        if (deepMenu.items && deepMenu.items.length) {
          menu.items = deepMenu.items;
          menu.count = deepMenu.count;
        }
      }
    } catch (e: any) {
      logger.warn({ err: e.message }, 'search-first discovery failed — falling back to deep scrape');
      const deepMenu = await scrapeMenu(page, { deep: true }).catch(() => null);
      if (deepMenu && deepMenu.items && deepMenu.items.length) {
        menu.items = deepMenu.items;
        menu.count = deepMenu.count;
      }
    }

    // Phase 2 — two-pass budget-aware matching:
    //   (a) rankCandidates: ONE Claude call returns ranked candidates per
    //       requested item (no budget reasoning in the prompt).
    //   (b) solveBudget: pure JS picks the combo that fits maxTotal,
    //       preferring exact over fuzzy and high-confidence over low.
    // parsed.maxTotal is the subtotal cap; fees/tax/tip are enforced
    // separately at checkout via MAX_TOTAL_BASIS=all_in.
    const match = await claudeClient.matchItemsBudgetAware({
      requestedItems: items.map((i) => ({ name: i.name, qty: i.qty })),
      menu: { items: menu.items },
      // parsed.maxTotal is number|null; the original code passed it through
      // as-is (null when the notes carried no cap). Preserve that exactly.
      maxTotal: parsed.maxTotal as number,
      confidenceThreshold: CONFIDENCE_THRESHOLD,
    });

    logger.info(
      { picks: match.picks, totalUsed: match.totalUsed, withinBudget: match.withinBudget, reason: match.reason, exactCount: match.exactCount },
      'budget-aware match result',
    );

    if (!match.withinBudget) {
      // A budget mismatch MUST always land in needs-review — never a hard
      // "Order failed". So build the message defensively: start with safe
      // fallbacks, and if anything in the (data-dependent) message building
      // throws, keep the fallbacks instead of letting the error escape to the
      // outer catch (which would mark the order Failed).
      let sheetReason = (match.reason || 'Items could not be matched within budget') + ' — needs review';
      let slackReason = sheetReason;
      try {
        const maxTotal = Number(parsed.maxTotal) || 0;
        // Cheapest combo Grubhub could actually build (one match per requested item).
        const cheapest = (match.attempts || []).find((a) => a.label === 'cheapest-available')
          || (match.attempts || []).slice().sort((a, b) => a.total - b.total)[0];
        const cheapestTotal = cheapest ? Number(cheapest.total) : null;
        const over = cheapestTotal != null ? (cheapestTotal - maxTotal) : null;

        // Cheapest single candidate per requested item, for an at-a-glance breakdown.
        const breakdown = (match.rankedRaw || [])
          .map((row) => {
            // Sort cheapest-first, treating a missing/null price as +Infinity so
            // priced candidates win and a null-priced one never lands as "best".
            const best = (row.candidates || [])
              .slice()
              .sort((a, b) => (a.matched_price ?? Infinity) - (b.matched_price ?? Infinity))[0];
            if (!best) return `• ${row.requested} → no match found`;
            const priceStr = best.matched_price != null ? `$${best.matched_price.toFixed(2)}` : 'price n/a';
            return `• ${row.requested} → ${best.matched_name} (${priceStr})`;
          })
          .join('\n');

        sheetReason =
          `Over budget: cheapest combo $${cheapestTotal != null ? cheapestTotal.toFixed(2) : '?'} ` +
          `exceeds max $${maxTotal.toFixed(2)}` +
          (over != null ? ` (over by $${over.toFixed(2)})` : '');

        slackReason =
          `This order can't fit the $${maxTotal.toFixed(2)} budget.\n` +
          (cheapestTotal != null
            ? `Cheapest possible combo is *$${cheapestTotal.toFixed(2)}* — over by *$${over!.toFixed(2)}*.\n\n`
            : '\n') +
          `*Best price per item:*\n${breakdown}\n\n` +
          `_To proceed: raise the max total or remove/swap an item._`;
      } catch (msgErr: any) {
        logger.warn({ err: msgErr.message }, 'budget-review message build failed — using safe fallback reason (still needs-review, not failed)');
      }

      await sheetClient.writeReview(order._rowNumber, String(sheetReason).slice(0, 500)).catch((e: any) => {
        logger.warn({ err: e.message }, 'writeReview failed for budget mismatch');
      });
      lockedRow = null;
      await sendReviewAlert({
        severity: 'warn',
        title: '🛑 Order over budget — needs review',
        reason: slackReason,
        order: { order_id: order.id, account: account.id, restaurant_name: parsed.store, max_total: parsed.maxTotal },
      }).catch(() => {});
      exitCode = 1;
      return exitCode;
    }

    await detectBlockers(page);
    await saveScreenshot(page, 'phase2-menu-matched');
    await sheetClient.appendInternalNote(
      order._rowNumber,
      `MATCH_OK budget=$${match.totalUsed}/$${parsed.maxTotal} items=${match.picks.length} exact=${match.exactCount}`,
    ).catch(() => {});

    // Phase 3 — add the budget-approved picks to the cart.
    const cartItems = match.picks.map((p) => ({
      requested: p.requested,
      matched_id: null,
      matched_name: p.matched_name,
      confidence: p.confidence,
      qty: p.qty,
    }));

    const addRes = await cart.addItemsToCart(page, cartItems, {
      saveScreenshot,
      preferences: parsed.itemModifiers,
    });
    await saveScreenshot(page, 'phase3-after-adds');
    logger.info({ added: addRes.added.length, skipped: addRes.skipped.length }, 'phase 3 done');

    if (addRes.skipped.length) {
      const reason =
        `Phase 3: ${addRes.skipped.length} item(s) could not be added — ` +
        addRes.skipped.map((s: any) => `${s.name} (${s.reason})`).join('; ');
      await sheetClient.writeReview(order._rowNumber, reason.slice(0, 500));
      lockedRow = null;
      await sendReviewAlert({
        severity: 'warn',
        title: 'Add-to-cart partially failed',
        reason,
        order: { order_id: order.id, account: account.id, restaurant_name: parsed.store, max_total: parsed.maxTotal },
        extra: addRes,
      });
      exitCode = 1;
      return exitCode;
    }

    // Phase 3.5 — cart subtotal. Enforce as a hard cap only when
    // MAX_TOTAL_BASIS=subtotal; otherwise it's informational.
    await detectBlockers(page);
    const subtotal = await cart.readCartSubtotal(page);
    await saveScreenshot(page, 'phase3-cart-open');
    logger.info({ subtotal, maxTotal: parsed.maxTotal, basis: MAX_TOTAL_BASIS }, 'cart subtotal read');
    if (
      MAX_TOTAL_BASIS === 'subtotal' &&
      subtotal != null &&
      parsed.maxTotal != null &&
      subtotal > parsed.maxTotal
    ) {
      const reason =
        `Cart subtotal $${subtotal} exceeds max_total $${parsed.maxTotal} (basis=subtotal) — stopping before checkout`;
      await sheetClient.writeReview(order._rowNumber, reason);
      lockedRow = null;
      await sendReviewAlert({
        severity: 'warn',
        title: 'Cart subtotal exceeds max',
        reason,
        order: { order_id: order.id, account: account.id, restaurant_name: parsed.store, max_total: parsed.maxTotal },
      });
      exitCode = 1;
      return exitCode;
    }
    if (subtotal != null && parsed.maxTotal != null && subtotal > parsed.maxTotal) {
      logger.warn(
        { subtotal, maxTotal: parsed.maxTotal, basis: MAX_TOTAL_BASIS },
        'subtotal already exceeds max_total but basis=all_in — continuing to checkout for fees-inclusive total',
      );
    }

    // Phase 4 — proceed to checkout, read final total (incl. fees/tax/tip).
    await detectBlockers(page);
    const reviewUrl = await cart.proceedToCheckout(page);
    await detectBlockers(page);
    await saveScreenshot(page, 'phase4-checkout-review');
    const checkoutTotal = await cart.readCheckoutTotal(page);
    logger.info({ reviewUrl, checkoutTotal, maxTotal: parsed.maxTotal, basis: MAX_TOTAL_BASIS }, 'phase 4: at checkout review');

    if (checkoutTotal == null) {
      await sheetClient.writeReview(order._rowNumber, `Phase 4: could not read checkout total at ${reviewUrl}`);
      lockedRow = null;
      exitCode = 1;
      return exitCode;
    }
    if (
      MAX_TOTAL_BASIS === 'all_in' &&
      parsed.maxTotal != null &&
      checkoutTotal > parsed.maxTotal
    ) {
      const reason =
        `Checkout total $${checkoutTotal} exceeds max_total $${parsed.maxTotal} (basis=all_in) — stopping before Place Order`;
      await sheetClient.writeReview(order._rowNumber, reason);
      lockedRow = null;
      await sendReviewAlert({
        severity: 'warn',
        title: 'Checkout total exceeds max',
        reason,
        order: { order_id: order.id, account: account.id, restaurant_name: parsed.store, max_total: parsed.maxTotal },
      });
      exitCode = 1;
      return exitCode;
    }

    // Phase 5 — snapshot the review page (address / payment / tip) for the human approver.
    const snap = await cart.gatherCheckoutSnapshot(page);
    await saveScreenshot(page, 'phase5-review-snapshot');
    logger.info({ snap }, 'phase 5: review snapshot captured');
    await sheetClient.appendInternalNote(order._rowNumber, `PHASE5_OK subtotal=${subtotal ?? '?'} total=${checkoutTotal} basis=${MAX_TOTAL_BASIS}`).catch(() => {});

    // ---- Phase 5b: fill contact + special instructions ----
    // Done BEFORE the dry-run snapshot so the approval card (dry-run OR real)
    // shows the RESIDENT's name/phone from the sheet, not the bot account's
    // saved contact. Contact info on the review page is often pre-filled with
    // the account's name/phone; we overwrite it with the row's values.
    // Declared outside the try so the post-fill confirmation wait below can
    // read the same values (a `const` inside try would be out of scope there).
    let contact: {
      firstName: string | undefined;
      lastName: string | undefined;
      phone: string | undefined;
      unit: string;
      specialInstructions: string;
    } | null = null;
    try {
      // The SHEET ROW columns (first_name/last_name/cell_phone) are the source
      // of truth for the resident — they MUST win over anything parsed from the
      // notes or pre-filled by the bot's Grubhub account, otherwise the order
      // shows the bot account's name/phone. Only fall back to parsed values when
      // a sheet column is blank.
      contact = {
        firstName: order.first_name || parsed.customerFirstName || parsed.residentFirstName,
        lastName: order.last_name || parsed.customerLastName || parsed.residentLastName,
        // Phone: use the notes "Temporary phone to use for booking" line, NOT
        // the resident's real cell_phone column. The booking phone is the number
        // the order should be placed under; cell_phone is only a last-resort
        // fallback if the notes line is missing.
        phone: parsed.bookingPhone || parsed.customerPhone || order.cell_phone,
        // Unit/apt → the checkout "Apt., suite, floor" field (#address2).
        unit: residentUnit,
        specialInstructions: parsed.specialInstructions || parsed.driverNotes,
      };
      logger.info(
        { firstName: contact.firstName, lastName: contact.lastName, phone: contact.phone, unit: contact.unit, source: 'sheet-first' },
        'filling checkout contact from sheet row',
      );
      await cart.fillCheckoutContact(page, contact);
    } catch (e: any) {
      logger.warn({ err: e.message }, 'fillCheckoutContact threw (continuing — fields may already be set)');
    }
    // Wait until the SPA has actually committed the just-filled fields before
    // we snapshot — otherwise the approval screenshot can race the last write.
    // Poll the real input values instead of guessing with a fixed sleep: names
    // must equal what we wrote; phone/unit just need to be non-empty (the SPA
    // reformats phone, so an exact match would be brittle). Bounded so a
    // skipped/optional field never hangs the run.
    if (contact) {
      await page.waitForFunction(
        (c: { firstName?: string; lastName?: string; phone?: string; unit?: string }) => {
          const val = (sel: string) => {
            const el = document.querySelector(sel) as HTMLInputElement | null;
            return el ? String(el.value || '').trim() : '';
          };
          const okName = (sel: string, want?: string) =>
            !want || val(sel).toLowerCase() === String(want).trim().toLowerCase();
          const okFilled = (sel: string, want?: string) => !want || val(sel).length > 0;
          return (
            okName('#firstName', c.firstName) &&
            okName('#lastName', c.lastName) &&
            okFilled('#phone', c.phone) &&
            okFilled('#address2', c.unit)
          );
        },
        { firstName: contact.firstName, lastName: contact.lastName, phone: contact.phone, unit: contact.unit },
        { timeout: 4000 },
      ).catch(() => {
        logger.warn('contact fields did not confirm within 4s — snapshotting anyway');
      });
    }
    await saveScreenshot(page, 'phase5b-after-contact-fill');

    if (DRY_RUN) {
      const summary =
        `DRY-RUN reached checkout review. ${addRes.added.length} item(s) added, ` +
        `subtotal=$${subtotal ?? '?'}, total=$${checkoutTotal}/$${parsed.maxTotal ?? '∞'}. ` +
        `Did NOT click Place Order. Review URL: ${reviewUrl}`;
      logger.info({ summary }, 'dry-run complete');
      // Post the SAME rich approval card (screenshot + Accept/Reject buttons)
      // that a real order would get, so you can verify the Slack UX during a
      // dry run. dryRun:true means it's clearly labelled a preview, registers
      // no waiter, and places no order whichever button is clicked.
      try {
        const { sendCheckoutApproval } = require('./review/slackApproval');
        const previewShot = await saveScreenshot(page, 'phase6-approval-snapshot');
        await sendCheckoutApproval({
          orderId: order.id,
          restaurantName: parsed.storeName || parsed.store,
          items,
          subtotal,
          total: checkoutTotal,
          maxTotal: parsed.maxTotal,
          deliveryAddress,
          account: account.id,
          screenshotPath: previewShot,
          rowNumber: order._rowNumber,
          dryRun: true,
        });
      } catch (e: any) {
        logger.warn({ err: e.message }, 'dry-run approval preview post failed (continuing)');
      }
      // Write a non-ready state so the loop advances to the next row instead
      // of re-picking this one. Reset column E to blank to retry a row.
      await sheetClient.unlockRow(order._rowNumber, summary, 'dry-run-done');
      lockedRow = null;
      // eslint-disable-next-line no-console
      console.log('\n' + summary + '\n');
      return exitCode;
    }

    // (Phase 5b contact fill now runs above, before the dry-run snapshot.)

    // Advance the checkout "gather" step → review/payment. proceedToCheckout
    // can land on /checkout/.../gather ("Does everything below look correct?"),
    // which has a "Continue to payment" button. Click through it so we reach
    // the review/payment page (dryRunFlow does this via submitCheckoutGather;
    // production must too, or the URL gate below blocks the Slack approval).
    try {
      const gatherRes = await cart.submitCheckoutGather(page, { addressLabel: 'home' });
      logger.info({ gatherRes }, 'phase 5b: submitted checkout gather (advancing to review)');
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      // Wait for the actual signal we care about — landing on the
      // /checkout/.../{gather,review} page — instead of a fixed sleep. The URL
      // gate just below depends on exactly this; polling it here removes the
      // race where the screenshot is taken mid-navigation. Bounded so a stuck
      // navigation falls through to the gate's explicit failure handling.
      await page.waitForFunction(
        () => /\/checkout\/[^/]+\/(gather|review)/i.test(location.href),
        undefined,
        { timeout: 8000 },
      ).catch(() => {
        logger.warn('did not reach gather/review URL within 8s after gather submit');
      });
    } catch (e: any) {
      logger.warn({ err: e.message }, 'submitCheckoutGather threw (continuing)');
    }
    await saveScreenshot(page, 'phase5b-after-gather-submit');

    // URL gate. Per memory note "slack-screenshot-url-gated": only send the
    // approval when on a real checkout page (gather/review), never the menu or
    // an empty cart. Both /gather (order-confirm) and /review show the full
    // order, so either is a valid screenshot for the human approver.
    const reviewUrlAfterContact = page.url();
    if (!/\/checkout\/[^/]+\/(gather|review)/i.test(reviewUrlAfterContact)) {
      await sheetClient.writeReview(
        order._rowNumber,
        `Phase 5b: after contact fill, URL is not a /checkout/.../{gather,review} page (got ${reviewUrlAfterContact}) — refusing to send Slack approval`,
      );
      lockedRow = null;
      exitCode = 1;
      return exitCode;
    }

    // ---- Phase 6: Slack approval gate ----
    const { sendCheckoutApproval, waitForButtonApproval, postFollowUp } =
      require('./review/slackApproval');
    // Full-page so the human approver sees the ENTIRE order (items, totals,
    // address, fees) in one image, not just the top viewport.
    const approvalShotPath = await saveScreenshot(page, 'phase6-approval-snapshot', { fullPage: true });
    const send = await sendCheckoutApproval({
      orderId: order.id,
      restaurantName: parsed.storeName || parsed.store,
      items,
      subtotal,
      total: checkoutTotal,
      maxTotal: parsed.maxTotal,
      deliveryAddress,
      account: account.id,
      screenshotPath: approvalShotPath,
      rowNumber: order._rowNumber,
    });
    if (!send.ok) {
      await sheetClient.writeFailure(order._rowNumber, `Slack approval send failed: ${send.error || 'unknown'}`);
      lockedRow = null;
      exitCode = 1;
      return exitCode;
    }
    await sheetClient.appendInternalNote(
      order._rowNumber,
      `APPROVAL_SENT channel=${send.channel} ts=${send.ts}`,
    ).catch(() => {});

    const approvalTimeoutMs =
      Math.max(60_000, parseInt(process.env.APPROVAL_TIMEOUT_MS || '900000', 10)); // default 15 min
    const decision = await waitForButtonApproval({
      channel: send.channel,
      ts: send.ts,
      timeoutMs: approvalTimeoutMs,
    });

    if (decision.decision === 'reject') {
      await postFollowUp({
        channel: send.channel,
        ts: send.ts,
        text: `Order ${order.id} rejected by <@${decision.userId}> — bot will not place the order.`,
      }).catch(() => {});
      await sheetClient.writeReview(
        order._rowNumber,
        `Rejected by Slack reviewer ${decision.userId} at ${new Date().toISOString()}. Review URL: ${reviewUrlAfterContact}`,
      );
      lockedRow = null;
      logger.info({ rowNumber: order._rowNumber, userId: decision.userId }, 'order rejected by reviewer');
      return exitCode;
    }
    if (decision.decision === 'timeout' || !decision.ok) {
      await postFollowUp({
        channel: send.channel,
        ts: send.ts,
        text: `Order ${order.id} approval window expired after ${Math.round(approvalTimeoutMs / 60000)} min — bot will not place the order.`,
      }).catch(() => {});
      await sheetClient.writeReview(
        order._rowNumber,
        `Slack approval timed out after ${Math.round(approvalTimeoutMs / 60000)} min. Review URL: ${reviewUrlAfterContact}`,
      );
      lockedRow = null;
      logger.warn({ rowNumber: order._rowNumber }, 'approval timed out — order not placed');
      return exitCode;
    }

    // ---- Phase 7: Place Order ----
    logger.info({ userId: decision.userId }, 'approval received, clicking Place Order');
    await sheetClient.appendInternalNote(
      order._rowNumber,
      `APPROVED_BY ${decision.userId} (${decision.userName || 'button'})`,
    ).catch(() => {});

    // Grubhub's review page can drift state if the approval took a few minutes.
    // Reload to be sure we're firing against fresh server-side state.
    if (Date.now() - decision.addedAt < approvalTimeoutMs / 2) {
      // approved quickly — no need to reload
    } else {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      // Wait for the Place Order button to actually re-render after the reload,
      // instead of a fixed sleep — that's the precise signal placeOrder needs.
      // Bounded; placeOrder re-checks and retries the click if it's not ready.
      await page
        .waitForSelector(
          '[data-testid="place-order-button"], [data-testid="place-order"], button:has-text("Place order"), button:has-text("Place Order")',
          { state: 'visible', timeout: 8000 },
        )
        .catch(() => logger.warn('Place Order button not visible within 8s after reload — placeOrder will retry'));
    }

    const placed = await cart.placeOrder(page);
    await saveScreenshot(page, 'phase7-after-place-order');
    if (!placed.ok) {
      await postFollowUp({
        channel: send.channel,
        ts: send.ts,
        text: `Order ${order.id} approved but Place Order failed: ${placed.error}`,
      }).catch(() => {});
      await sheetClient.writeFailure(
        order._rowNumber,
        `Place Order click failed after approval: ${placed.error}`,
      );
      lockedRow = null;
      exitCode = 1;
      return exitCode;
    }

    // ---- Phase 8: success writeback ----
    await sheetClient.writeSuccess(order._rowNumber, {
      grubhubOrderId: placed.grubhubOrderId,
      actualTotal: checkoutTotal,
      orderUrl: placed.confirmationUrl,
    });
    lockedRow = null;
    await postFollowUp({
      channel: send.channel,
      ts: send.ts,
      text: `Order ${order.id} placed. Grubhub order #${placed.grubhubOrderId} — ${placed.confirmationUrl}`,
    }).catch(() => {});
    logger.info(
      { rowNumber: order._rowNumber, grubhubOrderId: placed.grubhubOrderId, total: checkoutTotal },
      'order placed successfully',
    );
  } catch (err: any) {
    logger.error({ err: err.message, code: err.code, stack: err.stack }, 'order failed');
    if (lockedRow) {
      await sheetClient.writeFailure(lockedRow, err.message).catch(() => {});
    }
    // Surface SESSION_EXPIRED separately so the run loop pauses for the
    // human to re-sign in instead of churning through every row in the queue.
    exitCode = err.code === 'SESSION_EXPIRED' ? 3 : 1;
  } finally {
    // One tab per order: close the tab we opened so it doesn't accumulate in
    // the CDP Chrome. Leftover Grubhub tabs each carry 30+ tracking iframes, and
    // the next run's connectOverCDP has to enumerate them all — that pile-up is
    // what causes the 120s "connectOverCDP timeout". Closing here keeps Chrome
    // light and also drops the per-tab cart/localStorage state between orders.
    if (page) {
      await page.close().catch(() => {});
      logger.info('closed per-order tab');
    }
    // CDP attach: just disconnect (browser.close() on a connectOverCDP
    // handle won't kill the user's Chrome, but be explicit about intent).
    if (browser) {
      if (ctx && ctx.cdpAttached) {
        await browser.close().catch(() => {});
        logger.info('disconnected from user Chrome (CDP)');
      } else {
        await browser.close().catch(() => {});
      }
    }
  }

  return exitCode;
}

// Loop runner: process orders sequentially forever, sleeping POLL_INTERVAL_MS
// between empty-queue checks. Designed to run in a terminal that stays open
// (your laptop) — Ctrl+C to stop.
//
// Sleep policy:
//   - empty queue → sleep POLL_INTERVAL_MS (default 5 min) then poll again
//   - failure or success → sleep 2s then poll again (don't punish next row)
//   - SESSION_EXPIRED (Chrome got signed out) → sleep 60s. Avoids burning
//     through the whole queue marking every row failed before the human can
//     re-sign in. Hold for the user to act.
async function cmdRun(): Promise<void> {
  const pollMs = Math.max(5000, parseInt(process.env.POLL_INTERVAL_MS || '300000', 10));
  logger.info({ pollMs }, 'starting run loop (Ctrl+C to stop)');
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const code = await processOneOrder().catch((err: any) => {
      logger.error({ err: err.message, stack: err.stack }, 'processOneOrder threw unexpectedly');
      return 1;
    });
    if (code === 2) {
      await new Promise((r) => setTimeout(r, pollMs));
    } else if (code === 3) {
      logger.warn('SESSION_EXPIRED — pausing 60s for human to sign in to the Chrome session');
      await new Promise((r) => setTimeout(r, 60000));
    } else {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// Start the webhook server: a Google Apps Script onChange trigger POSTs to
// /trigger the moment a new row lands, kicking off order processing instantly
// instead of waiting for the next poll. A fallback poll still runs as a safety
// net in case a webhook is missed (network blip, tunnel down).
async function cmdServe(): Promise<void> {
  // Lazy dynamic import: server.ts imports this module, so a top-level import
  // would create a circular import. Resolve it only when serve runs.
  const { startServer } = await import('./server');
  await startServer({ processOneOrder });
  // Keep the process alive; startServer holds the HTTP listener open.
}

async function cmdQueueTest(): Promise<void> {
  const url = process.env.TEST_URL
    || 'https://www.grubhub.com/restaurant/the-melt---925-market-sf-925-market-st-san-francisco/2028596';
  const store = process.env.TEST_STORE || 'The Melt - 925 Market SF';
  const items = process.env.TEST_ITEMS || 'The Classic x 1 ($8.49), Fries x 1 ($4.99)';
  const maxTotal = process.env.TEST_MAX_TOTAL || '25.00';
  const address = process.env.TEST_ADDRESS || '925 Market St, San Francisco, CA 94103, USA, Unit: 1';
  const phone = process.env.TEST_PHONE || '+15555550100';
  const specialInstructions = process.env.TEST_NOTES || 'Test order from queue-test command';
  const id = `test-${Date.now()}`;

  const notes =
    `Grubhub appointment\n\n` +
    `Store: ${store}\n\n` +
    `Order URL: ${url}\n\n` +
    `Total: ${maxTotal}\n\n` +
    `Items: ${items}\n\n` +
    `Resident address: ${address}\n\n` +
    `Temporary phone to use for booking: ${phone}\n\n` +
    `Resident notes and Special Instructions: ${specialInstructions}\n`;

  const res = await sheetClient.appendOrder({ id, salePrice: maxTotal, notes });
  // eslint-disable-next-line no-console
  console.log(`Queued test order id=${id} at row ${res.rowNumber ?? '?'} (${res.updatedRange}).`);
  process.exit(0);
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  // Single-instance guard for any command that processes orders. Two bots
  // running at once would each have their own in-memory drain lock and could
  // work different sheet rows in parallel (the row-60/61 overlap).
  const ORDER_COMMANDS = new Set(['order', 'run', 'serve']);
  if (ORDER_COMMANDS.has(cmd)) {
    require('./util/singleInstance').acquire(cmd);
  }
  switch (cmd) {
    case 'check':
      return cmdCheck();
    case 'login':
      return cmdLogin();
    case 'order':
      return cmdOrder();
    case 'run':
      return cmdRun();
    case 'serve':
      return cmdServe();
    case 'queue-test':
      return cmdQueueTest();
    default:
      // eslint-disable-next-line no-console
      console.log('Commands:\n  check                  Verify Sheets, Claude, accounts, Slack\n  login <accountId>      Open a browser to save a Grubhub session\n  order                  Process one queued order then exit\n  run                    Loop: process queued orders forever (Ctrl+C to stop)\n  serve                  Webhook server: process instantly when a new row is added (+ fallback poll)\n  queue-test             Append a test order row to the Sheet (TEST_URL / TEST_ITEMS / TEST_MAX_TOTAL env overrides)');
      process.exit(0);
  }
}

export { processOneOrder };

// Only run the CLI when invoked directly (node src/index.js ...). When this
// module is require()'d (e.g. by src/server.js), skip the CLI dispatch.
if (require.main === module) {
  main().catch((err: any) => {
    logger.error({ err: err.message, stack: err.stack }, 'fatal');
    process.exit(1);
  });
}
