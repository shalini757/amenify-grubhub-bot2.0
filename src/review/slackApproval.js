'use strict';

const fs = require('fs');
const path = require('path');
const { logger } = require('../logger');

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

// Posts the approval message with Yes/No buttons. Returns the message
// timestamp + channel so callers can later look up the click (Piece B).
async function sendCheckoutApproval({ orderId, restaurantName, total, currency = '$', screenshotPath, rowNumber }) {
  if (!orderId) throw new Error('sendCheckoutApproval: orderId is required');

  // NOTE: the screenshot is uploaded AFTER the message is posted (below), so we
  // can attach it into the message's thread using the channel ID that
  // chat.postMessage resolves. files.completeUploadExternal needs a real
  // channel ID — uploading before we have it (when SLACK_APPROVAL_CHANNEL is a
  // channel *name*) is what made the image silently never arrive.
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `Approval needed — Order ${orderId}` },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Restaurant:*\n${restaurantName || 'n/a'}` },
        { type: 'mrkdwn', text: `*Total:*\n${currency}${total != null ? total : 'n/a'}` },
        { type: 'mrkdwn', text: `*Sheet Row:*\n${rowNumber || 'n/a'}` },
        { type: 'mrkdwn', text: `*Order ID:*\n${orderId}` },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*To approve or reject, react to THIS message:*\n' +
          ':white_check_mark:  → Approve & place order\n' +
          ':x:  → Reject (no order placed)\n\n' +
          '_Bot polls reactions every 5 seconds, times out after 15 min._',
      },
    },
  ];

  const res = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token()}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      channel: channelId(),
      text: `Approval needed — Order ${orderId} (${restaurantName || 'restaurant'})`,
      blocks,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) {
    logger.warn({ orderId, error: json.error, raw: json }, 'chat.postMessage failed');
    return { ok: false, error: json.error || 'unknown' };
  }
  logger.info({ orderId, channel: json.channel, ts: json.ts }, 'approval message posted to Slack');

  // Now upload the checkout screenshot INTO this message's thread, using the
  // channel ID Slack just resolved (json.channel). This is the reliable path:
  // files.completeUploadExternal requires a channel ID, and threading it keeps
  // the image directly under the approval message reviewers react to.
  let screenshotPermalink = null;
  if (screenshotPath) {
    const up = await uploadScreenshot(screenshotPath, {
      title: `Order ${orderId} — final checkout review`,
      channelId: json.channel,
      threadTs: json.ts,
      initialComment: 'Final checkout review — react :white_check_mark: / :x: on the message above to approve or reject.',
    });
    if (up.ok) {
      screenshotPermalink = up.permalink;
      logger.info({ orderId, fileId: up.fileId }, 'checkout screenshot posted to Slack thread');
    } else {
      logger.warn({ orderId, error: up.error }, 'screenshot upload failed — approval message sent without image');
      // Tell reviewers explicitly so a missing image isn't mistaken for a bug.
      await postFollowUp({
        channel: json.channel,
        ts: json.ts,
        text: `:warning: Could not attach the checkout screenshot (${up.error}). Approve/reject based on the order details above.`,
      }).catch(() => {});
    }
  }

  // Seed the message with bot reactions so reviewers can one-click the emoji
  // they want instead of typing the picker. The poll filter ignores reactions
  // added by the bot itself (botUserId match), so seeding doesn't trigger a
  // false approval. Non-fatal: if seeding fails, reviewers can still react
  // manually.
  const approveEmoji = (process.env.SLACK_APPROVE_EMOJI || 'white_check_mark').replace(/^:|:$/g, '');
  const rejectEmoji = (process.env.SLACK_REJECT_EMOJI || 'x').replace(/^:|:$/g, '');
  for (const name of [approveEmoji, rejectEmoji]) {
    try {
      await fetch(`${SLACK_API}/reactions.add`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token()}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ channel: json.channel, timestamp: json.ts, name }),
      });
    } catch (e) {
      logger.warn({ name, err: e.message }, 'reaction seed failed (non-fatal)');
    }
  }

  return { ok: true, channel: json.channel, ts: json.ts, screenshotPermalink };
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
    logger.warn({ err: err.message }, 'postFollowUp threw');
    return { ok: false, error: err.message };
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
    logger.warn({ err: err.message }, 'slack alert threw (non-fatal)');
    return { ok: false, error: err.message };
  }
}

module.exports = { sendCheckoutApproval, uploadScreenshot, waitForReactionApproval, postFollowUp, sendAlert };
