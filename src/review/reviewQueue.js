'use strict';

const { logger } = require('../logger');

const PII_FIELDS = new Set([
  'customer_name',
  'customer_phone',
  'delivery_address',
  'delivery_instructions',
]);

function scrubPii(order) {
  if (!order || typeof order !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(order)) {
    if (PII_FIELDS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function buildPayload({ severity = 'warn', title, reason, order, extra }) {
  const scrubbed = scrubPii(order || {});
  const fields = [
    { type: 'mrkdwn', text: `*Order ID:* ${scrubbed.order_id || 'n/a'}` },
    { type: 'mrkdwn', text: `*Account:* ${scrubbed.account || 'n/a'}` },
    { type: 'mrkdwn', text: `*Restaurant:* ${scrubbed.restaurant_name || 'n/a'}` },
    { type: 'mrkdwn', text: `*Max Total:* ${scrubbed.max_total || 'n/a'}` },
  ];
  return {
    text: `[${severity.toUpperCase()}] ${title}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: title.slice(0, 150) } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Reason:* ${reason || 'n/a'}` } },
      { type: 'section', fields },
      ...(extra
        ? [{ type: 'section', text: { type: 'mrkdwn', text: `\`\`\`${JSON.stringify(extra).slice(0, 2500)}\`\`\`` } }]
        : []),
    ],
  };
}

async function sendReviewAlert({ severity = 'warn', title, reason, order, extra } = {}) {
  if ((process.env.SLACK_ALERTS || '').toLowerCase() === 'off') {
    logger.info({ title }, 'SLACK_ALERTS=off — skipping review alert');
    return { sent: false, reason: 'disabled' };
  }
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    logger.warn({ title }, 'SLACK_WEBHOOK_URL not set — skipping review alert');
    return { sent: false, reason: 'no_webhook' };
  }
  const payload = buildPayload({ severity, title, reason, order, extra });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn({ status: res.status, body }, 'slack webhook returned non-2xx');
      return { sent: false, status: res.status };
    }
    logger.info({ title }, 'review alert sent');
    return { sent: true };
  } catch (err) {
    logger.warn({ err: err.message }, 'slack webhook send failed — continuing');
    return { sent: false, error: err.message };
  }
}

module.exports = { sendReviewAlert, scrubPii };
