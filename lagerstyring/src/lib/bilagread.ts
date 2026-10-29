// Forslag til et bilags oplysninger ud fra dets tekst (fra en PDF med tekst).
//
// Læseren foreslår kun værdier, der står i teksten. Den regner aldrig moms ud fra en sats, den ikke
// har læst, og den udfylder aldrig et felt, den ikke har fundet. Værdier fundet uden en tydelig
// overskrift (fx leverandørens navn eller en dato uden "Dato:") markeres som usikre.

export type ReadField =
  | 'doc_type'
  | 'supplier_name'
  | 'supplier_cvr'
  | 'doc_number'
  | 'doc_date'
  | 'due_date'
  | 'currency'
  | 'net'
  | 'vat'
  | 'total'
  | 'rounding'
  | 'payment_info'
  | 'line_prices';

export interface ReadLine {
  name: string;
  qty: number | null;
  unit: string;
  unit_price: number | null;
  discount: number;
  amount: number | null;
  vat_rate: number | null;
  uncertain: boolean;
}

export interface Reading {
  values: Partial<Record<ReadField, string | number>>;
  uncertain: ReadField[];
  lines: ReadLine[];
  notes: string[];
}

const MONTHS = [
  ['januar', 'january'],
  ['februar', 'february'],
  ['marts', 'march'],
  ['april'],
  ['maj', 'may'],
  ['juni', 'june'],
  ['juli', 'july'],
  ['august'],
  ['september'],
  ['oktober', 'october'],
  ['november'],
  ['december'],
];

/** Et dansk eller engelsk månedsnavn (også forkortet, fx "okt" og "Oct") → 1-12, ellers 0. */
function monthOf(word: string): number {
  const w = word.toLowerCase().replace(/\.$/, '');
  if (w.length < 3) return 0;
  return MONTHS.findIndex((names) => names.some((n) => n.startsWith(w))) + 1;
}

/** Et beløb i dansk eller engelsk skrivemåde → øre. */
export function parseMoney(raw: string): number | null {
  let s = raw.replace(/\s|kr\.?|DKK/gi, '').replace(/[−–]/g, '-');
  if (!s) return null;
  const neg = s.startsWith('-') || s.endsWith('-');
  s = s.replace(/^-|-$/g, '');
  let m: RegExpExecArray | null;
  if ((m = /^(\d{1,3}(?:\.\d{3})+|\d+),(\d{1,2})$/.exec(s))) {
    const v = parseInt(m[1]!.replace(/\./g, ''), 10) * 100 + parseInt(m[2]!.padEnd(2, '0'), 10);
    return neg ? -v : v;
  }
  if ((m = /^(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})$/.exec(s))) {
    const v = parseInt(m[1]!.replace(/,/g, ''), 10) * 100 + parseInt(m[2]!, 10);
    return neg ? -v : v;
  }
  return null;
}

const MONEY = /-?\d{1,3}(?:\.\d{3})+,\d{2}-?|-?\d+,\d{2}-?|-?\d{1,3}(?:,\d{3})+\.\d{2}|-?\d+\.\d{2}(?!\d)/g;

/** Fjerner tal, der ikke er beløb: datoer ("20.10.2026" er ikke 20,10 kr.) og momsgrundlag ("25% on 581.42"). */
function moneyText(line: string): string {
  return line
    .replace(/\b\d{1,2}[.\-/]\d{1,2}[.\-/](?:\d{4}|\d{2})\b/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\d+(?:[.,]\d+)?\s*%\s*(?:on|of|af|på)\s+[^\s)]+/gi, ' ');
}

function moneyIn(line: string): number[] {
  return [...moneyText(line).matchAll(MONEY)].map((m) => parseMoney(m[0])).filter((v): v is number => v !== null);
}

/** En linje med kun ét beløb (evt. med kr./DKK), fx når beløbet står på linjen under eller over sin tekst. */
function onlyMoney(line: string | undefined): number | null {
  if (!line || !/^\s*-?\s*(?:kr\.?|DKK)?\s*-?[\d.,]+\s*(?:kr\.?|DKK)?\s*-?\s*$/i.test(line)) return null;
  const m = moneyIn(line);
  return m.length === 1 ? m[0]! : null;
}

/** Antal (dansk decimalkomma) → tusindedele. */
function parseQtyText(raw: string): number | null {
  const m = /^(-?\d+(?:[.,]\d{1,3})?)$/.exec(raw.trim());
  if (!m) return null;
  return Math.round(parseFloat(m[1]!.replace(',', '.')) * 1000);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Datoer i teksten → YYYY-MM-DD. */
export function datesIn(line: string): string[] {
  const out: { at: number; d: string }[] = [];
  const add = (at: number, y: number, mo: number, d: number) => {
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) out.push({ at, d: `${y}-${pad(mo)}-${pad(d)}` });
  };
  for (const m of line.matchAll(/\b(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4}|\d{2})\b/g)) {
    const y = m[3]!.length === 2 ? 2000 + parseInt(m[3]!, 10) : parseInt(m[3]!, 10);
    add(m.index!, y, parseInt(m[2]!, 10), parseInt(m[1]!, 10));
  }
  for (const m of line.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) add(m.index!, parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10));
  // "20. oktober 2026", "20 Oct 2026"
  for (const m of line.matchAll(/\b(\d{1,2})\.?\s*([a-zæøå]+\.?),?\s+(\d{4})\b/gi)) add(m.index!, parseInt(m[3]!, 10), monthOf(m[2]!), parseInt(m[1]!, 10));
  // "October 20, 2026"
  for (const m of line.matchAll(/\b([a-z]+\.?)\s+(\d{1,2}),?\s+(\d{4})\b/gi)) add(m.index!, parseInt(m[3]!, 10), monthOf(m[1]!), parseInt(m[2]!, 10));
  return out.sort((a, b) => a.at - b.at).map((x) => x.d);
}

const LABEL = {
  total: /\b(at betale|i alt inkl|total inkl|beløb i alt|til betaling|amount due|total due|balance due|grand total|totalt|total|i alt|sum)\b/i,
  totalStrong: /\b(at betale|i alt inkl|total inkl|til betaling|amount due|total due|balance due)\b/i,
  net: /(ekskl\.?\s*moms|excl\.?\s*vat|excluding (?:tax|vat)|subtotal|netto|momsgrundlag|momspligtigt beløb)/i,
  vat: /(^|\s)(heraf moms|moms|vat|mva|tax)\b/i,
  // Ikke en momslinje: ekskl./inkl.-tekster og momsnumre (fx "IE VAT IE4143435AH", "VAT no.")
  vatNot: /(ekskl|inkl|excl|incl|grundlag|fri|momspligtig|nr\.|\b(?:vat|tax)\s*(?:no|nr|number|id|reg)|\b[A-Z]{2}\d{6,})/i,
  rounding: /(øreafrunding|afrunding)/i,
  number: /(invoice\s*(?:number|no\.?|nr\.?|#)|receipt\s*(?:number|no\.?|#)|credit\s*note\s*(?:number|no\.?)|order\s*(?:number|no\.?)|kreditnota\s*nr\.?|kreditnotanr\.?|faktura\s*nr\.?|fakturanr\.?|fakturanummer|bilagsnr\.?|bilag\s*nr\.?|\bbilag\s*[:#]|kvitteringsnr\.?|kvittering\s*nr\.?|bon\s*nr\.?|bonnr\.?|ordrenr\.?|ordre\s*nr\.?)\s*[:.#]?\s*([A-Za-z0-9][A-Za-z0-9\-/]{0,30})/i,
  date: /(fakturadato|kreditnotadato|købsdato|udstedelsesdato|bilagsdato|date of issue|issue date|invoice date|\bdato\b|\bdate\b)/i,
  due: /(forfaldsdato|forfald|betalingsfrist|betales senest|sidste rettidige|due date|date due|payment due)/i,
  payment: /(\bFIK\b|\+7[135]<|\breg\.?\s*nr|\bkontonr|\bkonto nr|\bkonto:|\bIBAN\b|\bBIC\b|\bSWIFT\b|\bMobilePay\b|\bbetalings-?id)/i,
  cvr: /\b(?:CVR|SE)(?:[-\s.]?nr)?\.?\s*[:.]?\s*(?:DK)?\s*(\d{2}\s?\d{2}\s?\d{2}\s?\d{2})\b/gi,
  header: /(beskrivelse|varetekst|tekst|vare\b|varenr|produkt|ydelse|antal|stk\.?|enhed|á|a-pris|stykpris|pris|beløb|rabat|moms|description|qty|quantity|unit price|price|amount|tax)/gi,
};

// "Subtotal" kan være et bruttobeløb på en kassebon. Kun disse labels siger udtrykkeligt ekskl. moms.
const EXPLICIT_NET = /(ekskl\.?\s*moms|excl\.?\s*vat|excluding (?:tax|vat)|netto|momsgrundlag|momspligtigt beløb)/i;
const INCLUSIVE_RECEIPT_VAT = /\bheraf\s+moms\b|\bmoms(?=\s|\d|[(:])[^\n]{0,60}\bheraf\b|\binkl\.?\s*moms\b/i;

type Col = 'name' | 'sku' | 'qty' | 'unit' | 'price' | 'discount' | 'vat' | 'amount' | 'skip';

function colOf(label: string): Col {
  const l = label.toLowerCase();
  if (/varenr|^nr\.?$|art\.?\s*nr|sku|item no/.test(l)) return 'sku';
  if (/beløb|i alt|total|sum|amount/.test(l)) return 'amount';
  // Før "enhed": "Enhedspris" og "Unit price" er stykprisen
  if (/pris|price|á|a-pris/.test(l)) return 'price';
  if (/rabat|discount/.test(l)) return 'discount';
  if (/moms|tax|vat/.test(l)) return 'vat';
  if (/antal|mængde|stk|qty|quantity/.test(l)) return 'qty';
  if (/enhed|unit/.test(l)) return 'unit';
  if (/beskrivelse|tekst|vare|produkt|ydelse|description|item/.test(l)) return 'name';
  return 'skip';
}

/** Et varenummer alene på en linje, fx "TEST-M001" under varenavnet. */
const SKU_ONLY = /^(?=[A-Z0-9\-./]*\d)[A-Z0-9][A-Z0-9\-./]{2,24}$/;

const isNumberCol = (c: string) => /^-?\d+(?:[.,]\d{1,3})?\s*[a-zæøå²³.]*$/i.test(c) || moneyIn(c).length > 0;

function vatRateOf(raw: string): number | null {
  const m = /(\d{1,2}(?:[.,]\d{1,2})?)\s*%/.exec(raw);
  return m ? Math.round(parseFloat(m[1]!.replace(',', '.')) * 100) : null;
}

// Kassebon uden kolonneoverskrift: varenavn på én linje, derefter fx "2 x 89,95 179,90".
// Kræver alle tre udtrykkelige tal; dimensioner og pakningsstørrelser i navnet fortolkes ikke.
const RECEIPT_ROW = new RegExp(`^\\s*(-?\\d+(?:[.,]\\d{1,3})?)\\s*[x×]\\s*((?:${MONEY.source})(?:\\s*(?:kr\\.?|DKK))?)\\s+((?:${MONEY.source})(?:\\s*(?:kr\\.?|DKK))?)\\s*$`, 'i');
const RECEIPT_META = /^(?:cvr|se[- .]?nr|tlf|telefon|kasse|bilag|bon(?:nr)?|kvittering|receipt|eksp|ekspedient|terminal|dato|date|tid|time|rabat|discount|retur\s+(?:kontant(?:er)?|cash|penge|beløb|kort)\b|byttepenge|kontant|kort|dankort|visa|mastercard|betaling|betalt|tak\b|velkommen|åbningstid|www\.|https?:|[-_=*]{3})/i;

function receiptFooter(line: string): boolean {
  return moneyIn(line).length > 0 && (LABEL.net.test(line) || LABEL.total.test(line) || (LABEL.vat.test(line) && !LABEL.vatNot.test(line)) || LABEL.rounding.test(line) || LABEL.payment.test(line));
}

function readReceiptLines(lines: string[]): ReadLine[] {
  const out: ReadLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (out.length && receiptFooter(line)) break;
    const m = RECEIPT_ROW.exec(line);
    if (!m) continue;
    let before = i - 1;
    while (before >= 0 && !lines[before]!.trim()) before--;
    const name = lines[before]?.trim();
    if (!name || !/[a-zæøå]/i.test(name) || RECEIPT_META.test(name) || receiptFooter(name) || LABEL.payment.test(name) || datesIn(name).length || RECEIPT_ROW.test(name)) continue;
    const qty = parseQtyText(m[1]!);
    const price = parseMoney(m[2]!);
    const amount = parseMoney(m[3]!);
    if (qty === null || price === null || amount === null) continue;
    if (/^retur\b/i.test(name) && (qty >= 0 || !/[a-zæøå]{2}/i.test(name.replace(/^retur\b[\s:.-]*/i, '')))) continue;
    // Fallback-formatet og de læste værdier skal altid kontrolleres; ret aldrig regnestykket automatisk.
    out.push({ name: name.slice(0, 200), qty, unit: '', unit_price: price, discount: 0, amount, vat_rate: null, uncertain: true });
  }
  return out;
}

/** Varelinjer mellem en kolonneoverskrift og den første total. */
function readLines(lines: string[]): ReadLine[] {
  const hi = lines.findIndex(
    (l) => new Set([...l.matchAll(LABEL.header)].map((m) => m[1]!.toLowerCase())).size >= 3 && l.trim().split(/\s{2,}/).filter((c) => colOf(c) !== 'skip').length >= 3 && moneyIn(l).length === 0,
  );
  if (hi < 0) return readReceiptLines(lines);
  const heads = lines[hi]!.trim().split(/\s{2,}/).map(colOf);
  const out: ReadLine[] = [];
  // Tekstlinjer uden beløb: enten fortsættelsen af forrige vare eller navnet på den næste
  // (nogle fakturaer skriver varenavnet på linjen over tallene)
  let pending: string[] = [];
  let justAdded = false;
  const flushToPrev = () => {
    const prev = out[out.length - 1];
    if (prev && pending.length) prev.name = `${prev.name} ${pending.join(' ')}`.trim().slice(0, 200);
    pending = [];
  };
  for (let i = hi + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.trim()) continue;
    if (LABEL.net.test(l) || LABEL.totalStrong.test(l) || (LABEL.total.test(l) && moneyIn(l).length === 1 && l.trim().split(/\s{2,}/).length <= 2)) break;
    if (LABEL.vat.test(l) && !LABEL.vatNot.test(l) && moneyIn(l).length === 1 && l.trim().split(/\s{2,}/).length <= 3) break;
    const cols = l.trim().split(/\s{2,}/);
    const money = moneyIn(l);
    // En rabatlinje lægges på linjen før
    if (/^rabat/i.test(cols[0]!) && money.length && out.length) {
      const d = Math.abs(money[money.length - 1]!);
      const prev = out[out.length - 1]!;
      prev.discount += d;
      if (prev.amount !== null) prev.amount -= d;
      continue;
    }
    if (!money.length) {
      if (cols.length !== 1) continue;
      // Et varenummer lige under en vare hører til den
      if (justAdded && !pending.length && SKU_ONLY.test(cols[0]!) && out.length) {
        const prev = out[out.length - 1]!;
        prev.name = `${cols[0]} ${prev.name}`.slice(0, 200);
      } else pending.push(cols[0]!);
      justAdded = false;
      continue;
    }
    const r: ReadLine = { name: '', qty: null, unit: '', unit_price: null, discount: 0, amount: null, vat_rate: null, uncertain: false };
    let sku = '';
    // Rækken mangler navnekolonnen (navnet stod på linjen over)
    const nameless = heads[0] === 'name' && isNumberCol(cols[0]!) && cols.length === heads.length - 1;
    const rowHeads = nameless ? heads.slice(1) : heads;
    if (cols.length === rowHeads.length) {
      cols.forEach((v, k) => {
        switch (rowHeads[k]) {
          case 'name':
            r.name = v;
            break;
          case 'sku':
            sku = v;
            break;
          case 'qty': {
            const m = /^(-?\d+(?:[.,]\d{1,3})?)\s*([a-zæøå²³.]*)$/i.exec(v);
            if (m) {
              r.qty = parseQtyText(m[1]!);
              if (m[2]) r.unit = m[2];
            }
            break;
          }
          case 'unit':
            r.unit = v;
            break;
          case 'price':
            r.unit_price = parseMoney(v);
            break;
          case 'discount':
            r.discount = Math.abs(parseMoney(v) ?? 0);
            break;
          case 'vat':
            r.vat_rate = vatRateOf(v);
            break;
          case 'amount':
            r.amount = parseMoney(v);
            break;
        }
      });
    } else {
      // Uden entydige kolonner: tekst først, beløb sidst, evt. antal og stykpris imellem
      r.uncertain = true;
      r.name = cols.filter((c) => !moneyIn(c).length && !/^\d+([.,]\d+)?\s*[a-zæøå.]*$/i.test(c) && !/^-?\d+([.,]\d+)?\s*%$/.test(c)).join(' ');
      r.amount = money[money.length - 1]!;
      if (money.length >= 2) r.unit_price = money[money.length - 2]!;
      const q = cols.map((c) => /^(\d+(?:[.,]\d{1,3})?)\s*([a-zæøå.]*)$/i.exec(c)).find((m) => m && !/,\d{2}$/.test(m[1]!));
      if (q) {
        r.qty = parseQtyText(q[1]!);
        r.unit = q[2] ?? '';
      }
      r.vat_rate = vatRateOf(l);
    }
    if (!r.name && pending.length) {
      r.name = pending.join(' ');
      pending = [];
    } else flushToPrev();
    if (sku) r.name = `${sku} ${r.name}`.trim();
    if (!r.name) r.name = cols[0]!;
    if (r.amount === null || r.qty === null || r.unit_price === null) r.uncertain = true;
    else if (Math.abs(Math.round((r.qty * r.unit_price) / 1000) - r.discount - r.amount) > 2) r.uncertain = true;
    out.push(r);
    justAdded = true;
  }
  flushToPrev();
  return out;
}

const SUPPLIER_HEAD = /^(leverandør|sælger|afsender|fra|from|supplier|seller|vendor)\s*:?\s*(.*)$/i;
const CUSTOMER_HEAD = /(faktureres til|bill to|billed to|sold to|ship to|kunde\b|leveringsadresse|modtager)/i;
const COMPANY = /\b(ApS|A\/S|I\/S|IVS|K\/S|P\/S|AMBA|Limited|Ltd\.?|GmbH|AB|AS|Oy|Inc\.?|LLC|B\.V\.|BV|S\.A\.|SARL|SRL|Corp\.?)(?=$|[\s,.)])/;
const NOT_NAME = /faktura|invoice|kvittering|receipt|kreditnota|credit note|digital visning|side \d|page \d|dato|date|^til\b|^kunde\b|bill to|leverandør\b|oplysninger|^(cvr|vat|moms)\b/i;

export function readText(pages: string[][], opts: { ownCvr?: string; ownName?: string; suppliers?: { id: number; name: string }[] } = {}): Reading {
  const lines = pages.flat();
  const text = lines.join('\n');
  const values: Reading['values'] = {};
  const uncertain = new Set<ReadField>();
  const notes: string[] = [];
  const own = (opts.ownCvr ?? '').replace(/\D/g, '');

  // Dokumenttype
  if (/kreditnota|credit note/i.test(text)) values.doc_type = 'kreditnota';
  else if (/\bfaktura\b|invoice/i.test(text)) values.doc_type = 'faktura';
  else if (/kvittering|\bbon\b|receipt/i.test(text)) values.doc_type = 'kvittering';

  // På en tydelig kassebon betyder "heraf moms", at momsen allerede er indeholdt i de trykte priser.
  // Bevar de trykte beløb: hverken en generisk subtotal eller total minus moms er et aflæst nettobeløb.
  const receiptContext = values.doc_type === 'kvittering' || (values.doc_type === undefined && /\bkasse\b/i.test(text) && /\bbilag\s*(?:nr\.?)?\s*[:#]/i.test(text));
  const inclusiveReceipt = receiptContext && INCLUSIVE_RECEIPT_VAT.test(text);

  // CVR: leverandørens (ikke vores eget)
  const cvrs = [...text.matchAll(LABEL.cvr)].map((m) => m[1]!.replace(/\s/g, '')).filter((c) => c !== own);
  if (cvrs.length) {
    values.supplier_cvr = cvrs[0]!;
    if (new Set(cvrs).size > 1) uncertain.add('supplier_cvr');
  }

  // Leverandør: en kendt leverandør, der står i teksten, ellers første linje med bogstaver
  // Ellers: teksten under "Leverandør"/"Fra", så et firmanavn (ApS, A/S, Limited …), så første linje med
  // bogstaver. Vores eget firma og kundeblokken ("Faktureres til", "Bill to") springes over.
  const ownName = (opts.ownName ?? '').trim().toLowerCase();
  const isOwn = (v: string) => ownName.length >= 3 && v.toLowerCase().includes(ownName);
  const known = (opts.suppliers ?? []).find((s) => s.name.length >= 3 && !isOwn(s.name) && text.toLowerCase().includes(s.name.toLowerCase()));
  if (known) values.supplier_name = known.name;
  else {
    const grid = lines.map((l) => l.trim().split(/\s{2,}/));
    const customer = new Set<string>();
    grid.forEach((cols, i) =>
      cols.forEach((c, k) => {
        if (CUSTOMER_HEAD.test(c)) for (let j = i; j <= i + 5; j++) customer.add(`${j}:${k}`);
      }),
    );
    const ok = (v: string | undefined, i: number, k: number): v is string =>
      !!v && /[a-zæøå]{2}/i.test(v) && !customer.has(`${i}:${k}`) && !isOwn(v) && !NOT_NAME.test(v);
    let name: string | undefined;
    for (let i = 0; i < grid.length && !name; i++) {
      grid[i]!.forEach((c, k) => {
        const m = SUPPLIER_HEAD.exec(c);
        if (!m || name) return;
        if (m[2] && ok(m[2], i, k)) name = m[2];
        else {
          const next = grid[i + 1];
          const v = next?.[Math.min(k, next.length - 1)];
          if (ok(v, i + 1, Math.min(k, (next?.length ?? 1) - 1))) name = v;
        }
      });
    }
    for (let i = 0; i < grid.length && !name; i++) name = grid[i]!.find((c, k) => COMPANY.test(c) && ok(c, i, k));
    for (let i = 0; i < grid.length && !name; i++) name = ok(grid[i]![0], i, 0) && /[a-zæøå]{3}/i.test(grid[i]![0]!) ? grid[i]![0] : undefined;
    if (name) {
      values.supplier_name = name.slice(0, 120);
      uncertain.add('supplier_name');
    }
  }

  // Nummer
  for (const l of lines) {
    const m = LABEL.number.exec(l);
    if (m && /\d/.test(m[2]!)) {
      values.doc_number = m[2]!;
      if (/ordre/i.test(m[1]!)) uncertain.add('doc_number');
      break;
    }
  }

  // Datoer
  const labelled = (re: RegExp, not?: RegExp): string | undefined => {
    for (const l of lines) {
      if (!re.test(l) || not?.test(l)) continue;
      const d = datesIn(l.slice(l.search(re)));
      if (d.length) return d[0];
    }
    return undefined;
  };
  const due = labelled(LABEL.due);
  if (due) values.due_date = due;
  const date = labelled(LABEL.date, LABEL.due);
  if (date) values.doc_date = date;
  else {
    const any = lines.flatMap(datesIn).filter((d) => d !== due);
    if (any.length) {
      values.doc_date = any[0]!;
      uncertain.add('doc_date');
    }
  }

  // Valuta
  const cur = /\b(DKK|EUR|SEK|NOK|USD|GBP)\b/.exec(text);
  if (cur) values.currency = cur[1]!;
  else if (/\dkr\b|\bkr\.?(\s|$)/i.test(text)) values.currency = 'DKK';
  else {
    values.currency = 'DKK';
    uncertain.add('currency');
  }

  // Beløb
  // Beløbet på linjen, ellers et beløb alene på linjen under eller over (fx "145.35kr" over "VAT - Denmark")
  const lastMoney = (l: string, i: number): number | null => {
    const m = moneyIn(l);
    if (m.length) return m[m.length - 1]!;
    return onlyMoney(lines[i + 1]) ?? onlyMoney(lines[i - 1]);
  };
  let total: number | null = null;
  let totalWeak = false;
  let net: number | null = null;
  let vat: number | null = null;
  let vatLines = 0;
  let rounding: number | null = null;
  lines.forEach((l, i) => {
    if (LABEL.rounding.test(l)) {
      const v = lastMoney(l, i);
      if (v !== null) rounding = v;
      return;
    }
    if (LABEL.net.test(l)) {
      if (inclusiveReceipt && !EXPLICIT_NET.test(l)) return;
      const v = lastMoney(l, i);
      if (v !== null && net === null) net = v;
      return;
    }
    if (LABEL.vat.test(l) && !LABEL.vatNot.test(l)) {
      const v = lastMoney(l, i);
      if (v !== null) {
        vat = (vat ?? 0) + v;
        vatLines++;
      }
      return;
    }
    if (LABEL.totalStrong.test(l)) {
      const v = lastMoney(l, i);
      if (v !== null) {
        total = v;
        totalWeak = false;
      }
      return;
    }
    if (LABEL.total.test(l) && !/ekskl|excl/i.test(l) && (total === null || totalWeak)) {
      const v = lastMoney(l, i);
      if (v !== null) {
        total = v;
        totalWeak = true;
      }
    }
  });
  if (total !== null) values.total = total;
  if (vat !== null) values.vat = vat;
  const rates = [...new Set(lines.filter((l) => LABEL.vat.test(l) && !LABEL.vatNot.test(l)).map(vatRateOf).filter((r): r is number => r !== null))];
  if (vatLines > 1) notes.push(`Flere momslinjer fundet (${vatLines}); momsen er summen af dem.`);
  if (rounding !== null) values.rounding = rounding;
  if (net !== null) values.net = net;
  else if (!inclusiveReceipt && total !== null && vat !== null) {
    // Ekskl. moms står ikke på bilaget, men følger af to læste beløb (markeres som usikkert)
    values.net = (total as number) - (vat as number) - ((rounding as number | null) ?? 0);
    uncertain.add('net');
    notes.push('Beløb ekskl. moms står ikke på bilaget; det er beregnet som total minus moms.');
  }
  // "Total" uden "inkl." er sikker nok, når den passer med beløb ekskl. moms plus moms
  if (totalWeak && !(net !== null && vat !== null && Math.abs((net as number) + (vat as number) + ((rounding as number | null) ?? 0) - (total as unknown as number)) <= 1)) uncertain.add('total');
  if (vat === null) notes.push('Momsen blev ikke fundet. Angiv den (også 0 kr.), før bilaget godkendes.');

  // Betalingsoplysninger
  const pay = lines.filter((l) => LABEL.payment.test(l)).slice(0, 3).map((l) => l.trim().replace(/\s{2,}/g, ' · '));
  if (pay.length) values.payment_info = pay.join('\n');

  // Varelinjer
  const items = readLines(lines);
  if (inclusiveReceipt) values.line_prices = 'inkl';
  if (items.length) {
    // Én momssats på bilaget gælder alle linjer uden egen sats
    if (rates.length === 1) for (const r of items) if (r.vat_rate === null) r.vat_rate = rates[0]!;
    const sum = items.reduce((a, r) => a + (r.amount ?? 0), 0);
    const n = values.net as number | undefined;
    const t = values.total as number | undefined;
    if (inclusiveReceipt) {
      if (t === undefined || Math.abs(sum - t) > 2) {
        uncertain.add('line_prices');
        notes.push('Bilaget angiver priser inkl. moms, men varelinjerne kan ikke afstemmes med den trykte total. Kontrollér linjerne.');
      }
    } else if (n !== undefined && Math.abs(sum - n) <= 2) values.line_prices = 'ekskl';
    else if (t !== undefined && Math.abs(sum - t) <= 2) values.line_prices = 'inkl';
    else {
      values.line_prices = 'ekskl';
      uncertain.add('line_prices');
      notes.push('Varelinjerne summer hverken til beløbet ekskl. eller inkl. moms. Kontrollér linjerne.');
    }
  }

  return { values, uncertain: [...uncertain], lines: items, notes };
}
