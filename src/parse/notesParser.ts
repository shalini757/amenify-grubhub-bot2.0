const GRUBHUB_URL_RE = /grubhub\.com\/restaurant\//i;

export type OrderType = 'delivery' | 'pickup' | null;

export interface ClockTime {
  raw: string;
  minutesFromMidnight: number;
}

export interface ItemModifiers {
  [itemName: string]: { [key: string]: string };
}

export interface ParsedNotes {
  provider: string;
  store: string;
  storeName: string;
  orderType: OrderType;
  orderUrl: string;
  maxTotal: number | null;
  items: string;
  deliveryAddress: string;
  bookingPhone: string;
  residentFirstName: string;
  residentLastName: string;
  specialInstructions: string;
  driverNotes: string;
  itemModifiers: ItemModifiers;
  targetTime: ClockTime | null;
  isGrubhub: boolean;
}

function firstMatch(text: string, re: RegExp): string {
  const m = text.match(re);
  return m && m[1] ? m[1].trim() : '';
}

// "Chick-fil-A - Delivery Order" → { storeName: "Chick-fil-A", orderType: "delivery" }
// "Chick-fil-A - Pickup Order"   → { storeName: "Chick-fil-A", orderType: "pickup" }
// Anything else                   → { storeName: <raw>, orderType: null }
function splitStoreField(rawStore: string): { storeName: string; orderType: OrderType } {
  if (!rawStore) return { storeName: '', orderType: null };
  const m = rawStore.match(/^(.*?)\s*-\s*(Delivery|Pickup)\s+Order\s*$/i);
  if (!m) return { storeName: rawStore.trim(), orderType: null };
  return { storeName: m[1].trim(), orderType: m[2].toLowerCase() as OrderType };
}

// Scan free text for a clock time like "7:30 PM" / "7pm" / "11:45am".
// AM/PM is required so we don't accidentally match prices or phone digits.
function parseClockTime(text: string | null | undefined): ClockTime | null {
  const m = String(text || '').match(/\b(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?\s*[Mm]\.?\b/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  if (h < 1 || h > 12 || min > 59) return null;
  const isPm = /p/i.test(m[3]);
  if (h === 12) h = 0;
  if (isPm) h += 12;
  return { raw: m[0].trim(), minutesFromMidnight: h * 60 + min };
}

function parseNotes(notesText: string | null | undefined): ParsedNotes {
  const text = String(notesText || '').replace(/\r\n/g, '\n');

  const provider = firstMatch(text, /^\s*(\w+)\s+appointment/im).toLowerCase();
  const store = firstMatch(text, /^\s*Store:\s*(.+?)\s*$/m);
  const { storeName, orderType } = splitStoreField(store);
  const orderUrl = firstMatch(text, /^\s*Order URL:\s*(\S+)/m);
  const totalStr = firstMatch(text, /^\s*Total:\s*\$?([\d.,]+)/m);
  const maxTotal = totalStr ? parseFloat(totalStr.replace(/,/g, '')) : null;
  const items = firstMatch(text, /^\s*Items:\s*(.+?)\s*$/m);
  const deliveryAddress = firstMatch(text, /^\s*Resident address:\s*(.+?)\s*$/m);
  const bookingPhone = firstMatch(text, /^\s*Temporary phone to use for booking:\s*(\+?\d+)/m);

  // "Resident name: First Last" — split on the LAST space so multi-word
  // first names ("Mary Anne Smith" → firstName="Mary Anne", lastName="Smith")
  // work correctly. Empty if the line isn't present.
  const residentNameLine = firstMatch(text, /^\s*Resident name:\s*(.+?)\s*$/m);
  let residentFirstName = '';
  let residentLastName = '';
  if (residentNameLine) {
    const lastSpace = residentNameLine.lastIndexOf(' ');
    if (lastSpace > 0) {
      residentFirstName = residentNameLine.slice(0, lastSpace).trim();
      residentLastName = residentNameLine.slice(lastSpace + 1).trim();
    } else {
      residentFirstName = residentNameLine.trim();
    }
  }

  let specialInstructions = '';
  const headerRe = /^\s*Resident notes and Special Instructions:\s*(.*)$/m;
  const m = text.match(headerRe);
  if (m && m.index !== undefined) {
    const afterHeader = text.slice(m.index + m[0].length);
    specialInstructions = ((m[1] ?? '') + '\n' + afterHeader).trim();
  }

  // Timing is opt-in: look in the special-instructions block first (that's
  // where residents tend to write "deliver around 7:30 PM"), and fall back
  // to scanning the whole notes blob if not found there.
  const targetTime = parseClockTime(specialInstructions) || parseClockTime(text);

  // itemModifiers = parse lines like:
  //   "Italian Hoagie modifiers: bread=White Bread, cheese=Provolone, toasting=Toasted"
  // into a map { "Italian Hoagie": { bread: "White Bread", cheese: "Provolone", ... } }.
  // Used to drive fillRequiredModifiers — picks the option whose text
  // contains the requested value, falling back to local default if no
  // preference is given for that section.
  const itemModifiers: ItemModifiers = {};
  const modLineRe = /^\s*(.+?)\s+modifiers:\s*(.+?)\s*$/igm;
  let modMatch: RegExpExecArray | null;
  while ((modMatch = modLineRe.exec(text)) !== null) {
    const itemName = modMatch[1].trim();
    const pairs = modMatch[2].split(',').map((p) => p.trim()).filter(Boolean);
    const mods: { [key: string]: string } = {};
    for (const pair of pairs) {
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const k = pair.slice(0, eq).trim().toLowerCase();
      const v = pair.slice(eq + 1).trim();
      if (k && v) mods[k] = v;
    }
    if (Object.keys(mods).length) itemModifiers[itemName] = mods;
  }

  // driverNotes = specialInstructions with the meta scaffold stripped out
  // ("This is a Delivery Order", "Resident Notes -", etc). What's left
  // is what we actually want to type into the Notes-for-the-driver box.
  const driverNotes = specialInstructions
    ? specialInstructions
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .filter((l) => !/^This is an? (Delivery|Pickup) Order\.?\s*$/i.test(l))
        .filter((l) => !/^Resident Notes?\s*[-:]?\s*$/i.test(l))
        .filter((l) => !/^Special Instructions?\s*[-:]?\s*$/i.test(l))
        .join('\n')
        .trim()
    : '';

  return {
    provider: provider || 'unknown',
    store,
    storeName,
    orderType,
    orderUrl,
    maxTotal,
    items,
    deliveryAddress,
    bookingPhone,
    residentFirstName,
    residentLastName,
    specialInstructions,
    driverNotes,
    itemModifiers,
    targetTime,
    isGrubhub: GRUBHUB_URL_RE.test(orderUrl),
  };
}

export { parseNotes };
