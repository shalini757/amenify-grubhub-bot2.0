'use strict';

// Round-robin assignment of Grubhub email accounts for the external API path.
// Accounts come from the existing GRUBHUB_ACCOUNTS_JSON (accountPicker). Each
// order claims one account via a Redis busy-lock; when all accounts are locked
// the caller gets null → the API returns "busy".

const { loadAccounts } = require('./accountPicker');
const redisState = require('../state/redisState');
const { logger } = require('../logger');

// Claim a free account, rotating the starting point so load spreads across the
// pool. Returns the account object, or null if every account is busy.
async function acquireEmail(appointmentId) {
  const accounts = loadAccounts();
  const n = accounts.length;
  if (!n) return null;
  const start = (await redisState.nextRoundRobin()) % n;
  for (let i = 0; i < n; i++) {
    const acct = accounts[(start + i) % n];
    // eslint-disable-next-line no-await-in-loop
    const claimed = await redisState.acquireEmailLock(acct.id, appointmentId);
    if (claimed) {
      logger.info({ accountId: acct.id, appointmentId }, 'email account claimed for order');
      return acct;
    }
  }
  logger.warn({ appointmentId, poolSize: n }, 'all email accounts busy');
  return null;
}

async function releaseEmail(accountId) {
  await redisState.releaseEmailLock(accountId);
  logger.info({ accountId }, 'email account released');
}

module.exports = { acquireEmail, releaseEmail };
