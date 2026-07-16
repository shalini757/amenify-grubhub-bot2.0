'use strict';

// Redis-backed state for the external ordering API.
//
//   gh_ordering_<appointment_id>  = working | completed | error   (the state
//     Amenify polls). Claimed atomically with SET NX so two concurrent POSTs for
//     the same appointment can't both start a run. Terminal states carry a TTL so
//     they eventually expire and a later re-order is allowed.
//   gh_email_lock:<accountId>     = <appointment_id>  (per-email busy lock AND
//     round-robin claim; SET NX EX so a crashed worker auto-frees the email).
//   gh_rr_index                   = INCR counter used to rotate the round-robin
//     starting offset across the email pool.

const { createClient } = require('redis');
const { logger } = require('../logger');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const STATE_TTL_SEC = parseInt(process.env.STATE_TTL_SEC || '86400', 10); // terminal states: 24h
// Email lock + working-state TTL: derived from the per-order timeout so a dead
// worker's claims self-expire slightly after the order would have timed out.
const ORDER_TIMEOUT_SEC = Math.max(
  60,
  Math.round(parseInt(process.env.ORDER_TIMEOUT_MS || '1200000', 10) / 1000) + 60,
);

const STATES = Object.freeze({ WORKING: 'working', COMPLETED: 'completed', ERROR: 'error', BUSY: 'busy' });

const stateKey = (id) => `gh_ordering_${id}`;
const lockKey = (accountId) => `gh_email_lock:${accountId}`;
const RR_KEY = 'gh_rr_index';

let _clientPromise = null;

function getClient() {
  if (_clientPromise) return _clientPromise;
  const client = createClient({ url: REDIS_URL });
  client.on('error', (err) => logger.warn({ err: err.message }, 'redis client error'));
  _clientPromise = client
    .connect()
    .then(() => {
      logger.info('redis connected');
      return client;
    })
    .catch((err) => {
      _clientPromise = null; // allow a later call to retry the connection
      throw err;
    });
  return _clientPromise;
}

async function getState(appointmentId) {
  const c = await getClient();
  return c.get(stateKey(String(appointmentId))); // null when absent
}

// Atomically claim the order as 'working'. Returns true if WE set it (we own the
// run), false if a state already existed (duplicate — the caller should report
// the existing state). The TTL guards against a crashed worker leaving it stuck.
async function claimWorking(appointmentId) {
  const c = await getClient();
  const res = await c.set(stateKey(String(appointmentId)), STATES.WORKING, { NX: true, EX: ORDER_TIMEOUT_SEC });
  return res === 'OK';
}

async function setCompleted(appointmentId) {
  const c = await getClient();
  await c.set(stateKey(String(appointmentId)), STATES.COMPLETED, { EX: STATE_TTL_SEC });
}

async function setError(appointmentId) {
  const c = await getClient();
  await c.set(stateKey(String(appointmentId)), STATES.ERROR, { EX: STATE_TTL_SEC });
}

// Release a claim (e.g. when no email is free) so a later retry can start.
async function clearState(appointmentId) {
  const c = await getClient();
  await c.del(stateKey(String(appointmentId)));
}

// Claim an email account's busy-lock. Returns true if claimed, false if busy.
async function acquireEmailLock(accountId, appointmentId) {
  const c = await getClient();
  const res = await c.set(lockKey(accountId), String(appointmentId), { NX: true, EX: ORDER_TIMEOUT_SEC });
  return res === 'OK';
}

async function releaseEmailLock(accountId) {
  const c = await getClient();
  await c.del(lockKey(accountId));
}

async function nextRoundRobin() {
  const c = await getClient();
  return c.incr(RR_KEY);
}

async function quit() {
  if (!_clientPromise) return;
  try {
    const c = await _clientPromise;
    await c.quit();
  } catch (_) { /* ignore */ }
  _clientPromise = null;
}

module.exports = {
  STATES,
  getState,
  claimWorking,
  setCompleted,
  setError,
  clearState,
  acquireEmailLock,
  releaseEmailLock,
  nextRoundRobin,
  getClient,
  quit,
};
