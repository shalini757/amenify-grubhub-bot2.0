// Shared in-memory registry that bridges the Slack button click (handled in
// server.js's /slack/interactive route) and the order process that's blocked
// waiting for a decision (waitForButtonApproval in slackApproval.js).
//
// This works WITHOUT any database/IPC because server.js and processOneOrder
// run in the SAME Node process — the drain loop calls processOneOrder
// directly. So a module-level Map is visible to both halves.
//
// Keyed by `${channel}:${messageTs}` — the channel + ts of the approval
// message, which both halves can derive (the waiter from chat.postMessage's
// response, the click handler from the interactive payload's container).

import { logger } from '../logger';

interface Decision {
  ok: boolean;
  decision: 'approve' | 'reject' | 'timeout' | 'aborted';
  userId?: string;
  userName?: string;
  addedAt?: number;
}

interface PendingEntry {
  decision: Decision | null;
  waiters: Array<(decision: Decision) => void>;
  createdAt: number;
}

interface WaitForOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

const pending = new Map<string, PendingEntry>(); // key -> { decision, waiters: [fn], createdAt }

function makeKey(channel: string, ts: string): string {
  return `${channel}:${ts}`;
}

// Mark a message as awaiting a decision. Idempotent.
function register(channel: string, ts: string): string {
  const key = makeKey(channel, ts);
  if (!pending.has(key)) {
    pending.set(key, { decision: null, waiters: [], createdAt: Date.now() });
  }
  return key;
}

// Called by the interactive route when a reviewer clicks a button. Resolves
// any blocked waiter. Returns true if a pending entry existed and was newly
// decided, false otherwise (unknown message, or already decided).
function resolve(channel: string, ts: string, decision: Decision): boolean {
  const key = makeKey(channel, ts);
  const entry = pending.get(key);
  if (!entry) {
    logger.warn({ key, decision: decision && decision.decision }, 'approvalStore.resolve: no pending entry (dry-run preview or expired)');
    return false;
  }
  if (entry.decision) {
    logger.info({ key }, 'approvalStore.resolve: already decided — ignoring duplicate click');
    return false;
  }
  entry.decision = decision;
  for (const w of entry.waiters) {
    try { w(decision); } catch (_) { /* ignore */ }
  }
  entry.waiters = [];
  return true;
}

// Block until the message is decided, the timeout elapses, or the signal
// aborts. Returns one of:
//   { ok: true, decision: 'approve'|'reject', userId, userName, addedAt }
//   { ok: false, decision: 'timeout' }
//   { ok: false, decision: 'aborted' }
function waitFor(channel: string, ts: string, { timeoutMs = 15 * 60 * 1000, signal }: WaitForOptions = {}): Promise<Decision> {
  const key = makeKey(channel, ts);
  register(channel, ts);
  const entry = pending.get(key);
  if (!entry) return Promise.resolve({ ok: false, decision: 'aborted' });

  // Already decided before we started waiting.
  if (entry.decision) return Promise.resolve(entry.decision);

  return new Promise<Decision>((resolvePromise) => {
    let settled = false;
    const done = (result: Decision) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(abortTimer);
      pending.delete(key); // decision consumed — free the slot
      resolvePromise(result);
    };

    entry.waiters.push((decision) => done(decision));

    const timer = setTimeout(() => done({ ok: false, decision: 'timeout' }), timeoutMs);

    // Poll the abort signal in slices so Ctrl+C / shutdown interrupts promptly.
    const abortTimer = setInterval(() => {
      if (signal && signal.aborted) done({ ok: false, decision: 'aborted' });
    }, 1000);
  });
}

export { register, resolve, waitFor, makeKey };
