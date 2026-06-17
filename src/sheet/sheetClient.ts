import fs from 'fs';
import path from 'path';
import { google, sheets_v4 } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { logger } from '../logger';

// A row returned by getQueuedOrders: the per-row metadata plus every sheet
// column read into the object. The sheet columns are always strings (empty
// string when blank); _rowNumber is a number. The index signature covers any
// other header columns present in the sheet.
export type OrderRow = {
  _rowNumber: number;
  id: string;
  script: string;
  state: string;
  notes: string;
  bot_status: string;
  first_name: string;
  last_name: string;
  cell_phone: string;
  address: string;
  unit: string;
  extended_provider_mealme_order_product_list: string;
  extended_provider_mealme_order_store: string;
  email: string;
  [key: string]: string | number | undefined;
};

// Real sheet schema — 20 columns, in order.
const COLUMNS: string[] = [
  'script',                                       // A — workflow owner ("in progress by ...")
  'id',                                           // B — order ID
  'since',                                        // C — created timestamp
  'sale_price',                                   // D — total cost / cap
  'state',                                        // E — workflow state ("Completed" / blank / etc.)
  'notes',                                        // F — order details + appended confirmation
  'state_internal_notes',                         // G
  'total_discounts',                              // H
  'refund_amount',                                // I
  'refund_comment',                               // J
  'refund_type',                                  // K
  'extended_provider_mealme_order_product_list',  // L — items text
  'extended_provider_mealme_order_store',         // M — store name
  'email',                                        // N — customer email
  'first_name',                                   // O
  'last_name',                                    // P
  'timezone',                                     // Q
  'cell_phone',                                   // R
  'address',                                      // S
  'unit',                                         // T
  'bot_status',                                   // U — bot-only: short status (Completed/Failed/Needs review/Locked)
  'bot_notes',                                    // V — bot-only: human-readable confirmation/review/error
  'bot_internal',                                 // W — bot-only: internal log (locks, nonces, timestamps)
];

// Bot-owned columns: auto-created in the header if absent, so they are
// excluded from the "required pre-existing column" check.
const BOT_COLUMNS: string[] = ['bot_status', 'bot_notes', 'bot_internal'];
const REQUIRED_COLUMNS: string[] = COLUMNS.filter((c) => !BOT_COLUMNS.includes(c));

const BOT_OWNER: string = process.env.BOT_OWNER_LABEL || 'in progress by Bot';
const COMPLETED_STATE: string = process.env.COMPLETED_STATE || 'Completed';
const READY_STATES: string[] = (process.env.READY_STATES || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const GRUBHUB_URL_RE = /grubhub\.com\/restaurant\//i;

function colLetter(idx: number): string {
  let n = idx + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function buildAuth(): GoogleAuth {
  const credsPath = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!credsPath) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is required');
  const absolute = path.isAbsolute(credsPath) ? credsPath : path.resolve(process.cwd(), credsPath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Service account file not found: ${absolute}`);
  }
  return new GoogleAuth({
    keyFile: absolute,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

let _sheets: sheets_v4.Sheets | undefined;
function sheets(): sheets_v4.Sheets {
  if (!_sheets) {
    const auth = buildAuth();
    _sheets = google.sheets({ version: 'v4', auth });
  }
  return _sheets;
}

function spreadsheetId(): string {
  const id = process.env.GOOGLE_SHEET_ID;
  if (!id) throw new Error('GOOGLE_SHEET_ID env var is required');
  return id;
}

function tabName(): string {
  return process.env.SHEET_TAB_NAME || 'Orders';
}

function headerRange(): string {
  const tab = tabName();
  const last = colLetter(COLUMNS.length - 1);
  return `${tab}!A1:${last}1`;
}

function dataRange(): string {
  const tab = tabName();
  const last = colLetter(COLUMNS.length - 1);
  return `${tab}!A2:${last}`;
}

async function readHeader(): Promise<string[]> {
  const res = await sheets().spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: headerRange(),
  });
  const row = res.data.values?.[0] ?? [];
  return row.map((h) => String(h ?? '').trim());
}

function rowsToObjects(
  header: string[],
  rows: unknown[][],
  startRowNumber: number,
): OrderRow[] {
  return rows.map((r, i) => {
    const obj = { _rowNumber: startRowNumber + i } as OrderRow;
    header.forEach((h, idx) => {
      const cell = r[idx];
      obj[h] = cell != null ? String(cell) : '';
    });
    return obj;
  });
}

async function verifyConnection(): Promise<{ title: string; tab: string; header: string[] }> {
  const id = spreadsheetId();
  const meta = await sheets().spreadsheets.get({ spreadsheetId: id });
  const tab = tabName();
  const sheet = (meta.data.sheets ?? []).find(
    (s) => s.properties?.title === tab,
  );
  if (!sheet) throw new Error(`Tab "${tab}" not found in spreadsheet ${id}`);
  let header = await readHeader();
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) {
    throw new Error(`Sheet header missing required columns: ${missing.join(', ')}`);
  }
  // Auto-create bot-owned columns in the header if they don't exist yet.
  const newHeaders = BOT_COLUMNS.filter((c) => !header.includes(c));
  if (newHeaders.length) {
    let next = header.length;
    for (const c of newHeaders) {
      const cell = `${tab}!${colLetter(next)}1`;
      await sheets().spreadsheets.values.update({
        spreadsheetId: id,
        range: cell,
        valueInputOption: 'RAW',
        requestBody: { values: [[c]] },
      });
      next += 1;
    }
    logger.info({ added: newHeaders }, 'bot columns added to sheet header');
    header = await readHeader();
  }
  const title = meta.data.properties?.title ?? '';
  logger.info(
    { sheetId: id, tab, title, columns: header.length },
    'sheet verified',
  );
  return { title, tab, header };
}

function isReadyState(state: string | undefined): boolean {
  const s = (state ?? '').trim().toLowerCase();
  if (READY_STATES.length === 0) return s === '';
  return READY_STATES.includes(s);
}

async function getQueuedOrders(): Promise<OrderRow[]> {
  const header = await readHeader();
  const res = await sheets().spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: dataRange(),
  });
  const rows = res.data.values ?? [];
  const objects = rowsToObjects(header, rows, 2);
  return objects.filter((r) => {
    if (!r.id) return false;
    // Read-only guards on shared columns (the bot never writes these):
    if ((r.script ?? '').trim() !== '') return false;   // claimed by a human
    if (!isReadyState(r.state)) return false;            // human "ready" signal
    if (!GRUBHUB_URL_RE.test(r.notes ?? '')) return false;
    // Bot-owned claim: a non-empty bot_status means the bot already locked,
    // completed, failed, or flagged this row — skip it.
    if ((r.bot_status ?? '').trim() !== '') return false;
    return true;
  });
}

async function readCell(rowNumber: number, columnName: string): Promise<string> {
  const header = await readHeader();
  const idx = header.indexOf(columnName);
  if (idx === -1) return '';
  const cell = `${tabName()}!${colLetter(idx)}${rowNumber}`;
  const res = await sheets().spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: cell,
  });
  const val = res.data.values?.[0]?.[0];
  return val != null ? String(val) : '';
}

async function updateRow(
  rowNumber: number,
  patch: Record<string, unknown>,
): Promise<void> {
  const header = await readHeader();
  const updates: sheets_v4.Schema$ValueRange[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const idx = header.indexOf(key);
    if (idx === -1) continue;
    const cell = `${tabName()}!${colLetter(idx)}${rowNumber}`;
    updates.push({ range: cell, values: [[value == null ? '' : String(value)]] });
  }
  if (!updates.length) return;
  await sheets().spreadsheets.values.batchUpdate({
    spreadsheetId: spreadsheetId(),
    requestBody: { valueInputOption: 'USER_ENTERED', data: updates },
  });
}

// Sheets API has no compare-and-swap, so two bot processes both seeing an
// empty cell and both writing will both think they hold the lock. We
// reduce (not eliminate) that window by writing a per-run nonce and
// re-reading the cell after a brief delay; if a second writer landed in
// between, last-writer-wins and we abort. For single-process operation
// this is exact; for multi-process it is best-effort.
async function lockRow(rowNumber: number, orderId: string): Promise<string> {
  const header = await readHeader();
  const statusIdx = header.indexOf('bot_status');
  if (statusIdx === -1) throw new Error('bot_status column not found in sheet header');
  const cell = `${tabName()}!${colLetter(statusIdx)}${rowNumber}`;
  const cur = await sheets().spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: cell,
  });
  const val = String(cur.data.values?.[0]?.[0] ?? '').trim();
  if (val !== '') {
    throw new Error(`Row ${rowNumber} already claimed by "${val}"`);
  }
  const nonce = `Locked ${BOT_OWNER} [${process.pid}/${Date.now()}]`;
  await updateRow(rowNumber, { bot_status: nonce });
  await new Promise<void>((r) => setTimeout(r, 1500));
  const after = await sheets().spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: cell,
  });
  const finalVal = String(after.data.values?.[0]?.[0] ?? '').trim();
  if (finalVal !== nonce) {
    throw new Error(`Row ${rowNumber} lock lost: another writer claimed it as "${finalVal}"`);
  }
  await appendInternalNote(rowNumber, `LOCK ${nonce} order_id=${orderId}`).catch(() => {});
  logger.info({ rowNumber, orderId, owner: nonce }, 'row locked');
  return nonce;
}

// Append a timestamped line to a bot-owned column, capping total length so it
// can't grow without bound (keeps the most recent entries).
async function appendBotColumn(
  rowNumber: number,
  column: string,
  note: string,
  cap = 3000,
): Promise<void> {
  const header = await readHeader();
  if (!header.includes(column)) return;
  const existing = await readCell(rowNumber, column);
  const stamp = new Date().toISOString();
  const line = `${stamp} ${note}`;
  const joined = (existing ? `${existing}\n${line}` : line).slice(-cap);
  await updateRow(rowNumber, { [column]: joined });
}

// Internal bot log → bot_internal (column W). Kept out of the shared
// state_internal_notes column so the team's notes stay clean.
async function appendInternalNote(rowNumber: number, note: string): Promise<void> {
  return appendBotColumn(rowNumber, 'bot_internal', note);
}

// Human-readable bot note → bot_notes (column V).
async function appendBotNote(rowNumber: number, note: string): Promise<void> {
  return appendBotColumn(rowNumber, 'bot_notes', note);
}

// Short status → bot_status (column U). Overwrites (not appended) so the
// column always shows the latest state at a glance.
async function setBotStatus(rowNumber: number, status: string): Promise<void> {
  const header = await readHeader();
  if (!header.includes('bot_status')) return;
  await updateRow(rowNumber, { bot_status: status });
}

type AlertField = { label: string; value: string | number };
type Alert = {
  emoji?: string;
  title?: string;
  text?: string;
  fields?: AlertField[];
};

// Fire a Slack alert without ever letting a Slack failure break the sheet
// write. Lazy-require keeps the sheet module decoupled from Slack. `id` and
// store name are read from the row so the alert has context.
async function notifyAlert(rowNumber: number, alert: Alert): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { sendAlert } = require('../review/slackApproval');
    const orderId = await readCell(rowNumber, 'id').catch(() => '');
    const store = await readCell(rowNumber, 'extended_provider_mealme_order_store').catch(() => '');
    const baseFields: AlertField[] = [
      { label: 'Order ID', value: orderId },
      { label: 'Restaurant', value: store },
      { label: 'Sheet Row', value: rowNumber },
    ];
    await sendAlert({ ...alert, fields: [...baseFields, ...(alert.fields ?? [])] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ rowNumber, err: message }, 'notifyAlert failed (non-fatal)');
  }
}

type WriteSuccessArgs = {
  grubhubOrderId?: string;
  actualTotal?: number | string | null;
  eta?: string;
  orderUrl?: string;
};

async function writeSuccess(
  rowNumber: number,
  { grubhubOrderId, actualTotal, eta, orderUrl }: WriteSuccessArgs = {},
): Promise<void> {
  const confirmation =
    `Confirmation` +
    (orderUrl ? `\n${orderUrl}` : '') +
    (eta ? `\nEstimated time: ${eta}` : '') +
    (grubhubOrderId ? `\nOrder #${grubhubOrderId}` : '') +
    (actualTotal != null ? `\nOrder total: $${actualTotal}` : '');
  await setBotStatus(rowNumber, 'Completed');
  await appendBotNote(rowNumber, confirmation);
  await appendInternalNote(rowNumber, `SUCCESS order_id=${grubhubOrderId || '?'} total=${actualTotal ?? '?'}`).catch(() => {});
  await notifyAlert(rowNumber, {
    emoji: ':white_check_mark:',
    title: 'Order placed',
    fields: [
      { label: 'Total', value: actualTotal != null ? `$${actualTotal}` : '' },
      { label: 'ETA', value: eta || '' },
      { label: 'Grubhub Order #', value: grubhubOrderId || '' },
    ],
    text: orderUrl ? `<${orderUrl}|Order tracking>` : '',
  });
  logger.info({ rowNumber, grubhubOrderId }, 'row marked completed');
}

async function unlockRow(
  rowNumber: number,
  dryRunNote?: string,
  nextState?: string,
): Promise<void> {
  if (dryRunNote) {
    // Dry-run finished: leave a terminal bot_status so the row isn't re-picked.
    await setBotStatus(rowNumber, 'Dry-run OK');
    await appendBotNote(rowNumber, `Dry-run: ${String(dryRunNote).slice(0, 500)}`);
  } else {
    // Plain release: clear the bot claim so the row becomes available again.
    await setBotStatus(rowNumber, '');
  }
  await appendInternalNote(
    rowNumber,
    `UNLOCK ${dryRunNote ? 'dry-run-ok' : 'ok'}${nextState ? ` (nextState ignored: ${nextState})` : ''}`,
  ).catch(() => {});
  logger.info({ rowNumber, nextState }, 'row unlocked');
}

async function writeFailure(rowNumber: number, errorMessage: string): Promise<void> {
  // bot_status='Failed' is non-empty, so getQueuedOrders skips the row and we
  // don't re-pick it next loop. Clear column U (bot_status) to retry.
  await setBotStatus(rowNumber, 'Failed');
  await appendBotNote(rowNumber, `Error: ${(errorMessage || '').slice(0, 500)}`);
  await appendInternalNote(rowNumber, `FAILURE ${String(errorMessage || '').slice(0, 200)}`).catch(() => {});
  await notifyAlert(rowNumber, {
    emoji: ':rotating_light:',
    title: 'Order failed',
    text: (errorMessage || '').slice(0, 500),
  });
  logger.warn({ rowNumber }, 'row marked failure');
}

type AppendOrderArgs = { id?: string; salePrice?: number | string; notes?: string };

async function appendOrder(
  { id, salePrice, notes }: AppendOrderArgs,
): Promise<{ rowNumber: number | null; updatedRange: string | null | undefined }> {
  const header = await readHeader();
  const row: string[] = new Array(header.length).fill('');
  const set = (col: string, val: unknown): void => {
    const idx = header.indexOf(col);
    if (idx !== -1) row[idx] = val == null ? '' : String(val);
  };
  set('id', id);
  set('since', new Date().toISOString());
  set('sale_price', salePrice);
  set('notes', notes);
  const last = colLetter(header.length - 1);
  const res = await sheets().spreadsheets.values.append({
    spreadsheetId: spreadsheetId(),
    range: `${tabName()}!A2:${last}`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
  const updatedRange = res.data.updates?.updatedRange;
  const m = updatedRange ? updatedRange.match(/!.*?(\d+):/) : null;
  const rowNumber = m ? parseInt(m[1], 10) : null;
  logger.info({ id, rowNumber, updatedRange }, 'test order appended');
  return { rowNumber, updatedRange };
}

async function writeReview(rowNumber: number, reason: string): Promise<void> {
  await setBotStatus(rowNumber, 'Needs review');
  await appendBotNote(rowNumber, `Needs human review: ${(reason || '').slice(0, 500)}`);
  await appendInternalNote(rowNumber, `REVIEW ${String(reason || '').slice(0, 200)}`).catch(() => {});
  await notifyAlert(rowNumber, {
    emoji: ':warning:',
    title: 'Needs human review',
    text: (reason || '').slice(0, 500),
  });
  logger.warn({ rowNumber }, 'row marked review');
}

export {
  COLUMNS,
  BOT_OWNER,
  COMPLETED_STATE,
  verifyConnection,
  getQueuedOrders,
  appendOrder,
  lockRow,
  unlockRow,
  writeSuccess,
  writeFailure,
  writeReview,
  appendInternalNote,
  appendBotNote,
  setBotStatus,
};
