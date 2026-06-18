const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { logger } = require('../logger');
const approvalStore = require('./approvalStore');

const SLACK_API = 'https://slack.com/api';

function token() {
  const t = process.env.SLACK_BOT_TOKEN;
  if (!t) throw new Error('SLACK_BOT_TOKEN env var is required for approval flow');
  return t;
}

function channelId() {
  const c = process.env.SLACK_APPROVAL_CHANNEL;
  if (!c) throw new Error('SLACK_APPROVAL_CHANNEL env var is required (channel ID like C0123456789 or channel name)');
  return c;
}

// Uploads a local screenshot to Slack using the modern files.uploadV2 flow:
//   1. files.getUploadURLExternal → returns upload_url + file_id
//   2. PUT the bytes to upload_url
//   3. files.completeUploadExternal with the file_id (and optional channel)
// Returns { ok, fileId, permalink } or { ok: false, error }.
async function uploadScreenshot(localPath, { title, channelId: chId, threadTs, initialComment } = {}) {
  if (!localPath || !fs.existsSync(localPath)) {
    return { ok: false, error: 'screenshot file not found' };
  }
  const stats = fs.statSync(localPath);
  const filename = path.basename(localPath);
  // Step 1
  const urlRes = await fetch(`${SLACK_API}/files.getUploadURLExternal?filename=${encodeURIComponent(filename)}&length=${stats.size}`, {
    headers: { authorization: `Bearer ${token()}` },
  });
  const urlJson = await urlRes.json().catch(() => ({}));
  if (!urlJson.ok) return { ok: false, error: `getUploadURLExternal: ${urlJson.error || 'unknown'}` };
  const { upload_url, file_id } = urlJson;
  if (!upload_url || !file_id) return { ok: false, error: 'getUploadURLExternal: missing upload_url/file_id' };
  // Step 2
  const bytes = fs.readFileSync(localPath);
  const uploadRes = await fetch(upload_url, { method: 'POST', body: bytes });
  if (!uploadRes.ok) return { ok: false, error: `upload PUT failed: ${uploadRes.status}` };
  // Step 3
  const completeRes = await fetch(`${SLACK_API}/files.completeUploadExternal`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      files: [{ id: file_id, title: title || filename }],
      // Must be a real channel ID (Cxxxx), NOT a channel name. Callers pass the
      // ID resolved from chat.postMessage's response so a name-configured
      // SLACK_APPROVAL_CHANNEL doesn't silently drop the image.
      channel_id: chId || channelId(),
      ...(threadTs ? { thread_ts: threadTs } : {}),
      ...(initialComment ? { initial_comment: initialComment } : {}),
    }),
  });
  const completeJson = await completeRes.json().catch(() => ({}));
  if (!completeJson.ok) return { ok: false, error: `completeUploadExternal: ${completeJson.error || 'unknown'}` };
  const file = (completeJson.files && completeJson.files[0]) || {};
  return { ok: true, fileId: file.id || file_id, permalink: file.permalink };
}

// Build a clean, scannable approval card. Sections, not a JSON dump:
//   • header line
//   • the itemized order (name × qty — price)
//   • totals + budget cap
//   • delivery address
//   • compact meta row (order id / account / sheet row / restaurant)
//   • Accept / Reject buttons (or a dry-run preview note)
function buildApprovalBlocks({
  orderId, restaurantName, items = [], subtotal, total, currency = '$',
  maxTotal, deliveryAddress, account, rowNumber, dryRun = false,
}) {
  const money = (n) => (n != null && n !== '' ? `${currency}${n}` : 'n/a');

  const itemLines = (items || []).length
    ? items.map((i) => `• ${i.name}  ×${i.qty || 1}${i.price != null ? `  —  ${money(i.price)}` : ''}`).join('\n')
    : '_No line items parsed_';

  const overBudget = total != null && maxTotal != null && Number(total) > Number(maxTotal);
  const totalsText =
    `*Subtotal:* ${money(subtotal)}\n` +
    `*Order total:* ${money(total)}` +
    (maxTotal != null ? `   _(cap ${money(maxTotal)})_${overBudget ? '  :warning: *OVER CAP*' : ''}` : '');

  const headerText = dryRun
    ? `🧪 DRY-RUN preview — Order ${orderId}`
    : `🛒 Approval needed — Order ${orderId}`;

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: headerText.slice(0, 150) } },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${restaurantName || 'Restaurant'}*` },
    },
    { type: 'section', text: { type: 'mrkdwn', text: `*Items*\n${itemLines}`.slice(0, 2900) } },
    { type: 'section', text: { type: 'mrkdwn', text: totalsText } },
  ];

  if (deliveryAddress) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Deliver to*\n${String(deliveryAddress).slice(0, 300)}` } });
  }

  blocks.push({
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: `Order \`${orderId}\`  •  Account \`${account || 'n/a'}\`  •  Sheet row \`${rowNumber || 'n/a'}\`` },
    ],
  });

  blocks.push({ type: 'divider' });

  if (dryRun) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: ':information_source: *This is a dry-run preview.* No order will be placed regardless of which button you press.' },
    });
  }

  // Action buttons. The interactive payload carries channel.id + message.ts,
  // so the click handler can derive the store key without us embedding ts here
  // (we don't know ts until after the post). We pass orderId/row in `value` for
  // logging + the follow-up message.
  const value = JSON.stringify({ orderId, rowNumber, dryRun });
  blocks.push({
    type: 'actions',
    block_id: `approval_actions_${orderId}`,
    elements: [
      {
        type: 'button',
        style: 'primary',
        text: { type: 'plain_text', text: dryRun ? '✅ Accept (preview)' : '✅ Accept & Place Order', emoji: true },
        action_id: 'approve_order',
        value,
        ...(dryRun ? {} : {
          confirm: {
            title: { type: 'plain_text', text: 'Place this order?' },
            text: { type: 'mrkdwn', text: `This will place Order ${orderId} for ${money(total)} on Grubhub.` },
            confirm: { type: 'plain_text', text: 'Place order' },
            deny: { type: 'plain_text', text: 'Cancel' },
          },
        }),
      },
      {
        type: 'button',
        style: 'danger',
        text: { type: 'plain_text', text: '❌ Reject', emoji: true },
        action_id: 'reject_order',
        value,
      },
    ],
  });

  return blocks;
}

// Posts the approval message with Accept/Reject buttons and threads the
// checkout screenshot beneath it. Returns { ok, channel, ts } so the caller
// can block on waitForButtonApproval. When dryRun is true, the message is
// posted for visibility but NO pending waiter is registered (nothing blocks,
// no order is placed).
async function sendCheckoutApproval({
  orderId, restaurantName, items, subtotal, total, currency = '$', maxTotal,
  deliveryAddress, account, screenshotPath, rowNumber, dryRun = false,
}) {
  if (!orderId) throw new Error('sendCheckoutApproval: orderId is required');

  const blocks = buildApprovalBlocks({
    orderId, restaurantName, items, subtotal, total, currency, maxTotal,
    deliveryAddress, account, rowNumber, dryRun,
  });

  const res = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token()}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      channel: channelId(),
      text: `${dryRun ? 'DRY-RUN preview' : 'Approval needed'} — Order ${orderId} (${restaurantName || 'restaurant'})`,
      blocks,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) {
    logger.warn({ orderId, error: json.error, raw: json }, 'chat.postMessage failed');
    return { ok: false, error: json.error || 'unknown' };
  }
  logger.info({ orderId, channel: json.channel, ts: json.ts, dryRun }, 'approval message posted to Slack');

  const channel = json.channel;
  const ts = json.ts;
  if (!channel || !ts) {
    logger.warn({ orderId }, 'chat.postMessage ok but missing channel/ts');
    return { ok: false, error: 'missing channel/ts' };
  }

  // Register a pending decision so a button click can unblock the order
  // process. Skip for dry-run (nothing is waiting).
  if (!dryRun) approvalStore.register(channel, ts);

  // Upload the checkout screenshot INTO this message's thread, using the
  // channel ID Slack just resolved. files.completeUploadExternal requires a
  // real channel ID, and threading keeps the image right under the buttons.
  let screenshotPermalink = null;
  if (screenshotPath) {
    const up = await uploadScreenshot(screenshotPath, {
      title: `Order ${orderId} — checkout review`,
      channelId: channel,
      threadTs: ts,
      initialComment: dryRun
        ? 'Checkout review screenshot (dry-run preview).'
        : 'Checkout review — use the Accept / Reject buttons on the message above.',
    });
    if (up.ok) {
      screenshotPermalink = up.permalink ?? null;
      logger.info({ orderId, fileId: up.fileId }, 'checkout screenshot posted to Slack thread');
    } else {
      logger.warn({ orderId, error: up.error }, 'screenshot upload failed — approval message sent without image');
      await postFollowUp({
        channel,
        ts,
        text: `:warning: Could not attach the checkout screenshot (${up.error}). Decide based on the order details above.`,
      }).catch(() => {});
    }
  }

  return { ok: true, channel, ts, screenshotPermalink };
}

// Block until a reviewer clicks Accept/Reject on the message (resolved via the
// approvalStore, which the /slack/interactive route populates), or the timeout
// elapses. Same return shape as the old reaction-based waiter.
async function waitForButtonApproval({ channel, ts, timeoutMs = 15 * 60 * 1000, signal } = {}) {
  if (!channel || !ts) throw new Error('waitForButtonApproval requires { channel, ts }');
  logger.info({ channel, ts, timeoutMs }, 'waiting for Slack button approval');
  return approvalStore.waitFor(channel, ts, { timeoutMs, signal });
}

// Verify a Slack request signature (X-Slack-Signature / timestamp) using the
// app's signing secret. Returns true if valid, or if no SLACK_SIGNING_SECRET
// is configured (verification disabled — logged once by the caller).
function verifySlackSignature({ signingSecret, timestamp, signature, rawBody }) {
  if (!signingSecret) return true; // disabled
  if (!timestamp || !signature) return false;
  // Reject requests older than 5 min (replay protection).
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 60 * 5) return false;
  const base = `v0:${timestamp}:${rawBody}`;
  const expected = 'v0=' + crypto.createHmac('sha256', signingSecret).update(base).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch (_) {
    return false;
  }
}

// Handle a parsed Slack interactive payload (the object inside `payload=`).
// Resolves the approvalStore so the blocked order process gets the decision,
// and updates the original message to show the outcome + disable the buttons.
// Returns { handled, decision } for logging.
async function handleInteractivePayload(payload) {
  const action = (payload.actions && payload.actions[0]) || {};
  const actionId = action.action_id;
  if (actionId !== 'approve_order' && actionId !== 'reject_order') {
    return { handled: false, reason: 'not an approval action' };
  }
  const channel = (payload.channel && payload.channel.id) || (payload.container && payload.container.channel_id);
  const ts = (payload.message && payload.message.ts) || (payload.container && payload.container.message_ts);
  const user = (payload.user && payload.user.id) || 'unknown';
  const userName = (payload.user && (payload.user.username || payload.user.name)) || user;
  if (!channel || !ts) {
    return { handled: false, reason: 'missing channel/ts in payload' };
  }
  let meta = {};
  try { meta = JSON.parse(action.value || '{}'); } catch (_) { /* ignore */ }
  const decisionWord = actionId === 'approve_order' ? 'approve' : 'reject';

  const decision = { ok: true, decision: decisionWord, userId: user, userName, addedAt: Date.now() };
  const accepted = approvalStore.resolve(channel, ts, decision);

  // Update the original message: replace the buttons with a status line so it's
  // clear the decision was recorded and can't be double-clicked.
  const verb = decisionWord === 'approve' ? ':white_check_mark: *Approved*' : ':x: *Rejected*';
  const note = accepted
    ? `${verb} by <@${user}> — ${decisionWord === 'approve' ? 'placing the order…' : 'order will NOT be placed.'}`
    : `${verb} by <@${user}> — _(no active order was waiting; this was a dry-run preview or the window already closed.)_`;

  await updateMessage({
    channel,
    ts,
    text: note,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: note } }],
  }).catch(() => {});

  logger.info({ channel, ts, decision: decisionWord, user, accepted, meta }, 'interactive approval handled');
  return { handled: true, decision: decisionWord, accepted };
}

// chat.update — replace a message's text/blocks in place.
async function updateMessage({ channel, ts, text, blocks }) {
  const res = await fetch(`${SLACK_API}/chat.update`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel, ts, text, ...(blocks ? { blocks } : {}) }),
  });
  return res.json().catch(() => ({}));
}

// ---- Approval receive half: emoji reactions ----
//
// We avoid the Slack interactivity endpoint (which needs a public HTTPS URL)
// by polling reactions on the approval message. The reviewer reacts with
// :white_check_mark: (approve) or :x: (reject); the bot picks the FIRST
// reaction added by any non-bot user.
//
// Returns one of:
//   { ok: true, decision: 'approve' | 'reject', userId, addedAt }
//   { ok: false, decision: 'timeout', polledFor: ms }
//   { ok: false, error: '...' }  (Slack API failure)
const APPROVE_EMOJI = (process.env.SLACK_APPROVE_EMOJI || 'white_check_mark').replace(/^:|:$/g, '');
const REJECT_EMOJI = (process.env.SLACK_REJECT_EMOJI || 'x').replace(/^:|:$/g, '');

async function waitForReactionApproval({ channel, ts, timeoutMs = 15 * 60 * 1000, pollIntervalMs = 5000, signal } = {}) {
  if (!channel || !ts) throw new Error('waitForReactionApproval requires { channel, ts }');
  const deadline = Date.now() + timeoutMs;
  const botId = await getBotUserId().catch(() => null);
  logger.info({ channel, ts, timeoutMs, approveEmoji: APPROVE_EMOJI, rejectEmoji: REJECT_EMOJI, botId }, 'waiting for Slack reaction approval');

  while (Date.now() < deadline) {
    if (signal && signal.aborted) {
      return { ok: false, decision: 'aborted' };
    }
    const params = new URLSearchParams({ channel, timestamp: ts, full: 'true' });
    const res = await fetch(`${SLACK_API}/reactions.get?${params.toString()}`, {
      headers: { authorization: `Bearer ${token()}` },
    });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) {
      // 'message_not_found' can happen transiently right after posting. Don't
      // bail on a single API error — just keep polling. Log so it's visible.
      logger.warn({ error: json.error }, 'reactions.get failed (continuing to poll)');
    } else {
      const reactions = (json.message && json.message.reactions) || [];
      // Find the first reaction whose user list contains a non-bot user.
      let earliest = null;
      for (const r of reactions) {
        const name = (r.name || '').toLowerCase();
        if (name !== APPROVE_EMOJI && name !== REJECT_EMOJI) continue;
        const realUser = (r.users || []).find((u) => u !== botId);
        if (!realUser) continue;
        const decision = name === APPROVE_EMOJI ? 'approve' : 'reject';
        // Without per-reaction timestamps from Slack, pick approve over reject
        // when both are present (safer default: human explicitly approved).
        if (!earliest || (decision === 'approve' && earliest.decision === 'reject')) {
          earliest = { decision, userId: realUser, emoji: name };
        }
      }
      if (earliest) {
        logger.info({ channel, ts, ...earliest }, 'Slack reaction approval decision received');
        return { ok: true, ...earliest, addedAt: Date.now() };
      }
    }
    // Sleep, but in small slices so an AbortSignal can interrupt promptly.
    const sliceMs = Math.min(pollIntervalMs, 1000);
    const slices = Math.ceil(pollIntervalMs / sliceMs);
    for (let i = 0; i < slices; i++) {
      if (signal && signal.aborted) return { ok: false, decision: 'aborted' };
      await new Promise((r) => setTimeout(r, sliceMs));
    }
  }
  logger.warn({ channel, ts, polledFor: timeoutMs }, 'Slack reaction approval timed out');
  return { ok: false, decision: 'timeout', polledFor: timeoutMs };
}

// Cache the bot's user id so we don't call auth.test on every poll iteration.
// We need it to filter out the bot's own reactions (we sometimes seed the
// message with a starter reaction so reviewers see the picker pre-warmed).
let _botUserId;
async function getBotUserId() {
  if (_botUserId) return _botUserId;
  const res = await fetch(`${SLACK_API}/auth.test`, {
    headers: { authorization: `Bearer ${token()}` },
  });
  const json = await res.json().catch(() => ({}));
  if (json.ok && json.user_id) _botUserId = json.user_id;
  return _botUserId;
}

// Post a final status line in the same channel so the reviewer sees the
// outcome of their approval/rejection in context. Non-fatal: if this fails
// we just log and move on (the order itself still completed).
async function postFollowUp({ channel, ts, text }) {
  try {
    const res = await fetch(`${SLACK_API}/chat.postMessage`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token()}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel, thread_ts: ts, text }),
    });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) logger.warn({ error: json.error }, 'postFollowUp failed');
    return json;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, 'postFollowUp threw');
    return { ok: false, error: message };
  }
}

// ---- Fire-and-forget alerts ----
//
// Unlike sendCheckoutApproval (which needs a decision), alerts are one-way
// notifications: order placed, failed, needs review, restaurant closed, etc.
// They are best-effort and NEVER throw — if Slack isn't configured or the API
// errors, we log and return { ok: false } so the caller's main flow is
// unaffected. Alerts post to SLACK_ALERT_CHANNEL if set, else fall back to
// SLACK_APPROVAL_CHANNEL.
function alertChannel() {
  return process.env.SLACK_ALERT_CHANNEL || process.env.SLACK_APPROVAL_CHANNEL || null;
}

async function sendAlert({ emoji = ':bell:', title, fields = [], text } = {}) {
  const tk = process.env.SLACK_BOT_TOKEN;
  const ch = alertChannel();
  if (!tk || !ch) {
    logger.warn('slack alert skipped — SLACK_BOT_TOKEN / SLACK_ALERT_CHANNEL not configured');
    return { ok: false, error: 'not_configured' };
  }
  const headerText = `${emoji} ${title || 'Bot alert'}`.slice(0, 150);
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${headerText}*` } },
  ];
  const fieldBlocks = (fields || [])
    .filter((f) => f && f.label != null && f.value != null && String(f.value) !== '')
    .map((f) => ({ type: 'mrkdwn', text: `*${f.label}:*\n${String(f.value).slice(0, 300)}` }));
  if (fieldBlocks.length) {
    // Slack caps a section at 10 fields.
    blocks.push({ type: 'section', fields: fieldBlocks.slice(0, 10) });
  }
  if (text) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: String(text).slice(0, 2900) } });
  }
  try {
    const res = await fetch(`${SLACK_API}/chat.postMessage`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tk}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel: ch, text: headerText, blocks }),
    });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) {
      logger.warn({ error: json.error }, 'slack alert chat.postMessage failed');
      return { ok: false, error: json.error || 'unknown' };
    }
    logger.info({ channel: json.channel, ts: json.ts, title }, 'slack alert sent');
    return { ok: true, channel: json.channel, ts: json.ts };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, 'slack alert threw (non-fatal)');
    return { ok: false, error: message };
  }
}

module.exports = {
  sendCheckoutApproval,
  uploadScreenshot,
  waitForButtonApproval,
  waitForReactionApproval, // kept for backward-compat / fallback
  handleInteractivePayload,
  verifySlackSignature,
  postFollowUp,
  updateMessage,
  sendAlert,
};
