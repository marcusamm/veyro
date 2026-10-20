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

const MONTHS = ['januar', 'februar', 'marts', 'april', 'maj', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'december'];

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

function moneyIn(line: string): number[] {
  return [...line.matchAll(MONEY)].map((m) => parseMoney(m[0])).filter((v): v is number => v !== null);
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
  const out: string[] = [];
  for (const m of line.matchAll(/\b(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4}|\d{2})\b/g)) {
    const y = m[3]!.length === 2 ? 2000 + parseInt(m[3]!, 10) : parseInt(m[3]!, 10);
    const mo = parseInt(m[2]!, 10);
    const d = parseInt(m[1]!, 10);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) out.push(`${y}-${pad(mo)}-${pad(d)}`);
  }
  for (const m of line.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) out.push(`${m[1]}-${m[2]}-${m[3]}`);
  for (const m of line.matchAll(/\b(\d{1,2})\.\s*([a-zæøå]+)\s+(\d{4})\b/gi)) {
    const mo = MONTHS.findIndex((x) => x.startsWith(m[2]!.toLowerCase().slice(0, 3)));
    if (mo >= 0) out.push(`${m[3]}-${pad(mo + 1)}-${pad(parseInt(m[1]!, 10))}`);
  }
  return out;
}

const LABEL = {
  total: /\b(at betale|i alt inkl|total inkl|beløb i alt|til betaling|totalt|total|i alt|sum)\b/i,
  totalStrong: /\b(at betale|i alt inkl|total inkl|til betaling)\b/i,
  net: /(ekskl\.?\s*moms|excl\.?\s*vat|subtotal|netto|momsgrundlag|momspligtigt beløb)/i,
  vat: /(^|\s)(heraf moms|moms|vat|mva)\b/i,
  vatNot: /(ekskl|inkl|excl|incl|grundlag|fri|momspligtig|nr\.)/i,
  rounding: /(øreafrunding|afrunding)/i,
  number: /(kreditnota\s*nr\.?|kreditnotanr\.?|faktura\s*nr\.?|fakturanr\.?|fakturanummer|bilagsnr\.?|bilag\s*nr\.?|kvitteringsnr\.?|kvittering\s*nr\.?|bon\s*nr\.?|bonnr\.?|ordrenr\.?|ordre\s*nr\.?)\s*[:.#]?\s*([A-Za-z0-9][A-Za-z0-9\-/]{0,30})/i,
  date: /(fakturadato|kreditnotadato|købsdato|udstedelsesdato|bilagsdato|\bdato\b|\bdate\b)/i,
  due: /(forfaldsdato|forfald|betalingsfrist|betales senest|sidste rettidige|due date)/i,
  payment: /(\bFIK\b|\+7[135]<|\breg\.?\s*nr|\bkontonr|\bkonto nr|\bkonto:|\bIBAN\b|\bBIC\b|\bSWIFT\b|\bMobilePay\b|\bbetalings-?id)/i,
  cvr: /\b(?:CVR|SE)(?:[-\s.]?nr)?\.?\s*[:.]?\s*(?:DK)?\s*(\d{2}\s?\d{2}\s?\d{2}\s?\d{2})\b/gi,
  header: /(beskrivelse|varetekst|tekst|vare\b|varenr|produkt|antal|stk\.?|enhed|á|a-pris|stykpris|pris|beløb|rabat|moms)/gi,
};

type Col = 'name' | 'sku' | 'qty' | 'unit' | 'price' | 'discount' | 'vat' | 'amount' | 'skip';

function colOf(label: string): Col {
  const l = label.toLowerCase();
  if (/varenr|^nr\.?$|art\.?\s*nr/.test(l)) return 'sku';
  if (/beskrivelse|tekst|vare|produkt|ydelse/.test(l)) return 'name';
  if (/antal|mængde|stk/.test(l)) return 'qty';
  if (/enhed/.test(l)) return 'unit';
  if (/rabat/.test(l)) return 'discount';
  if (/moms/.test(l)) return 'vat';
  if (/beløb|i alt|total|sum/.test(l)) return 'amount';
  if (/pris|á|a-pris/.test(l)) return 'price';
  return 'skip';
}

function vatRateOf(raw: string): number | null {
  const m = /(\d{1,2}(?:[.,]\d{1,2})?)\s*%/.exec(raw);
  return m ? Math.round(parseFloat(m[1]!.replace(',', '.')) * 100) : null;
}

/** Varelinjer mellem en kolonneoverskrift og den første total. */
function readLines(lines: string[]): ReadLine[] {
  const hi = lines.findIndex((l) => new Set([...l.matchAll(LABEL.header)].map((m) => m[1]!.toLowerCase())).size >= 3 && moneyIn(l).length === 0);
  if (hi < 0) return [];
  const heads = lines[hi]!.trim().split(/\s{2,}/).map(colOf);
  const out: ReadLine[] = [];
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
      // Fortsættelse af forrige linjes tekst
      if (out.length && cols.length === 1 && out[out.length - 1]!.name.length < 120) out[out.length - 1]!.name += ` ${cols[0]}`;
      continue;
    }
    const r: ReadLine = { name: '', qty: null, unit: '', unit_price: null, discount: 0, amount: null, vat_rate: null, uncertain: false };
    let sku = '';
    if (cols.length === heads.length) {
      cols.forEach((v, k) => {
        switch (heads[k]) {
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
      r.name = cols.filter((c) => !moneyIn(c).length && !/^\d+([.,]\d+)?\s*[a-zæøå.]*$/i.test(c)).join(' ');
      r.amount = money[money.length - 1]!;
      if (money.length >= 2) r.unit_price = money[money.length - 2]!;
      const q = cols.map((c) => /^(\d+(?:[.,]\d{1,3})?)\s*([a-zæøå.]*)$/i.exec(c)).find((m) => m && !/,\d{2}$/.test(m[1]!));
      if (q) {
        r.qty = parseQtyText(q[1]!);
        r.unit = q[2] ?? '';
      }
      r.vat_rate = vatRateOf(l);
    }
    if (sku) r.name = `${sku} ${r.name}`.trim();
    if (!r.name) r.name = cols[0]!;
    if (r.amount === null || r.qty === null || r.unit_price === null) r.uncertain = true;
    else if (Math.abs(Math.round((r.qty * r.unit_price) / 1000) - r.discount - r.amount) > 2) r.uncertain = true;
    out.push(r);
  }
  return out;
}

export function readText(pages: string[][], opts: { ownCvr?: string; suppliers?: { id: number; name: string }[] } = {}): Reading {
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

  // CVR: leverandørens (ikke vores eget)
  const cvrs = [...text.matchAll(LABEL.cvr)].map((m) => m[1]!.replace(/\s/g, '')).filter((c) => c !== own);
  if (cvrs.length) {
    values.supplier_cvr = cvrs[0]!;
    if (new Set(cvrs).size > 1) uncertain.add('supplier_cvr');
  }

  // Leverandør: en kendt leverandør, der står i teksten, ellers første linje med bogstaver
  const known = (opts.suppliers ?? []).find((s) => s.name.length >= 3 && text.toLowerCase().includes(s.name.toLowerCase()));
  if (known) values.supplier_name = known.name;
  else {
    const first = lines.map((l) => l.trim().split(/\s{2,}/)[0]!).find((l) => /[a-zæøå]{3}/i.test(l) && !/faktura|kvittering|kreditnota|digital visning|side \d|dato|^til\b|^kunde\b/i.test(l));
    if (first) {
      values.supplier_name = first.slice(0, 120);
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
  const labelled = (re: RegExp): string | undefined => {
    for (const l of lines) {
      if (!re.test(l)) continue;
      const d = datesIn(l.slice(l.search(re)));
      if (d.length) return d[0];
    }
    return undefined;
  };
  const due = labelled(LABEL.due);
  if (due) values.due_date = due;
  const date = labelled(LABEL.date);
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
  else if (/\bkr\.?(\s|$)/i.test(text)) values.currency = 'DKK';
  else {
    values.currency = 'DKK';
    uncertain.add('currency');
  }

  // Beløb
  const lastMoney = (l: string, i: number): number | null => {
    const m = moneyIn(l);
    if (m.length) return m[m.length - 1]!;
    const next = lines[i + 1];
    const n = next ? moneyIn(next) : [];
    return n.length === 1 ? n[0]! : null;
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
  else if (total !== null && vat !== null) {
    // Ekskl. moms står ikke på bilaget, men følger af to læste beløb (markeres som usikkert)
    values.net = (total as number) - (vat as number) - ((rounding as number | null) ?? 0);
    uncertain.add('net');
    notes.push('Beløb ekskl. moms står ikke på bilaget; det er beregnet som total minus moms.');
  }
  if (totalWeak) uncertain.add('total');
  if (vat === null) notes.push('Momsen blev ikke fundet. Angiv den (også 0 kr.), før bilaget godkendes.');

  // Betalingsoplysninger
  const pay = lines.filter((l) => LABEL.payment.test(l)).slice(0, 3).map((l) => l.trim().replace(/\s{2,}/g, ' · '));
  if (pay.length) values.payment_info = pay.join('\n');

  // Varelinjer
  const items = readLines(lines);
  if (items.length) {
    // Én momssats på bilaget gælder alle linjer uden egen sats
    if (rates.length === 1) for (const r of items) if (r.vat_rate === null) r.vat_rate = rates[0]!;
    const sum = items.reduce((a, r) => a + (r.amount ?? 0), 0);
    const n = values.net as number | undefined;
    const t = values.total as number | undefined;
    if (n !== undefined && Math.abs(sum - n) <= 2) values.line_prices = 'ekskl';
    else if (t !== undefined && Math.abs(sum - t) <= 2) values.line_prices = 'inkl';
    else {
      values.line_prices = 'ekskl';
      uncertain.add('line_prices');
      notes.push('Varelinjerne summer hverken til beløbet ekskl. eller inkl. moms. Kontrollér linjerne.');
    }
  }

  return { values, uncertain: [...uncertain], lines: items, notes };
}
