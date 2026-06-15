'use strict';

require('dotenv').config();

const http = require('http');
const { logger } = require('./logger');
const sheetClient = require('./sheet/sheetClient');
const claudeClient = require('./claude/claudeClient');
const { listAccounts, pickAccount } = require('./accounts/accountPicker');
const { sendReviewAlert } = require('./review/reviewQueue');
const {
  manualLoginAndSave,
  launchContext,
  ensureLoggedIn,
  detectBlockers,
  saveScreenshot,
  setGrubhubOrderType,
  setResidentAddressViaPill,
  clearGrubhubStorage,
} = require('./grubhub/browser');
const { parseNotes } = require('./parse/notesParser');
const { parseItems } = require('./parse/itemsParser');
const { scrapeMenu, tryPreorder, switchToPickup } = require('./grubhub/menuScraper');
const cart = require('./grubhub/cart');

async function cmdCheck() {
  logger.info('--- Day 1 verification ---');
  const results = { sheet: null, claude: null, accounts: null, slack: null };

  try {
    const meta = await sheetClient.verifyConnection();
    results.sheet = { ok: true, title: meta.title, tab: meta.tab };
    logger.info({ title: meta.title, tab: meta.tab }, '[OK] Google Sheets reachable');
  } catch (err) {
    results.sheet = { ok: false, error: err.message };
    logger.error({ err: err.message }, '[FAIL] Google Sheets');
  }

  try {
    const r = await claudeClient.helloWorld();
    results.claude = { ok: r.ok, model: r.model };
    if (r.ok) logger.info({ model: r.model }, '[OK] Claude API reachable');
    else logger.warn({ text: r.text }, '[WARN] Claude responded but content unexpected');
  } catch (err) {
    results.claude = { ok: false, error: err.message };
    logger.error({ err: err.message }, '[FAIL] Claude API');
  }

  try {
    const accts = listAccounts();
    results.accounts = { ok: true, count: accts.length, ids: accts.map((a) => a.id) };
    logger.info({ count: accts.length, ids: accts.map((a) => a.id) }, '[OK] Grubhub accounts loaded');
  } catch (err) {
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
    results.slack = slack;
    if (slack.sent) logger.info('[OK] Slack webhook reachable');
    else logger.warn({ slack }, '[WARN] Slack webhook not configured or not reachable');
  } catch (err) {
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

async function cmdLogin(accountId) {
  if (!accountId) {
    // eslint-disable-next-line no-console
    console.error('Usage: npm run login -- <accountId>');
    process.exit(2);
  }
  await manualLoginAndSave(accountId);
  logger.info({ accountId }, 'login flow completed');
  process.exit(0);
}

async function cmdOrder() {
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
function preflightChromeReachable() {
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
    req.on('error', (err) => {
      resolve({ ok: false, reason: `${err.code || err.message} connecting to ${probeUrl}` });
    });
  });
}

async function processOneOrder() {
  const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
  const CONFIDENCE_THRESHOLD = parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.85');
  const MIN_AVG_CONFIDENCE = parseFloat(process.env.MIN_AVG_CONFIDENCE || '0.92');
  // 'all_in' (default): max_total includes fees/tax/tip → enforced on checkout total.
  // 'subtotal':         max_total is item subtotal only → enforced on cart subtotal.
  const MAX_TOTAL_BASIS = (process.env.MAX_TOTAL_BASIS || 'all_in').toLowerCase();

  let exitCode = 0;
  let browser;
  let ctx;
  let lockedRow = null;

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

    const order = orders[0];
    logger.info({ row: order._rowNumber, id: order.id }, 'processing order');

    const parsed = parseNotes(order.notes);
    if (!parsed.isGrubhub || !parsed.orderUrl) {
      await sheetClient.writeReview(order._rowNumber, 'Notes do not contain a Grubhub order URL');
      exitCode = 1;
      return;
    }

    const items = parseItems(parsed.items);
    if (!items.length) {
      await sheetClient.writeReview(order._rowNumber, `Could not parse items from notes. Raw: ${(parsed.items || '').slice(0, 200)}`);
      exitCode = 1;
      return;
    }
    logger.info(
      { items, store: parsed.store, orderType: parsed.orderType, targetTime: parsed.targetTime, maxTotal: parsed.maxTotal },
      'parsed request',
    );

    // Delivery orders need a resident address to fill on the checkout page.
    // Pickup orders skip it. If the order type wasn't parseable, default to
    // delivery (the historical behavior) but flag it for review.
    const isPickup = parsed.orderType === 'pickup';
    // Gate: for delivery orders the restaurant URL must NOT be opened until the
    // resident address is set first (every order launches a fresh session, so
    // order #2+ starts with the account's stale address). Pickup orders have no
    // address to set, so they're cleared to navigate immediately.
    let addressReady = isPickup;
    if (!isPickup && !parsed.deliveryAddress) {
      await sheetClient.writeReview(order._rowNumber, 'Delivery order is missing "Resident address:" line — cannot fill checkout');
      exitCode = 1;
      return;
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

    const page = await ensureLoggedIn(ctx);

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
    } catch (e) {
      logger.warn({ err: e.message }, 'clearGrubhubStorage failed (continuing)');
    }

    // Clear any inherited cart state before adding items (defends against
    // cart leak in CDP mode and crash-recovery double-adds).
    try {
      await cart.clearCart(page, { saveScreenshot });
    } catch (e) {
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
    if (!isPickup && parsed.deliveryAddress) {
      const pillOk = await setResidentAddressViaPill(page, parsed.deliveryAddress).catch(
        (e) => {
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
          reason: `Could not change Grubhub session address to "${parsed.deliveryAddress}". Pill click + Update did not register a verified address change.`,
          order: { order_id: order.id, account: account.id, restaurant_name: parsed.store, max_total: parsed.maxTotal },
        });
        exitCode = 1;
        return;
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

    let menu = await scrapeMenu(page);

    // Out-of-range recovery. Grubhub sometimes loads the restaurant page with
    // the account's stale address instead of the one we set on the homepage,
    // firing the "Outside of delivery range" modal. setResidentAddressViaPill
    // detects that modal, clicks "Change", and re-enters the resident address
    // (browser.js). Try it once on the restaurant page, then re-scrape. Skip
    // for pickup (no delivery address) and when we have no address to re-enter.
    if (menu.count === 0 && menu.reason === 'out_of_range' && !isPickup && parsed.deliveryAddress) {
      logger.warn('out-of-range modal on restaurant page — retrying address via Change');
      await saveScreenshot(page, 'out-of-range-before-recovery');
      const recovered = await setResidentAddressViaPill(page, parsed.deliveryAddress).catch((e) => {
        logger.warn({ err: e.message }, 'out-of-range recovery threw (continuing)');
        return false;
      });
      logger.info({ recovered }, 'out-of-range address recovery result');
      if (recovered) {
        await detectBlockers(page);
        menu = await scrapeMenu(page);
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
        const switched = await switchToPickup(page).catch((e) => {
          logger.warn({ err: e.message }, 'switchToPickup threw (continuing)');
          return false;
        });
        if (switched) {
          await detectBlockers(page);
          menu = await scrapeMenu(page);
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
        return;
      }
    }

    // Preorder is triggered in two cases:
    //   1. Notes carry a target time — pick the slot nearest that time.
    //   2. Restaurant is closed and ALLOW_PREORDER=true — pick earliest slot.
    const allowPreorder = (process.env.ALLOW_PREORDER || '').toLowerCase() === 'true';
    const shouldPreorder = parsed.targetTime || (menu.count === 0 && menu.reason === 'restaurant_closed' && allowPreorder);
    if (shouldPreorder) {
      logger.info({ targetTime: parsed.targetTime, menuCount: menu.count }, 'attempting preorder');
      const pre = await tryPreorder(page, { saveScreenshot, targetTime: parsed.targetTime });
      logger.info({ pre }, 'preorder attempt result');
      if (pre.ok) {
        menu = await scrapeMenu(page);
        logger.info({ count: menu.count, picked: pre.picked }, 'post-preorder rescrape');
      }
    }

    if (menu.count === 0) {
      await saveScreenshot(page, 'menu-empty');
      const visibleText = (menu.closedSignal && menu.closedSignal.text) || '';
      let reason;
      let title;
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
      return;
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
      maxTotal: parsed.maxTotal,
      confidenceThreshold: CONFIDENCE_THRESHOLD,
    });

    logger.info(
      { picks: match.picks, totalUsed: match.totalUsed, withinBudget: match.withinBudget, reason: match.reason, exactCount: match.exactCount },
      'budget-aware match result',
    );

    if (!match.withinBudget) {
      const attemptsStr = (match.attempts || [])
        .map((a) => `${a.label}: $${a.total} — ${a.picks.join('; ')}`)
        .join(' | ');
      const reason =
        `Budget-aware match failed: ${match.reason}` +
        (attemptsStr ? ` Attempts: ${attemptsStr}` : '');
      await sheetClient.writeReview(order._rowNumber, reason.slice(0, 500));
      lockedRow = null;
      await sendReviewAlert({
        severity: 'warn',
        title: 'Items could not be matched within budget',
        reason,
        order: { order_id: order.id, account: account.id, restaurant_name: parsed.store, max_total: parsed.maxTotal },
        extra: { rankedRaw: match.rankedRaw, attempts: match.attempts },
      });
      exitCode = 1;
      return;
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
        addRes.skipped.map((s) => `${s.name} (${s.reason})`).join('; ');
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
      return;
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
      return;
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
      return;
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
      return;
    }

    // Phase 5 — snapshot the review page (address / payment / tip) for the human approver.
    const snap = await cart.gatherCheckoutSnapshot(page);
    await saveScreenshot(page, 'phase5-review-snapshot');
    logger.info({ snap }, 'phase 5: review snapshot captured');
    await sheetClient.appendInternalNote(order._rowNumber, `PHASE5_OK subtotal=${subtotal ?? '?'} total=${checkoutTotal} basis=${MAX_TOTAL_BASIS}`).catch(() => {});

    if (DRY_RUN) {
      const summary =
        `DRY-RUN reached checkout review. ${addRes.added.length} item(s) added, ` +
        `subtotal=$${subtotal ?? '?'}, total=$${checkoutTotal}/$${parsed.maxTotal ?? '∞'}. ` +
        `Did NOT click Place Order. Review URL: ${reviewUrl}`;
      logger.info({ summary }, 'dry-run complete');
      await sendReviewAlert({
        severity: 'info',
        title: 'DRY-RUN reached checkout review (Place Order not clicked)',
        reason: summary,
        order: { order_id: order.id, account: account.id, restaurant_name: parsed.store, max_total: parsed.maxTotal },
        extra: { added: addRes.added, snap },
      });
      // Write a non-ready state so the loop advances to the next row instead
      // of re-picking this one. Reset column E to blank to retry a row.
      await sheetClient.unlockRow(order._rowNumber, summary, 'dry-run-done');
      lockedRow = null;
      // eslint-disable-next-line no-console
      console.log('\n' + summary + '\n');
      return;
    }

    // ---- Phase 5b: fill contact + special instructions ----
    // Contact info on the review page is often pre-filled with the saved
    // account's name/phone. We overwrite with the row's first/last/phone so
    // the order shows the resident, not the bot account. Special instructions
    // come from the parsed notes.
    try {
      // The SHEET ROW columns (first_name/last_name/cell_phone) are the source
      // of truth for the resident — they MUST win over anything parsed from the
      // notes or pre-filled by the bot's Grubhub account, otherwise the order
      // shows the bot account's name/phone. Only fall back to parsed values when
      // a sheet column is blank.
      const contact = {
        firstName: order.first_name || parsed.customerFirstName || parsed.residentFirstName,
        lastName: order.last_name || parsed.customerLastName || parsed.residentLastName,
        phone: order.cell_phone || parsed.customerPhone || parsed.bookingPhone,
        specialInstructions: parsed.specialInstructions || parsed.driverNotes,
      };
      logger.info(
        { firstName: contact.firstName, lastName: contact.lastName, phone: contact.phone, source: 'sheet-first' },
        'filling checkout contact from sheet row',
      );
      await cart.fillCheckoutContact(page, contact);
    } catch (e) {
      logger.warn({ err: e.message }, 'fillCheckoutContact threw (continuing — fields may already be set)');
    }
    await saveScreenshot(page, 'phase5b-after-contact-fill');

    // Advance the checkout "gather" step → review/payment. proceedToCheckout
    // can land on /checkout/.../gather ("Does everything below look correct?"),
    // which has a "Continue to payment" button. Click through it so we reach
    // the review/payment page (dryRunFlow does this via submitCheckoutGather;
    // production must too, or the URL gate below blocks the Slack approval).
    try {
      const gatherRes = await cart.submitCheckoutGather(page, { addressLabel: 'home' });
      logger.info({ gatherRes }, 'phase 5b: submitted checkout gather (advancing to review)');
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(800);
    } catch (e) {
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
      return;
    }

    // ---- Phase 6: Slack approval gate ----
    const { sendCheckoutApproval, waitForReactionApproval, postFollowUp } =
      require('./review/slackApproval');
    const approvalShotPath = await saveScreenshot(page, 'phase6-approval-snapshot');
    const send = await sendCheckoutApproval({
      orderId: order.id,
      restaurantName: parsed.storeName || parsed.store,
      total: checkoutTotal,
      screenshotPath: approvalShotPath,
      rowNumber: order._rowNumber,
    });
    if (!send.ok) {
      await sheetClient.writeFailure(order._rowNumber, `Slack approval send failed: ${send.error || 'unknown'}`);
      lockedRow = null;
      exitCode = 1;
      return;
    }
    await sheetClient.appendInternalNote(
      order._rowNumber,
      `APPROVAL_SENT channel=${send.channel} ts=${send.ts}`,
    ).catch(() => {});

    const approvalTimeoutMs =
      Math.max(60_000, parseInt(process.env.APPROVAL_TIMEOUT_MS || '900000', 10)); // default 15 min
    const decision = await waitForReactionApproval({
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
      return;
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
      return;
    }

    // ---- Phase 7: Place Order ----
    logger.info({ userId: decision.userId }, 'approval received, clicking Place Order');
    await sheetClient.appendInternalNote(
      order._rowNumber,
      `APPROVED_BY ${decision.userId} (${decision.emoji})`,
    ).catch(() => {});

    // Grubhub's review page can drift state if the approval took a few minutes.
    // Reload to be sure we're firing against fresh server-side state.
    if (Date.now() - decision.addedAt < approvalTimeoutMs / 2) {
      // approved quickly — no need to reload
    } else {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(800);
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
      return;
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
  } catch (err) {
    logger.error({ err: err.message, code: err.code, stack: err.stack }, 'order failed');
    if (lockedRow) {
      await sheetClient.writeFailure(lockedRow, err.message).catch(() => {});
    }
    // Surface SESSION_EXPIRED separately so the run loop pauses for the
    // human to re-sign in instead of churning through every row in the queue.
    exitCode = err.code === 'SESSION_EXPIRED' ? 3 : 1;
  } finally {
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
async function cmdRun() {
  const pollMs = Math.max(5000, parseInt(process.env.POLL_INTERVAL_MS || '300000', 10));
  logger.info({ pollMs }, 'starting run loop (Ctrl+C to stop)');
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const code = await processOneOrder().catch((err) => {
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
async function cmdServe() {
  const { startServer } = require('./server');
  await startServer({ processOneOrder });
  // Keep the process alive; startServer holds the HTTP listener open.
}

async function cmdQueueTest() {
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

async function main() {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case 'check':
      return cmdCheck();
    case 'login':
      return cmdLogin(rest[0]);
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

module.exports = { processOneOrder };

// Only run the CLI when invoked directly (node src/index.js ...). When this
// module is require()'d (e.g. by src/server.js), skip the CLI dispatch.
if (require.main === module) {
  main().catch((err) => {
    logger.error({ err: err.message, stack: err.stack }, 'fatal');
    process.exit(1);
  });
}
