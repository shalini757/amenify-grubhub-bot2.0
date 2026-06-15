'use strict';

// Parses the "Items:" line from notes into structured rows.
// Input shape (from sampleNotes.txt):
//   "Chicken Combo (3 Pcs) x 1 ($10.74), Chicken Combo (2 Pcs) x 1 ($9.60)"
// Items can contain parens, "x" can be "x" or "×", price uses $ prefix.

const ITEM_RE = /(.+?)\s+[x×]\s+(\d+)\s*\(\s*\$([\d.,]+)\s*\)/gi;

// Decode HTML entities that occasionally leak into sheet notes from the
// upstream booking system (we've seen mis-cased "&Amp;" for "&", as well
// as the more standard "&amp;" / "&#39;" / "&quot;"). Without this the
// item name we send to Claude is something like "Bean &Amp; Cheese Taco"
// and never matches a menu entry that reads "Bean & Cheese Taco".
function decodeEntities(s) {
  if (!s) return s;
  return String(s)
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ');
}

function parseItems(itemsText) {
  if (!itemsText) return [];
  const decoded = decodeEntities(itemsText);
  const out = [];
  let m;
  ITEM_RE.lastIndex = 0;
  while ((m = ITEM_RE.exec(decoded)) !== null) {
    const name = m[1].trim().replace(/^[,\s]+/, '');
    const qty = parseInt(m[2], 10);
    const price = parseFloat(m[3].replace(/,/g, ''));
    if (!name || !Number.isFinite(qty) || !Number.isFinite(price)) continue;
    out.push({ name, qty, price });
  }
  return out;
}

module.exports = { parseItems };
