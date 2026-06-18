'use strict';

const pino = require('pino');
const path = require('path');

const isDev = (process.env.NODE_ENV || 'development') !== 'production';

// PII fields that may flow through logs. Keep the real Amenify sheet column
// names AND legacy field names so logs are safe even if a code path still
// emits old shapes.
const PII_KEYS = new Set([
  'email',
  'first_name',
  'last_name',
  'cell_phone',
  'phone',
  'address',
  'unit',
  'customer_name',
  'customer_phone',
  'delivery_address',
  'delivery_instructions',
]);

const REDACT_FIELDS = [
  'email',
  'first_name',
  'last_name',
  'cell_phone',
  'phone',
  'address',
  'unit',
  'customer_name',
  'customer_phone',
  'delivery_address',
  'delivery_instructions',
];

const baseOptions = {
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: REDACT_FIELDS.flatMap((f) => [f, `*.${f}`, `order.${f}`]),
    censor: '[REDACTED]',
  },
};

// Synchronous JSON log file (logs/bot.log) so a full run can be inspected after
// the fact and nothing is lost on an abrupt exit. In dev also pretty-print to
// the console. Sync file destination (not an async worker transport) keeps the
// last-written line accurate at the exact point of any hang/crash.
const logLevel = process.env.LOG_LEVEL || 'info';
const streams = [
  { level: logLevel, stream: pino.destination({ dest: path.resolve(process.cwd(), 'logs', 'bot.log'), mkdir: true, sync: true }) },
];
if (isDev) {
  // eslint-disable-next-line global-require
  const pretty = require('pino-pretty');
  streams.push({ level: logLevel, stream: pretty({ colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' }) });
}

const logger = pino(baseOptions, pino.multistream(streams));

function stripPii(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(stripPii);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (PII_KEYS.has(k)) {
      out[k] = '[REDACTED]';
    } else if (v && typeof v === 'object') {
      out[k] = stripPii(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

module.exports = { logger, stripPii };
