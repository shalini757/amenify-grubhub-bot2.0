# Trigger setup — Sheet → bot (grubhub-bot 2.0)

Goal: when a new row is added to the Sheet, Apps Script POSTs to the bot and an
order starts. This is the part that was silently failing in v1. Follow in order.

## One-time

```
cd grubhub-bot-2.0
npm install
npx playwright install chromium    # if not already installed globally
```

`.env` already carries: GOOGLE_SHEET_ID, SHEET_TAB_NAME, Slack creds,
TRIGGER_PORT (8787), TRIGGER_SECRET, CLAUDE_MODEL, READY_STATES, DRY_RUN.

## Every run (order matters)

1. **Chrome up** (the bot attaches to it via CDP — nothing places without it):
   ```
   npm run chrome
   ```
   In that Chrome: go to grubhub.com, sign in, set address, leave it open.

2. **Bot server**:
   ```
   npm run serve
   ```
   You should see the banner + `trigger server listening`. The banner tells you
   if the secret is set.

3. **Tunnel** (Apps Script can't reach localhost):
   ```
   ngrok http 8787
   ```
   Copy the `https://....ngrok-free.app` URL.

4. **Apps Script** (Sheet → Extensions → Apps Script):
   ```javascript
   const WEBHOOK_URL = 'https://YOUR-TUNNEL.ngrok-free.app/trigger';
   const TRIGGER_SECRET = 'PASTE_SAME_AS_.env';   // must match exactly

   function onSheetChange(e) {
     UrlFetchApp.fetch(WEBHOOK_URL, {
       method: 'post',
       contentType: 'application/json',
       headers: { 'X-Trigger-Secret': TRIGGER_SECRET },
       payload: JSON.stringify({ changeType: e && e.changeType }),
       muteHttpExceptions: true,
     });
   }
   ```
   Then install the trigger: clock icon → Add Trigger → function `onSheetChange`,
   event source **From spreadsheet**, event type **On change** → authorize.

## Verify the trigger actually works (don't trust Apps Script history)

Apps Script logs "success" even when the POST is refused (muteHttpExceptions).
Check the BOT side instead:

```
curl https://YOUR-TUNNEL.ngrok-free.app/health
```

- Watch `triggers.accepted` and `triggers.lastTriggerAt`.
- Add a row in the Sheet → re-run the curl. If `accepted` went up, the trigger
  works end to end. If it didn't move:
  - `triggers.rejected` went up instead → **secret mismatch** (fix the Apps
    Script secret to match `.env`).
  - nothing moved at all → the POST never arrived → **wrong tunnel URL** in Apps
    Script, or `npm run serve` isn't running, or ngrok restarted (URL changed).

## Common silent failures (all fixed/visible now)

| Symptom | Cause | Fix |
|---|---|---|
| Apps Script "success" but nothing runs | muteHttpExceptions hides refusal | check `/health`, not Apps Script |
| `lastTriggerAt` never updates | serve not running / wrong URL | start serve; re-paste ngrok URL |
| `rejected` climbs | secret mismatch | match Apps Script secret to `.env` |
| trigger accepted but order fails instantly | Chrome/CDP not up | `npm run chrome` first |
| works then stops next day | ngrok free URL rotated | re-paste new URL into Apps Script |

## Notes

- Row only runs if it passes the ready filter (id set, lock column empty, state
  in READY_STATES, grubhub URL in notes).
- Fallback poll still runs every POLL_INTERVAL_MS, so a missed webhook is caught
  within ~30s — the trigger is an optimization, not a single point of failure.
- DRY_RUN=true stops before placing. Flip to false only when ready (Slack
  approval still gates the actual Place Order).
