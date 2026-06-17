import fs from 'fs';
import path from 'path';
import { logger } from '../logger';

interface Account {
  id: string;
  label?: string;
  [key: string]: any;
}

let _accounts: Account[] | undefined;

function loadAccounts(): Account[] {
  if (_accounts) return _accounts;
  const raw = process.env.GRUBHUB_ACCOUNTS_JSON;
  if (!raw) throw new Error('GRUBHUB_ACCOUNTS_JSON env var is required');

  const trimmed = raw.trim();
  let json: string;
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    json = trimmed;
  } else {
    const abs = path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
    if (!fs.existsSync(abs)) {
      throw new Error(`GRUBHUB_ACCOUNTS_JSON file not found: ${abs}`);
    }
    json = fs.readFileSync(abs, 'utf8');
  }

  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`GRUBHUB_ACCOUNTS_JSON is not valid JSON: ${(err as Error).message}`);
  }

  const list: unknown = Array.isArray(parsed) ? parsed : parsed.accounts;
  if (!Array.isArray(list) || !list.length) {
    throw new Error('GRUBHUB_ACCOUNTS_JSON must be a non-empty array of accounts');
  }
  for (const acct of list) {
    if (!acct.id) throw new Error('every account requires an "id" field');
  }
  _accounts = list as Account[];
  logger.info({ count: list.length }, 'accounts loaded');
  return _accounts;
}

function listAccounts(): Array<{ id: string; label: string }> {
  return loadAccounts().map((a) => ({ id: a.id, label: a.label || a.id }));
}

function pickAccount(hint?: string): Account {
  const accounts = loadAccounts();
  if (!hint || hint === 'auto') return accounts[0];
  const match = accounts.find((a) => a.id === hint || a.label === hint);
  if (!match) throw new Error(`No account found for hint "${hint}"`);
  return match;
}

export { loadAccounts, listAccounts, pickAccount };
