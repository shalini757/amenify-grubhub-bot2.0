'use strict';

const http = require('http');
const { logger } = require('./logger');

// Webhook trigger server (self-diagnosing).
//
// A Google Apps Script onChange trigger on the Sheet POSTs to /trigger the
// moment a new row is added, so an order starts processing within a second or
// two instead of waiting for the next poll cycle.
//
// Concurrency: orders MUST run one at a time (they each drive a browser). We
// use a single-flight "drain" loop — a trigger that arrives while a run is in
// progress just sets a `pending` flag, and the loop re-checks the queue when it
// finishes. So bursts of triggers collapse into one drain that empties the
// queue, and a row added mid-run isn't missed.
//
// A fallback poll still runs on POLL_INTERVAL_MS as a safety net in case a
// webhook is dropped (tunnel down, network blip).
//
// SELF-DIAGNOSIS: the #1 failure mode is "Apps Script execution history shows
// success but nothing ran" — because Apps Script uses muteHttpExceptions, a
// refused/401 POST still logs as success on Google's side. To make that
// visible from the bot side we (a) print a loud startup banner, (b) log EVERY
// incoming /trigger request (accepted AND rejected, with reason + source IP),
// and (c) expose a rich GET /health showing trigger counts + timestamps. If
// your sheet fires but health's `lastTriggerAt` never updates, the POST is not
// reaching this process (wrong tunnel URL, serve not running, or wrong secret).

function startServer({ processOneOrder }) {
  const port = parseInt(process.env.TRIGGER_PORT || '8787', 10);
  const secret = process.env.TRIGGER_SECRET || '';
  const pollMs = Math.max(5000, parseInt(process.env.POLL_INTERVAL_MS || '30000', 10));

  // --- diagnostics state ---
  const startedAt = Date.now();
  let triggerCount = 0;       // accepted triggers
  let rejectedCount = 0;      // rejected (bad/missing secret)
  let lastTriggerAt = null;   // last accepted /trigger
  let lastTriggerSource = null;
  let lastRejectAt = null;
  let lastRejectReason = null;
  let lastDrainStartedAt = null;
  let lastDrainFinishedAt = null;
  let lastDrainSummary = null;
  let lastErrorAt = null;
  let lastError = null;
  let ordersProcessed = 0;

  let running = false;
  let pending = false;

  function banner() {
    const line = '-'.repeat(62);
    const secretLine = secret
      ? 'set OK (POSTs must send a matching X-Trigger-Secret)'
      : 'MISSING -- /trigger will REJECT every request. Set TRIGGER_SECRET in .env';
    // eslint-disable-next-line no-console
    console.log(
      '\n+' + line + '+\n' +
      '  GRUBHUB BOT 2.0  -  trigger server\n' +
      '  Listening:     http://localhost:' + port + '\n' +
      '  Endpoints:     POST /trigger    GET /health\n' +
      '  Secret:        ' + secretLine + '\n' +
      '  Fallback poll: every ' + Math.round(pollMs / 1000) + 's\n' +
      '  Run order:\n' +
      '    1. npm run chrome          (sign in, leave Chrome open)\n' +
      '    2. ngrok http ' + port + '       (copy the https URL)\n' +
      '    3. Apps Script WEBHOOK_URL = <tunnel>/trigger\n' +
      '    4. curl <tunnel>/health    (should return this server)\n' +
      '  If the sheet fires but health.lastTriggerAt never changes,\n' +
      '  the POST is NOT reaching this process (wrong URL / not running / bad secret).\n' +
      '+' + line + '+\n',
    );
  }

  // Process every ready row until the queue is empty, then stop. Re-entrant
  // calls are coalesced via the `pending` flag (single-flight).
  async function drain(source) {
    if (running) {
      pending = true;
      logger.info({ source }, 'drain already running -- coalesced (pending=true)');
      return;
    }
    running = true;
    lastDrainStartedAt = Date.now();
    logger.info({ source }, 'drain started');
    let processedThisDrain = 0;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const code = await processOneOrder().catch((err) => {
          lastErrorAt = Date.now();
          lastError = err.message;
          logger.error({ err: err.message, stack: err.stack }, 'processOneOrder threw in drain');
          return 1;
        });
        if (code === 2) break; // empty queue — done draining
        processedThisDrain += 1;
        ordersProcessed += 1;
        if (code === 3) {
          logger.warn('SESSION_EXPIRED — pausing 60s for human to sign in');
          await new Promise((r) => setTimeout(r, 60000));
        } else {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    } finally {
      running = false;
      lastDrainFinishedAt = Date.now();
      lastDrainSummary = `source=${source} processed=${processedThisDrain}`;
      logger.info({ source, processed: processedThisDrain }, 'drain finished (queue empty)');
      if (pending) {
        pending = false;
        setImmediate(() => drain('pending'));
      }
    }
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => {
        data += c;
        if (data.length > 1e6) req.destroy(); // guard against oversized bodies
      });
      req.on('end', () => resolve(data));
      req.on('error', () => resolve(''));
    });
  }

  function healthPayload() {
    const agoSec = (t) => (t ? Math.round((Date.now() - t) / 1000) : null);
    return {
      ok: true,
      service: 'grubhub-bot-2.0 trigger server',
      port,
      secretConfigured: !!secret,
      running,
      pending,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      triggers: {
        accepted: triggerCount,
        rejected: rejectedCount,
        lastTriggerAt: lastTriggerAt ? new Date(lastTriggerAt).toISOString() : null,
        lastTriggerAgoSec: agoSec(lastTriggerAt),
        lastTriggerSource,
        lastRejectAt: lastRejectAt ? new Date(lastRejectAt).toISOString() : null,
        lastRejectReason,
      },
      drain: {
        ordersProcessed,
        lastDrainStartedAt: lastDrainStartedAt ? new Date(lastDrainStartedAt).toISOString() : null,
        lastDrainFinishedAt: lastDrainFinishedAt ? new Date(lastDrainFinishedAt).toISOString() : null,
        lastDrainSummary,
      },
      lastError: lastError
        ? { at: new Date(lastErrorAt).toISOString(), message: lastError }
        : null,
    };
  }

  const server = http.createServer(async (req, res) => {
    const ip = req.socket.remoteAddress;

    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(healthPayload(), null, 2));
      return;
    }

    if (req.method === 'POST' && req.url.startsWith('/trigger')) {
      // Accept the secret via header (X-Trigger-Secret) or ?secret= query.
      const headerSecret = req.headers['x-trigger-secret'] || '';
      const urlSecret = (req.url.split('?secret=')[1] || '').split('&')[0];
      const provided = headerSecret || decodeURIComponent(urlSecret);
      if (!secret || provided !== secret) {
        rejectedCount += 1;
        lastRejectAt = Date.now();
        lastRejectReason = !secret ? 'server has no TRIGGER_SECRET set' : 'provided secret did not match';
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unauthorized', reason: lastRejectReason }));
        logger.warn({ ip, reason: lastRejectReason, gotSecret: provided ? 'yes(wrong)' : 'none' }, 'REJECTED /trigger');
        return;
      }
      const body = await readBody(req);
      triggerCount += 1;
      lastTriggerAt = Date.now();
      lastTriggerSource = 'webhook';
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, accepted: true, running, triggerCount }));
      logger.info({ ip, triggerCount, running, body: body.slice(0, 200) }, 'ACCEPTED /trigger -- starting drain');
      drain('webhook'); // fire-and-forget; response already sent
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found', tip: 'POST /trigger or GET /health' }));
  });

  server.listen(port, () => {
    banner();
    logger.info({ port, pollMs, secretConfigured: !!secret }, 'trigger server listening (POST /trigger, GET /health)');
  });

  // Safety-net poll: catch rows that a missed webhook would have left behind.
  setInterval(() => drain('poll'), pollMs);
  // Drain once on startup so anything already queued runs immediately.
  drain('startup');

  return server;
}

module.exports = { startServer };
