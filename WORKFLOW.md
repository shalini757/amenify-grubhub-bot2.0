# Grubhub Order Automation — Workflow & Architecture Guide

A distilled guide capturing every hard-won insight from this project, so a new
project can be built without re-learning the same lessons. Read this top to
bottom before designing the new system.

---

## 1. What the system does (one paragraph)

A booking system writes food orders into a Google Sheet (one row per order,
details in a free-text `notes` field). The bot picks up each ready row, opens
the restaurant on Grubhub in a real browser, matches the requested items to the
live menu within a budget, fills the cart and checkout, and — gated behind a
human Slack approval — places the order. Everything verifiable is done in plain
code; AI (Claude) is used only where fuzzy judgment is genuinely required.

---

## 2. The end-to-end pipeline (phases)

```
Sheet row (ready)
  → parse notes (regex)            → structured request
  → parse items (regex)            → [{name, qty, price}]
  → launch / attach browser        → real Chrome via CDP (anti-bot)
  → ensure signed in               → hard assert, not loose regex
  → clean slate                    → wipe localStorage/sessionStorage (keep login)
  → set order type (delivery/pickup) BEFORE navigation (localStorage)
  → set resident address via pill  BEFORE navigation (delivery only) + hard gate
  → navigate to restaurant URL
  → scrape menu                    → handle closed / out-of-range / virtualized list
  → (preorder if closed/target time)
  → match items (Claude rank → JS budget solve)
  → add to cart (+ required modifiers)
  → read cart subtotal             → budget checkpoint 1
  → proceed to checkout, read total (incl fees/tax/tip) → budget checkpoint 2
  → fill contact (resident name/phone) + special instructions
  → URL gate: must be on /checkout/.../review
  → Slack approval (✅/❌ reaction) — DRY_RUN stops here
  → place order
  → write result back to sheet
```

Each phase failure writes a human-readable reason to the sheet and stops —
**never guesses forward into a real action.**

---

## 3. Core architectural decisions (and WHY)

### 3.1 AI does semantics, code does everything verifiable
- **Claude** is used for: item→menu matching (ranking candidates), picking
  sensible modifier defaults, parsing confirmation pages, diagnosing failures.
- **Plain code** does: budget arithmetic, address handling, URL checks, order
  type, all safety gates.
- Rationale: Claude hallucinates prices and ignores cross-item tradeoffs. The
  bot has exact data and exact arithmetic — budget is never Claude's job.

### 3.2 Item matching is two passes
1. **`rankCandidates`** — ONE Claude call. For each requested item, returns a
   ranked list of menu candidates with verbatim name + verbatim price +
   confidence (0–1) + `kind: exact|fuzzy`. Prompt explicitly says: do NOT reason
   about budget, copy prices verbatim, no estimating.
2. **`solveBudget`** — pure JS. Filters by confidence threshold (default 0.85),
   enumerates combinations (capped at 10k, truncates to top-3 each if larger),
   scores them `100*exactCount + totalConfidence + small budget-utilization
   bonus`, picks the highest-scoring combo under `maxTotal`. Returns diagnostic
   "attempts" when nothing fits.

### 3.3 Fail to the human, never guess into an action
Every uncertain branch → write reason to sheet (+ optional Slack alert) → stop.
A wrong order costs real money; a flagged row costs a human 30 seconds.

### 3.4 Dry-run by default
`DRY_RUN=true` runs the full pipeline but stops at the checkout review page
without placing. Flip to `false` only when confident, and even then a Slack
approval gates the actual Place Order click.

---

## 4. The hard-won gotchas (THIS IS THE VALUABLE PART)

### 4.1 Anti-bot: attach to a REAL Chrome via CDP
- Grubhub uses PerimeterX. A vanilla Playwright/stealth browser gets blocked on
  restaurant pages.
- **Solution:** launch a real Chrome with `--remote-debugging-port=9222` and a
  dedicated `--user-data-dir`, sign in manually (solve any captcha yourself),
  leave it open. The bot attaches via `chromium.connectOverCDP('localhost:9222')`.
- **Operational cost:** Chrome must be running BEFORE the bot. If it isn't, every
  row fails with `connectOverCDP: Timeout 120000ms exceeded` and (worse) gets
  marked failed. The bot does NOT launch its own Chrome when `BROWSER_CDP_URL`
  is set.
- Use a long CDP timeout (120s) — Grubhub pages spawn 100+ ad/tracking iframes
  and target enumeration is slow.
- **New-project lesson:** decouple "is the browser healthy?" from "process the
  row." Add a pre-flight health check (`GET /health` on the CDP endpoint, or a
  cheap `browser.contexts()` probe) and PAUSE the queue instead of burning every
  row when the browser is down.

### 4.2 The address must be set BEFORE navigating — and hard-gated
- Every run starts a fresh session carrying the *account's* stale address. If
  you navigate to the restaurant first, Grubhub binds the wrong address and
  fires "Outside of delivery range."
- Set order type + resident address on the homepage pill FIRST, then a hard gate
  refuses to open the restaurant URL until the address is verified changed.
- **Recovery:** if the out-of-range modal still appears on the restaurant page,
  re-run the pill flow — it detects the modal, clicks "Change", re-types the
  notes address, picks the autocomplete match, clicks Update, dismisses the
  "save address?" prompt, and verifies the pill text actually changed.
- The pill flow only returns success if the pill visibly shows the new street
  number — never trust a silent UI success.

### 4.3 Menu scraping fights virtualization
- Grubhub unmounts off-screen menu items, so a single scrape sees ~5 items.
- **Two strategies, both needed:**
  1. Accumulating scroll — scroll in steps, harvest whatever's mounted, dedupe
     by name, stop when count stabilizes.
  2. Walk every category tab — some restaurants keep the menu in an inner scroll
     container `window.scrollBy` can't move; click each sidebar category and
     harvest in place. ALWAYS walk them (don't gate behind "found < N items" —
     that bug made multi-category menus match 0 items).
- Try a priority list of selectors; first that matches wins. Cards sometimes put
  price before name (take first non-price line as name). Filter pure-price
  elements so sibling price labels aren't mistaken for items.

### 4.4 Classify "can't order" states — don't lump them
Grubhub reuses one "unorderable" UI for several situations. Classify by visible
text into `out_of_range` (fix address, retry), `closed` (retry later / preorder),
`removed` (gone from Grubhub). The review queue routes each differently.

### 4.5 Order type lives in localStorage, not a visible tab
`ngStorage-cartState.orderType` = `standard` (delivery) | `pickup`. Grubhub reads
it on SPA mount, so set it BEFORE navigation. Defense-in-depth: verify the
visible delivery/pickup toggle (`aria-pressed`) after navigation.

### 4.6 The cart sidebar is `role=dialog`
Don't let a generic "dismiss popups" routine close the cart. Skip dismissal when
the checkout button is visible. Never use broad `*="close"` / `aria-label*="lose"`
matchers or blind ESC presses.

### 4.7 Two budget checkpoints
`MAX_TOTAL_BASIS=all_in` (default): cap includes fees/tax/tip, enforced on the
final checkout total. `=subtotal`: cap is items-only, enforced on cart subtotal.
Read subtotal after adding, then the real total at checkout.

### 4.8 Modifiers: Claude picks, code guards
Resident preferences from notes override Claude's defaults. If Claude names an
option the DOM doesn't have, fall back to the cheapest option so a hallucinated
label can't block the cart.

### 4.9 URL-gate before any outward action
Only send the Slack approval / place the order when `page.url()` matches
`/checkout/.../review`. Prevents approving/placing from the wrong page.

---

## 5. The Sheet contract

- One row per order. Free-text `notes` field carries everything, parsed by regex
  on labeled lines:
  - `Store: <name> - Delivery Order` / `Pickup Order` → store + order type
  - `Order URL:` → restaurant page
  - `Total: $25` → budget cap
  - `Items: Name x Qty ($Price), ...`
  - `Resident address:` → delivery address
  - `Resident name:` / `Temporary phone:` → checkout identity
  - `<Item> modifiers: bread=White Bread, cheese=Provolone`
  - target time (e.g. "7:30 PM", AM/PM required) → preorder
- **Ready filter:** a row processes only if `id` set, `script`/lock column empty,
  `state` in a ready list, and notes contain a `grubhub.com/restaurant/` URL.
- **Locking:** Sheets has no compare-and-swap. Write a per-run nonce to the lock
  column, re-read after a delay to detect a competing writer. Single bot
  recommended; locking only *reduces* the race window.
- **Switching sheets:** change `GOOGLE_SHEET_ID` + `SHEET_TAB_NAME` in `.env`,
  share the sheet with the service-account email as Editor, and ensure the header
  row matches the expected column names (`npm run check` verifies).
- **CSV import:** File → Import → Upload → "Insert new sheet(s)"; rename the tab;
  header row must match the schema.

---

## 6. Operational workflow (run modes)

| Command | What it does |
|---|---|
| `npm run chrome` | Launch the real debug Chrome (port 9222). Sign in, leave open. **Always first.** |
| `npm run check` | Verify Sheets reachable + columns + Claude + accounts + Slack. |
| `node src/index.js order` | Process ONE ready row, then exit. |
| `node src/index.js run` | Loop: process every ready row, then poll forever. |
| `npm run serve` | Webhook server: instant trigger on sheet change + fallback poll. |
| `npm run dry-run` | Single end-to-end test (stops before placing). |

### Instant trigger (Sheet → bot) setup
1. `npm run serve` (listens on `TRIGGER_PORT`, default 8787).
2. Tunnel: `ngrok http 8787` → copy the HTTPS URL.
3. Apps Script `onChange` trigger POSTs to `<tunnel>/trigger` with header
   `X-Trigger-Secret` == `.env` `TRIGGER_SECRET`.
4. Install the trigger (clock icon → Add Trigger → On change → From spreadsheet).

**Trigger gotchas (these silently fail):**
- Apps Script uses `muteHttpExceptions: true`, so execution history shows
  "success" even when the POST is refused or returns 401. Execution history ≠
  the bot ran.
- `npm run serve` must be running, or the POST hits a dead port (connection
  refused). Verify with `curl <tunnel>/health` → `{"ok":true}`.
- ngrok free URLs change on every restart — re-paste into Apps Script each time.
- Secret mismatch → 401 (hidden). Header secret must equal `.env` secret exactly.
- Single-flight drain: bursts of triggers collapse into one queue-drain; a row
  added mid-run isn't missed. Fallback poll covers dropped webhooks.

---

## 7. Safety/correctness invariants (carry these forward verbatim)

1. Never open the restaurant URL (delivery) until the resident address is set
   AND verified.
2. Never type an address into the menu search bar — scope inputs to the
   open modal/dialog; exclude the known menu-search element by id/testid.
3. Never trust a silent UI success — verify the resulting state (pill text,
   URL, cart contents).
4. Never place / approve unless URL matches the review page.
5. Never let Claude's output cause an action without a code-side guard
   (cheapest-fallback for modifiers, budget solve in JS, etc.).
6. Two budget checks: cart subtotal AND fees-inclusive checkout total.
7. Dry-run by default; real placement gated behind human Slack approval.
8. On any uncertainty: write reason to sheet, stop, optionally alert.

---

## 8. What to improve in the NEW project

- **Browser health pre-flight + queue pause** instead of burning every row when
  Chrome/CDP is down (the single biggest operational pain here).
- **Idempotency / clear state machine** for row status (`ready → locked →
  in-progress → done/failed/needs-review`) with explicit, documented states
  rather than ad-hoc strings (`bot-failed`, `in progress by Bot`, `dry-run-done`).
- **A reset/requeue tool** as a first-class command (resetting failed rows was a
  manual one-off script here).
- **Stable tunnel** (reserved ngrok domain or cloudflared named tunnel) so the
  Apps Script URL doesn't rot on every restart.
- **Structured notes** (JSON column) instead of regex-parsed free text, if the
  upstream booking system can be changed.
- **Per-restaurant selector overrides** — menu DOM varies; a small config map
  beats growing the selector fallback list.
- **Observability**: a run log / dashboard so "execution history but nothing
  happened" is diagnosable at a glance (health, last drain, last row, last error).
```
