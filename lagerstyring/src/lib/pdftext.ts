// Tekst fra en PDF med en teksttrin (fx en faktura sendt som PDF fra leverandørens system).
//
// Teksten læses fra sidernes indholdsstrømme med pdf-lib og samles til linjer ud fra placeringen
// på siden. Store vandrette spring markeres med to mellemrum, så kolonner kan skelnes. Indskannede
// PDF'er og fotos har ingen tekst; dem kan denne læser ikke aflæse (det kræver OCR).

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream, type PDFObject } from 'pdf-lib';

type Mat = [number, number, number, number, number, number];
const ID: Mat = [1, 0, 0, 1, 0, 0];
const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];

// Windows-1252 for 0x80-0x9F (resten er som Latin-1)
const CP1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';

interface Font {
  bytes: 1 | 2;
  map: Map<number, string> | null;
  widths: Map<number, number>;
  dw: number;
}

interface Run {
  x: number;
  y: number;
  end: number;
  size: number;
  text: string;
}

function streamBytes(s: PDFObject | undefined): Uint8Array | null {
  if (!s) return null;
  try {
    if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
    const any = s as unknown as { getUnencodedContents?: () => Uint8Array; getContents?: () => Uint8Array };
    if (typeof any.getUnencodedContents === 'function') return any.getUnencodedContents();
    if (typeof any.getContents === 'function') return any.getContents();
  } catch {
    return null;
  }
  return null;
}

const latin = (b: Uint8Array) => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return s;
};

function hexToStr(h: string): string {
  const v = h.replace(/[^0-9a-fA-F]/g, '');
  let s = '';
  for (let i = 0; i < v.length; i += 4) s += String.fromCharCode(parseInt(v.slice(i, i + 4).padEnd(4, '0'), 16));
  return s;
}

/** ToUnicode-tabellen i en font (bfchar og bfrange). */
function parseCMap(src: string): { map: Map<number, string>; bytes: 1 | 2 } {
  const map = new Map<number, string>();
  let bytes: 1 | 2 = 1;
  const cs = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(src);
  if (cs) {
    const m = /<([0-9a-fA-F]+)>/.exec(cs[1]!);
    if (m && m[1]!.length >= 4) bytes = 2;
  }
  for (const block of src.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(m[1]!, 16), hexToStr(m[2]!));
  }
  for (const block of src.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(m[1]!, 16);
      const hi = parseInt(m[2]!, 16);
      if (hi - lo > 5000) continue;
      if (m[3]!.startsWith('[')) {
        const items = [...m[3]!.matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => hexToStr(x[1]!));
        for (let c = lo; c <= hi; c++) if (items[c - lo] !== undefined) map.set(c, items[c - lo]!);
      } else {
        const base = m[3]!.slice(1, -1);
        const start = hexToStr(base);
        for (let c = lo; c <= hi; c++) {
          const last = start.charCodeAt(start.length - 1) + (c - lo);
          map.set(c, start.slice(0, -1) + String.fromCharCode(last));
        }
      }
    }
  }
  return { map, bytes };
}

function num(o: PDFObject | undefined): number | null {
  return o instanceof PDFNumber ? o.asNumber() : null;
}

function loadFont(dict: PDFDict): Font {
  const subtype = dict.lookup(PDFName.of('Subtype'));
  const type0 = subtype instanceof PDFName && subtype.asString() === '/Type0';
  const f: Font = { bytes: type0 ? 2 : 1, map: null, widths: new Map(), dw: type0 ? 1000 : 500 };
  const tu = streamBytes(dict.lookup(PDFName.of('ToUnicode')) as PDFObject | undefined);
  if (tu) {
    const r = parseCMap(latin(tu));
    f.map = r.map;
    if (type0) f.bytes = r.bytes;
  }
  if (type0) {
    const desc = dict.lookup(PDFName.of('DescendantFonts'));
    const d0 = desc instanceof PDFArray ? desc.lookup(0) : null;
    if (d0 instanceof PDFDict) {
      f.dw = num(d0.lookup(PDFName.of('DW'))) ?? 1000;
      const w = d0.lookup(PDFName.of('W'));
      if (w instanceof PDFArray) {
        let i = 0;
        while (i < w.size()) {
          const first = num(w.lookup(i));
          const next = w.lookup(i + 1);
          if (first === null) break;
          if (next instanceof PDFArray) {
            for (let k = 0; k < next.size(); k++) f.widths.set(first + k, num(next.lookup(k)) ?? f.dw);
            i += 2;
          } else {
            const last = num(next);
            const wv = num(w.lookup(i + 2));
            if (last === null || wv === null) break;
            for (let c = first; c <= last && c - first < 5000; c++) f.widths.set(c, wv);
            i += 3;
          }
        }
      }
    }
  } else {
    const first = num(dict.lookup(PDFName.of('FirstChar')));
    const w = dict.lookup(PDFName.of('Widths'));
    if (first !== null && w instanceof PDFArray) for (let k = 0; k < w.size(); k++) f.widths.set(first + k, num(w.lookup(k)) ?? 500);
  }
  return f;
}

function decodeStr(raw: string, font: Font | undefined): { text: string; width: number } {
  const f = font ?? { bytes: 1, map: null, widths: new Map(), dw: 500 };
  let text = '';
  let width = 0;
  const step = f.bytes;
  for (let i = 0; i + step <= raw.length; i += step) {
    const code = step === 2 ? (raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1) : raw.charCodeAt(i);
    const mapped = f.map?.get(code);
    if (mapped !== undefined) text += mapped;
    else if (step === 1) text += code >= 0x80 && code <= 0x9f ? CP1252[code - 0x80] : String.fromCharCode(code);
    width += f.widths.get(code) ?? (f.widths.size ? f.dw : step === 2 ? 1000 : 500);
  }
  return { text, width };
}

// --- Tokens i en indholdsstrøm -------------------------------------------------------------------

type Tok = { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 'name'; v: string } | { t: 'op'; v: string } | { t: 'arr'; v: Tok[] };

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  const stack: Tok[][] = [out];
  let i = 0;
  const push = (t: Tok) => stack[stack.length - 1]!.push(t);
  while (i < s.length) {
    const ch = s[i]!;
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '%') {
      while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++;
    } else if (ch === '(') {
      let depth = 1;
      let v = '';
      i++;
      while (i < s.length && depth > 0) {
        const c = s[i]!;
        if (c === '\\') {
          const n = s[i + 1]!;
          const esc: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
          if (esc[n] !== undefined) {
            v += esc[n];
            i += 2;
          } else if (/[0-7]/.test(n)) {
            const m = /^[0-7]{1,3}/.exec(s.slice(i + 1))![0];
            v += String.fromCharCode(parseInt(m, 8) & 255);
            i += 1 + m.length;
          } else if (n === '\n' || n === '\r') {
            i += 2;
          } else {
            v += n;
            i += 2;
          }
          continue;
        }
        if (c === '(') depth++;
        if (c === ')') depth--;
        if (depth > 0) v += c;
        i++;
      }
      push({ t: 'str', v });
    } else if (ch === '<' && s[i + 1] === '<') {
      // Ordbog (fx i BDC): spring over
      let depth = 0;
      while (i < s.length) {
        if (s[i] === '<' && s[i + 1] === '<') {
          depth++;
          i += 2;
        } else if (s[i] === '>' && s[i + 1] === '>') {
          depth--;
          i += 2;
          if (depth === 0) break;
        } else i++;
      }
    } else if (ch === '<') {
      const end = s.indexOf('>', i);
      const hex = s.slice(i + 1, end < 0 ? s.length : end).replace(/[^0-9a-fA-F]/g, '');
      let v = '';
      for (let k = 0; k < hex.length; k += 2) v += String.fromCharCode(parseInt(hex.slice(k, k + 2).padEnd(2, '0'), 16));
      push({ t: 'str', v });
      i = end < 0 ? s.length : end + 1;
    } else if (ch === '[') {
      const arr: Tok[] = [];
      push({ t: 'arr', v: arr });
      stack.push(arr);
      i++;
    } else if (ch === ']') {
      if (stack.length > 1) stack.pop();
      i++;
    } else if (ch === '/') {
      const m = /^\/[^\s/<>()[\]{}%]*/.exec(s.slice(i))![0];
      push({ t: 'name', v: m.slice(1) });
      i += m.length;
    } else if (/[-+.\d]/.test(ch)) {
      const m = /^[-+]?(\d+\.?\d*|\.\d+)/.exec(s.slice(i));
      if (m) {
        push({ t: 'num', v: parseFloat(m[0]) });
        i += m[0].length;
      } else i++;
    } else {
      const m = /^[^\s/<>()[\]{}%]+/.exec(s.slice(i));
      if (!m) {
        i++;
        continue;
      }
      push({ t: 'op', v: m[0] });
      i += m[0].length;
      // Inline-billeder: spring data over
      if (m[0] === 'ID') {
        const end = s.indexOf('EI', i);
        i = end < 0 ? s.length : end + 2;
      }
    }
  }
  return out;
}

function fontsOf(res: PDFDict | undefined, cache: Map<string, Font>): Map<string, Font> {
  const out = new Map<string, Font>();
  const fd = res?.lookup(PDFName.of('Font'));
  if (!(fd instanceof PDFDict)) return out;
  for (const [key, ref] of fd.entries()) {
    const id = ref instanceof PDFRef ? ref.toString() : key.asString();
    let f = cache.get(id);
    if (!f) {
      const dict = ref instanceof PDFRef ? fd.context.lookup(ref) : ref;
      if (!(dict instanceof PDFDict)) continue;
      f = loadFont(dict);
      cache.set(id, f);
    }
    out.set(key.asString().slice(1), f);
  }
  return out;
}

function runContent(bytes: Uint8Array, res: PDFDict | undefined, ctm0: Mat, runs: Run[], cache: Map<string, Font>, depth: number): void {
  const fonts = fontsOf(res, cache);
  const toks = tokenize(latin(bytes));
  let ctm = ctm0;
  const gstack: Mat[] = [];
  let tm: Mat = ID;
  let tlm: Mat = ID;
  let font: Font | undefined;
  let size = 10;
  let leading = 0;
  let tc = 0;
  let tw = 0;
  let th = 1;
  let args: Tok[] = [];
  const show = (raw: string) => {
    const { text, width } = decodeStr(raw, font);
    const m = mul(tm, ctm);
    const scale = Math.hypot(m[2], m[3]) || 1;
    const fs = size * scale;
    const spaces = (text.match(/ /g) ?? []).length;
    const adv = ((width / 1000) * size + tc * text.length + tw * spaces) * th;
    if (text.trim()) runs.push({ x: m[4], y: m[5], end: m[4] + adv * Math.hypot(m[0], m[1]), size: fs, text });
    tm = mul([1, 0, 0, 1, adv, 0], tm);
  };
  const nl = () => {
    tlm = mul([1, 0, 0, 1, 0, -leading], tlm);
    tm = tlm;
  };
  const n = (k: number) => {
    const t = args[args.length - k];
    return t && t.t === 'num' ? t.v : 0;
  };
  for (const tok of toks) {
    if (tok.t !== 'op') {
      args.push(tok);
      continue;
    }
    switch (tok.v) {
      case 'q':
        gstack.push(ctm);
        break;
      case 'Q':
        ctm = gstack.pop() ?? ctm0;
        break;
      case 'cm':
        ctm = mul([n(6), n(5), n(4), n(3), n(2), n(1)], ctm);
        break;
      case 'BT':
        tm = ID;
        tlm = ID;
        break;
      case 'Tf': {
        const name = args[args.length - 2];
        if (name?.t === 'name') font = fonts.get(name.v);
        size = n(1) || size;
        break;
      }
      case 'Tc':
        tc = n(1);
        break;
      case 'Tw':
        tw = n(1);
        break;
      case 'Tz':
        th = n(1) / 100;
        break;
      case 'TL':
        leading = n(1);
        break;
      case 'Td':
        tlm = mul([1, 0, 0, 1, n(2), n(1)], tlm);
        tm = tlm;
        break;
      case 'TD':
        leading = -n(1);
        tlm = mul([1, 0, 0, 1, n(2), n(1)], tlm);
        tm = tlm;
        break;
      case 'Tm':
        tlm = [n(6), n(5), n(4), n(3), n(2), n(1)];
        tm = tlm;
        break;
      case 'T*':
        nl();
        break;
      case 'Tj': {
        const s = args[args.length - 1];
        if (s?.t === 'str') show(s.v);
        break;
      }
      case "'": {
        nl();
        const s = args[args.length - 1];
        if (s?.t === 'str') show(s.v);
        break;
      }
      case '"': {
        tw = n(3);
        tc = n(2);
        nl();
        const s = args[args.length - 1];
        if (s?.t === 'str') show(s.v);
        break;
      }
      case 'TJ': {
        const a = args[args.length - 1];
        if (a?.t === 'arr') {
          for (const el of a.v) {
            if (el.t === 'str') show(el.v);
            else if (el.t === 'num') tm = mul([1, 0, 0, 1, (-el.v / 1000) * size * th, 0], tm);
          }
        }
        break;
      }
      case 'Do': {
        const name = args[args.length - 1];
        if (depth < 3 && name?.t === 'name') {
          const xo = res?.lookup(PDFName.of('XObject'));
          const x = xo instanceof PDFDict ? xo.lookup(PDFName.of(name.v)) : undefined;
          if (x instanceof PDFStream) {
            const st = x.dict.lookup(PDFName.of('Subtype'));
            if (st instanceof PDFName && st.asString() === '/Form') {
              const b = streamBytes(x);
              const mx = x.dict.lookup(PDFName.of('Matrix'));
              const m: Mat = mx instanceof PDFArray && mx.size() === 6 ? (Array.from({ length: 6 }, (_, k) => num(mx.lookup(k)) ?? 0) as Mat) : ID;
              const r = x.dict.lookup(PDFName.of('Resources'));
              if (b) runContent(b, r instanceof PDFDict ? r : res, mul(m, ctm), runs, cache, depth + 1);
            }
          }
        }
        break;
      }
    }
    args = [];
  }
}

/** Runs på samme højde samles til én linje; store spring bliver til to mellemrum (kolonner). */
function toLines(runs: Run[]): string[] {
  const sorted = [...runs].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: Run[][] = [];
  for (const r of sorted) {
    const row = rows.find((x) => Math.abs(x[0]!.y - r.y) <= Math.max(1.5, r.size * 0.3));
    if (row) row.push(r);
    else rows.push([r]);
  }
  rows.sort((a, b) => b[0]!.y - a[0]!.y);
  return rows.map((row) => {
    row.sort((a, b) => a.x - b.x);
    let line = '';
    let prevEnd: number | null = null;
    for (const r of row) {
      if (prevEnd !== null) {
        const gap = r.x - prevEnd;
        if (gap > r.size * 1.2) line += '  ';
        else if (gap > r.size * 0.15 && !line.endsWith(' ') && !r.text.startsWith(' ')) line += ' ';
      }
      line += r.text;
      prevEnd = r.end;
    }
    return line.replace(/\s+$/, '');
  });
}

export interface PdfText {
  pages: string[][];
  /** false = ingen læsbar tekst (fx et indskannet dokument) */
  hasText: boolean;
}

export async function pdfText(bytes: Uint8Array, maxPages = 20): Promise<PdfText> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    return { pages: [], hasText: false };
  }
  const cache = new Map<string, Font>();
  const pages: string[][] = [];
  for (const page of doc.getPages().slice(0, maxPages)) {
    const runs: Run[] = [];
    try {
      const contents = page.node.Contents();
      const list: PDFObject[] = contents instanceof PDFArray ? Array.from({ length: contents.size() }, (_, i) => contents.lookup(i)).filter((o): o is PDFObject => !!o) : contents ? [contents] : [];
      const parts = list.map((s) => streamBytes(s)).filter((b): b is Uint8Array => !!b);
      const all = new Uint8Array(parts.reduce((a, b) => a + b.length + 1, 0));
      let at = 0;
      for (const p of parts) {
        all.set(p, at);
        all[at + p.length] = 10;
        at += p.length + 1;
      }
      runContent(all, page.node.Resources(), ID, runs, cache, 0);
    } catch {
      // En side, der ikke kan læses, springes over
    }
    pages.push(toLines(runs));
  }
  const hasText = pages.some((p) => p.join('').replace(/\s/g, '').length > 20);
  return { pages, hasText };
}

