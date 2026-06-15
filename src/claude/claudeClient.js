'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { logger } = require('../logger');

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const HEALTH_MODEL = process.env.CLAUDE_HEALTH_MODEL || 'claude-haiku-4-5-20251001';

class ClaudeInvalidJsonError extends Error {
  constructor(message, raw) {
    super(message);
    this.code = 'CLAUDE_INVALID_JSON';
    this.raw = raw;
  }
}

let _client;
function client() {
  if (!_client) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error('ANTHROPIC_API_KEY env var is required (set it in .env)');
    }
    _client = new Anthropic({ apiKey: key });
  }
  return _client;
}

function logUsage(label, response) {
  const usage = response && response.usage ? response.usage : {};
  logger.info(
    {
      label,
      model: response && response.model,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
    },
    'claude usage',
  );
}

function extractText(response) {
  if (!response || !Array.isArray(response.content)) return '';
  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function parseJsonStrict(text, label) {
  if (!text) throw new ClaudeInvalidJsonError(`${label}: empty response`, text);
  let candidate = text.trim();
  if (candidate.startsWith('```')) {
    candidate = candidate.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }
  const first = candidate.indexOf('{');
  const firstArr = candidate.indexOf('[');
  let start = -1;
  if (first === -1) start = firstArr;
  else if (firstArr === -1) start = first;
  else start = Math.min(first, firstArr);
  if (start > 0) candidate = candidate.slice(start);
  try {
    return JSON.parse(candidate);
  } catch (err) {
    console.log('[claude] bad JSON:', text);
    throw new ClaudeInvalidJsonError(`${label}: invalid JSON — ${err.message}`, text);
  }
}

function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function helloWorld() {
  console.log('[claude] helloWorld');
  const res = await client().messages.create({
    model: HEALTH_MODEL,
    max_tokens: 64,
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
  });
  logUsage('helloWorld', res);
  const text = extractText(res);
  return { ok: /OK/i.test(text), text, model: res.model };
}

async function matchItems({ requestedItems, menu }) {
  console.log('[claude] matchItems', requestedItems);
  if (!Array.isArray(requestedItems) || !requestedItems.length) {
    throw new Error('matchItems: requestedItems must be a non-empty array');
  }
  const system =
    'You match requested food items to a restaurant menu. ' +
    'Return ONLY JSON. No prose, no markdown fences. ' +
    'Output schema: {"matches":[{"requested":string,"matched_id":string|null,' +
    '"matched_name":string|null,"confidence":number,"notes":string}]}. ' +
    'Confidence is 0–1. Use null matched_id when no acceptable match exists.';

  const user =
    `Requested items:\n${JSON.stringify(requestedItems, null, 2)}\n\n` +
    `Menu:\n${JSON.stringify(menu, null, 2)}`;

  const res = await client().messages.create({
    model: MODEL,
    max_tokens: 2048,
    system,
    messages: [{ role: 'user', content: user }],
  });
  logUsage('matchItems', res);
  const text = extractText(res);
  const parsed = parseJsonStrict(text, 'matchItems');
  if (!parsed || !Array.isArray(parsed.matches)) {
    throw new ClaudeInvalidJsonError('matchItems: missing matches[]', text);
  }
  console.log('[claude] matchItems →', parsed.matches);
  return parsed;
}

// Two-pass budget-aware matcher.
//
// Pass 1: ONE batch Claude call. For each requested item, Claude returns a
//         ranked list of menu candidates with their prices. No budget
//         reasoning in the prompt — Claude only does semantic matching.
// Pass 2: Pure function in JS picks the combo that fits maxTotal.
//
// Why two passes:
//   - Claude making budget decisions per-item ignores cross-item tradeoffs
//     and can hallucinate prices. The bot has full menu context and exact
//     arithmetic, so budget is our job, not Claude's.
//   - One batch call instead of N: fewer round-trips, comparable items.
//
// rankCandidates returns:
//   { ranked: [
//       { requested, candidates: [
//           { matched_name, matched_price, confidence, kind: 'exact'|'fuzzy', notes }
//       ]}
//   ]}
// Each candidates list is ordered best→worst: highest-confidence exact first,
// then fuzzy. Up to MAX_CANDIDATES per requested item (default 4).
async function rankCandidates({ requestedItems, menu, maxCandidatesPerItem = 4 }) {
  console.log('[claude] rankCandidates', requestedItems.length, 'items');
  if (!Array.isArray(requestedItems) || !requestedItems.length) {
    throw new Error('rankCandidates: requestedItems must be a non-empty array');
  }

  const system =
    'You match requested food items to a restaurant menu. For each requested item, ' +
    'return a RANKED LIST of menu candidates ordered best to worst. ' +
    'Return ONLY JSON. No prose, no markdown fences. ' +
    'Output schema: ' +
    '{"ranked":[{"requested":string,"candidates":[' +
    '{"matched_name":string,"matched_price":number,"confidence":number,"kind":"exact"|"fuzzy","notes":string}' +
    `]}]}. Maximum ${maxCandidatesPerItem} candidates per requested item. ` +
    'Rules: ' +
    '(1) confidence is 0..1. ' +
    '(2) kind="exact" means the menu name semantically matches the requested name (modifier wording / casing differences OK). ' +
    '(3) kind="fuzzy" means same category or intent but not the same item (e.g. White Bread -> Wheat Bread, Coke -> Pepsi, Fries -> Tots). ' +
    '(4) matched_name MUST be copied verbatim from the menu. ' +
    '(5) matched_price MUST be a number copied verbatim from the menu (no estimation). ' +
    '(6) Order candidates: highest-confidence exact first, then fuzzy by confidence desc. ' +
    '(7) If no plausible candidate exists, return an empty candidates array for that requested item. ' +
    '(8) Do NOT consider budget — return all plausible candidates regardless of price.';

  const user =
    `Requested items:\n${JSON.stringify(requestedItems, null, 2)}\n\n` +
    `Menu:\n${JSON.stringify(menu, null, 2)}`;

  const res = await client().messages.create({
    model: MODEL,
    max_tokens: 4096,
    system,
    messages: [{ role: 'user', content: user }],
  });
  logUsage('rankCandidates', res);
  const text = extractText(res);
  const parsed = parseJsonStrict(text, 'rankCandidates');
  if (!parsed || !Array.isArray(parsed.ranked)) {
    throw new ClaudeInvalidJsonError('rankCandidates: missing ranked[]', text);
  }
  console.log('[claude] rankCandidates → candidates per item:', parsed.ranked.map((r) => `${r.requested}=${r.candidates?.length || 0}`).join(', '));
  return parsed;
}

// Pure function. Picks the combination of candidates (one per requested item)
// whose total cost <= maxTotal, preferring exact matches and high confidence.
//
// Strategy:
//   1. Try the "all best" combo: pick top-ranked candidate for each item.
//      If total <= maxTotal → ship it. (Common case, fast path.)
//   2. Otherwise, search across candidate combinations preferring (a) more
//      exacts, (b) higher total confidence, (c) total closer to maxTotal
//      without exceeding it. We cap the search to keep it bounded: enumerate
//      up to maxCandidatesPerItem^N where N is small (typical orders are
//      2-6 items so the search space is tiny).
//   3. If no combo fits, return withinBudget:false and the closest attempts
//      so the human reviewer sees what we tried.
//
// Inputs:
//   ranked:    output from rankCandidates (one entry per requested item)
//   quantities: array of qty for each requested item (same order as ranked)
//   maxTotal:  budget cap
//   confidenceThreshold: minimum confidence to consider a candidate
function solveBudget({ ranked, quantities, maxTotal, confidenceThreshold = 0.85 }) {
  if (!Array.isArray(ranked) || !ranked.length) {
    return { withinBudget: false, picks: [], totalUsed: 0, reason: 'No items to match', attempts: [] };
  }
  if (!Number.isFinite(maxTotal) || maxTotal <= 0) {
    return { withinBudget: false, picks: [], totalUsed: 0, reason: `Invalid maxTotal: ${maxTotal}`, attempts: [] };
  }

  // Filter each item's candidates by confidence threshold. If an item has no
  // candidates above threshold, we already know we can't ship it — fail fast.
  const filtered = ranked.map((r, idx) => {
    const qty = Number.isFinite(quantities[idx]) && quantities[idx] > 0 ? quantities[idx] : 1;
    const valid = (r.candidates || [])
      .filter((c) => typeof c.matched_price === 'number' && c.matched_price >= 0)
      .filter((c) => (c.confidence || 0) >= confidenceThreshold);
    return { requested: r.requested, qty, candidates: valid };
  });

  const itemsWithNoCandidates = filtered
    .map((f, i) => ({ ...f, _idx: i }))
    .filter((f) => f.candidates.length === 0);
  if (itemsWithNoCandidates.length) {
    return {
      withinBudget: false,
      picks: [],
      totalUsed: 0,
      reason: `No qualifying candidates (confidence >= ${confidenceThreshold}) for: ${itemsWithNoCandidates.map((f) => `"${f.requested}"`).join(', ')}`,
      attempts: [],
    };
  }

  // Score a combo. Higher is better. We use a lexicographic-ish weight:
  //   100 * exact_count + total_confidence + small bonus for using more budget
  // The exact-count term dominates (prefer all-exacts over all-fuzzy), then
  // confidence (prefer 0.95 fuzzy over 0.85 fuzzy), then budget-utilization
  // (prefer $24 of $25 over $10 of $25, but only as a tiebreaker).
  function scoreCombo(picks) {
    let exactCount = 0;
    let confSum = 0;
    let costSum = 0;
    for (let i = 0; i < picks.length; i++) {
      const p = picks[i];
      const qty = filtered[i].qty;
      if (p.kind === 'exact') exactCount += 1;
      confSum += p.confidence || 0;
      costSum += (p.matched_price || 0) * qty;
    }
    return { score: exactCount * 100 + confSum + (costSum / Math.max(1, maxTotal)) * 0.5, exactCount, confSum, costSum };
  }

  // Enumerate combinations. Guard against blowup: refuse if the space exceeds
  // 10_000 (would be 6 items × 5 candidates each = 15_625 — already past our
  // taste, but adjustable later).
  let combinationCount = 1;
  for (const f of filtered) combinationCount *= f.candidates.length;
  if (combinationCount > 10_000) {
    // Truncate each item to top-3 candidates and retry. Search space stays small.
    for (const f of filtered) f.candidates = f.candidates.slice(0, 3);
    combinationCount = filtered.reduce((acc, f) => acc * f.candidates.length, 1);
  }

  let best = null;
  let closestOver = null; // closest over-budget combo, for diagnostics

  // Iterative N-dimensional enumeration (no recursion → no stack risk).
  const idx = new Array(filtered.length).fill(0);
  while (true) {
    const picks = filtered.map((f, i) => f.candidates[idx[i]]);
    const s = scoreCombo(picks);
    if (s.costSum <= maxTotal + 0.005) {
      if (!best || s.score > best.score) best = { picks, ...s };
    } else if (!closestOver || s.costSum < closestOver.costSum) {
      closestOver = { picks, ...s };
    }
    // increment counter
    let k = 0;
    while (k < idx.length) {
      idx[k] += 1;
      if (idx[k] < filtered[k].candidates.length) break;
      idx[k] = 0;
      k += 1;
    }
    if (k === idx.length) break;
  }

  if (best) {
    return {
      withinBudget: true,
      picks: best.picks.map((p, i) => ({
        requested: filtered[i].requested,
        qty: filtered[i].qty,
        matched_name: p.matched_name,
        matched_price: p.matched_price,
        confidence: p.confidence,
        kind: p.kind,
        notes: p.notes || '',
      })),
      totalUsed: +best.costSum.toFixed(2),
      exactCount: best.exactCount,
      reason: null,
      attempts: [],
    };
  }

  // No combo fits. Build a diagnostic showing the closest attempts so the
  // reviewer can see what we tried.
  const cheapestAttempt = filtered.map((f) => f.candidates[f.candidates.length - 1]);
  const cheapestCost = cheapestAttempt.reduce((acc, p, i) => acc + (p.matched_price || 0) * filtered[i].qty, 0);
  const attempts = [
    closestOver && {
      label: 'closest-over-budget',
      total: +closestOver.costSum.toFixed(2),
      picks: closestOver.picks.map((p, i) => `"${filtered[i].requested}" -> ${p.matched_name} @ $${p.matched_price} (${p.kind})`),
    },
    {
      label: 'cheapest-available',
      total: +cheapestCost.toFixed(2),
      picks: cheapestAttempt.map((p, i) => `"${filtered[i].requested}" -> ${p.matched_name} @ $${p.matched_price} (${p.kind})`),
    },
  ].filter(Boolean);

  return {
    withinBudget: false,
    picks: [],
    totalUsed: 0,
    reason: `No combination of candidates fits maxTotal $${maxTotal.toFixed(2)}. Cheapest possible = $${cheapestCost.toFixed(2)}.`,
    attempts,
  };
}

// Convenience: end-to-end (Claude rank → solve). Most callers want this.
async function matchItemsBudgetAware({ requestedItems, menu, maxTotal, confidenceThreshold = 0.85 }) {
  const ranked = await rankCandidates({ requestedItems, menu });
  const quantities = requestedItems.map((it) => it.qty);
  const solved = solveBudget({
    ranked: ranked.ranked,
    quantities,
    maxTotal,
    confidenceThreshold,
  });
  return { ...solved, rankedRaw: ranked.ranked };
}

// Pick sensible defaults for a Grubhub item's required modifier sections.
// Input: the item name + an array of sections, each with options scored by
// upcharge. Output: a pick per section keyed by sectionKey. The caller maps
// each pick back to a DOM option by text match (with cheapest as fallback
// when the named option can't be located, so a hallucinated label can't
// block the cart).
async function pickModifiers({ itemName, sections }) {
  console.log('[claude] pickModifiers', itemName, sections.length, 'sections');
  if (!Array.isArray(sections) || !sections.length) {
    return { picks: [] };
  }
  const system =
    'You are filling required modifier choices for a restaurant item. ' +
    'Pick sensible defaults a typical customer would expect. ' +
    'Avoid options like "No-Bun" or "Junior" unless the item name clearly implies them. ' +
    'Prefer common picks (e.g. "Shorti Roll", "American", "Toasted") over premium upcharges when both fit. ' +
    'Only return picks for sections where required=true. Skip optional sections. ' +
    'Return ONLY JSON. Schema: {"picks":[{"sectionKey":string,"optionText":string,"reason":string}]}. ' +
    'optionText must be copied verbatim from the input options.';

  const user =
    `Item: ${itemName}\n\n` +
    `Sections (JSON):\n${JSON.stringify(sections, null, 2)}`;

  const res = await client().messages.create({
    model: MODEL,
    max_tokens: 600,
    system,
    messages: [{ role: 'user', content: user }],
  });
  logUsage('pickModifiers', res);
  const text = extractText(res);
  const parsed = parseJsonStrict(text, 'pickModifiers');
  if (!parsed || !Array.isArray(parsed.picks)) {
    throw new ClaudeInvalidJsonError('pickModifiers: missing picks[]', text);
  }
  console.log('[claude] pickModifiers →', parsed.picks);
  return parsed;
}

async function parseConfirmation({ html }) {
  console.log('[claude] parseConfirmation');
  const cleaned = stripHtml(html);
  const system =
    'Extract Grubhub order confirmation details from page HTML. ' +
    'Return ONLY JSON. Schema: ' +
    '{"success":boolean,"order_id":string|null,"total":number|null,"eta":string|null,"notes":string}. ' +
    'success=true only if the page clearly confirms the order was placed.';

  const res = await client().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: 'user', content: `Confirmation page (cleaned):\n${cleaned}` }],
  });
  logUsage('parseConfirmation', res);
  const text = extractText(res);
  const parsed = parseJsonStrict(text, 'parseConfirmation');
  if (typeof parsed.success !== 'boolean') {
    throw new ClaudeInvalidJsonError('parseConfirmation: missing success bool', text);
  }
  console.log('[claude] parseConfirmation →', parsed);
  return parsed;
}

async function reasonAboutError({ screenshotPath, screenshotBase64, dom }) {
  console.log('[claude] reasonAboutError');
  const cleaned = stripHtml(dom);
  const userBlocks = [];
  if (screenshotBase64) {
    userBlocks.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: screenshotBase64 },
    });
  } else if (screenshotPath) {
    const fs = require('fs');
    if (fs.existsSync(screenshotPath)) {
      const b64 = fs.readFileSync(screenshotPath).toString('base64');
      userBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: b64 },
      });
    }
  }
  userBlocks.push({
    type: 'text',
    text: `DOM (cleaned, truncated):\n${cleaned.slice(0, 20000)}`,
  });

  const system =
    'You diagnose Grubhub automation failures from a screenshot and DOM. ' +
    'Return ONLY JSON. Schema: ' +
    '{"what_happened":string,"recommended_action":string,"blocker_type":string,"retryable":boolean}. ' +
    'blocker_type ∈ {"captcha","2fa","login","out_of_stock","price_changed","ui_change","network","unknown"}.';

  const res = await client().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: 'user', content: userBlocks }],
  });
  logUsage('reasonAboutError', res);
  const text = extractText(res);
  const parsed = parseJsonStrict(text, 'reasonAboutError');
  if (!parsed.what_happened || !parsed.recommended_action) {
    throw new ClaudeInvalidJsonError('reasonAboutError: missing required fields', text);
  }
  console.log('[claude] reasonAboutError →', parsed);
  return parsed;
}

module.exports = {
  ClaudeInvalidJsonError,
  helloWorld,
  matchItems,
  rankCandidates,
  solveBudget,
  matchItemsBudgetAware,
  pickModifiers,
  parseConfirmation,
  reasonAboutError,
  stripHtml,
};
