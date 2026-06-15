'use strict';

const fs = require('fs');
const path = require('path');
const { logger } = require('../logger');

let _accounts;

function loadAccounts() {
  if (_accounts) return _accounts;
  const raw = process.env.GRUBHUB_ACCOUNTS_JSON;
  if (!raw) throw new Error('GRUBHUB_ACCOUNTS_JSON env var is required');

  const trimmed = raw.trim();
  let json;
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    json = trimmed;
  } else {
    const abs = path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
    if (!fs.existsSync(abs)) {
      throw new Error(`GRUBHUB_ACCOUNTS_JSON file not found: ${abs}`);
    }
    json = fs.readFileSync(abs, 'utf8');
  }

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`GRUBHUB_ACCOUNTS_JSON is not valid JSON: ${err.message}`);
  }

  const list = Array.isArray(parsed) ? parsed : parsed.accounts;
  if (!Array.isArray(list) || !list.length) {
    throw new Error('GRUBHUB_ACCOUNTS_JSON must be a non-empty array of accounts');
  }
  for (const acct of list) {
    if (!acct.id) throw new Error('every account requires an "id" field');
  }
  _accounts = list;
  logger.info({ count: list.length }, 'accounts loaded');
  return _accounts;
}

function listAccounts() {
  return loadAccounts().map((a) => ({ id: a.id, label: a.label || a.id }));
}

function pickAccount(hint) {
  const accounts = loadAccounts();
  if (!hint || hint === 'auto') return accounts[0];
  const match = accounts.find((a) => a.id === hint || a.label === hint);
  if (!match) throw new Error(`No account found for hint "${hint}"`);
  return match;
}

module.exports = { loadAccounts, listAccounts, pickAccount };
