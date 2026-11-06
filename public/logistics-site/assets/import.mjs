import { CalculationError, MAX_ABC_ROWS, abc, parseNumber } from './calculations.mjs';

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const DELIMITERS = ['\t', ';', ','];
const error = (code, message, line = 0) => ({ code, message, line });

function parseRecords(text, delimiter) {
  if (typeof text !== 'string' || !text.trim()) throw new CalculationError('empty_import', '', 'Indsæt en vareliste eller vælg en CSV-fil.');
  if (new TextEncoder().encode(text).length > MAX_IMPORT_BYTES) throw new CalculationError('file_too_large', '', 'Filen må højst være 2 MB.');
  if (!DELIMITERS.includes(delimiter)) throw new CalculationError('delimiter', '', 'Vælg semikolon, komma eller tabulator.');
  text = text.replace(/^\uFEFF/, '');
  const records = [];
  let cells = [], cell = '', quoted = false, closed = false, line = 1, recordLine = 1;
  const addCell = () => { cells.push(cell); cell = ''; closed = false; };
  const addRecord = () => {
    addCell();
    if (cells.some(value => value.trim() !== '')) records.push({ cells, line: recordLine });
    cells = [];
    if (records.length > MAX_ABC_ROWS + 1) throw new CalculationError('row_count', '', `Der kan højst importeres ${MAX_ABC_ROWS} varer ad gangen.`);
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { cell += '"'; index++; }
        else { quoted = false; closed = true; }
      } else {
        if (char === '\r' && text[index + 1] === '\n') { cell += '\n'; index++; line++; }
        else { cell += char; if (char === '\n' || char === '\r') line++; }
      }
    } else if (char === delimiter) {
      addCell();
    } else if (char === '\r' || char === '\n') {
      addRecord();
      if (char === '\r' && text[index + 1] === '\n') index++;
      line++;
      recordLine = line;
    } else if (char === '"') {
      if (cell.trim() || closed) throw new CalculationError('csv_quotes', '', `Uventet anførselstegn på linje ${line}. Sæt hele feltet i anførselstegn.`);
      cell = '';
      quoted = true;
    } else if (closed) {
      if (char !== ' ' && char !== '\t') throw new CalculationError('csv_quotes', '', `Der står tekst efter et afsluttende anførselstegn på linje ${line}.`);
    } else {
      cell += char;
    }
    if (cell.length > 10000 || cells.length > 20) throw new CalculationError('invalid_columns', '', 'Brug tre kolonner: vare, årligt antal og pris pr. enhed.');
  }
  if (quoted) throw new CalculationError('csv_quotes', '', `Et anførselstegn mangler at blive afsluttet (fra linje ${recordLine}).`);
  if (cell || cells.length || closed) addRecord();
  return records;
}

/** RFC-style quoted fields, escaped quotes, CRLF/LF and quoted line breaks. */
export function parseDelimited(text, delimiter = ';') {
  return parseRecords(text, delimiter).map(record => record.cells);
}

function findDelimiter(text) {
  // Validate resource/empty-input bounds once, rather than hiding them as a
  // failed delimiter guess. Parsing itself remains strict for each candidate.
  if (typeof text !== 'string' || !text.trim()) throw new CalculationError('empty_import', '', 'Indsæt en vareliste eller vælg en CSV-fil.');
  if (new TextEncoder().encode(text).length > MAX_IMPORT_BYTES) throw new CalculationError('file_too_large', '', 'Filen må højst være 2 MB.');
  let firstProblem;
  const candidates = DELIMITERS.flatMap(delimiter => {
    try {
      const records = parseRecords(text, delimiter);
      if (!records.length) return [];
      const sample = records.slice(0, 10);
      const valid = sample.filter(record => record.cells.length === 3).length;
      const multicolumn = sample.filter(record => record.cells.length > 1).length;
      return valid ? [{ delimiter, score: valid / sample.length * 100 + multicolumn / sample.length, records }] : [];
    } catch (problem) { firstProblem ??= problem; return []; }
  }).sort((a, b) => b.score - a.score);
  if (!candidates.length) {
    if (firstProblem instanceof CalculationError && ['row_count', 'csv_quotes'].includes(firstProblem.code)) throw firstProblem;
    throw new CalculationError('delimiter', '', 'Kunne ikke finde tre kolonner. Vælg separatoren, eller brug vare;antal;pris.');
  }
  if (candidates[1]?.score === candidates[0].score) throw new CalculationError('ambiguous_delimiter', '', 'Separatoren er tvetydig. Vælg semikolon, komma eller tabulator.');
  return candidates[0];
}

const normalizeHeader = value => value.trim().toLocaleLowerCase('da').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zæø0-9]/g, '');
const HEADER_NAMES = [
  new Set(['vare', 'varenavn', 'varenummer', 'varenrellernavn', 'navn', 'produkt', 'produktnavn', 'sku', 'item', 'itemname', 'product', 'name', 'id']),
  new Set(['antal', 'arligtantal', 'arligtforbrug', 'forbrug', 'arligtforbrugiantal', 'arforbrug', 'mængde', 'arligmængde', 'annualquantity', 'annualdemand', 'quantity', 'demand']),
  new Set(['pris', 'enhedspris', 'indkøbspris', 'indkøbsprisprenhed', 'prisprenhed', 'unitcost', 'unitprice', 'price', 'cost']),
];
function isHeader(cells) {
  return cells.length === 3 && cells.every((value, index) => HEADER_NAMES[index].has(normalizeHeader(value)));
}

/**
 * Explicit da/en format is mandatory. No data is ready to apply until canImport.
 * Preview preserves original text next to parsed numeric values.
 */
export function previewImport(text, options = {}) {
  const format = options.format;
  const result = { items: [], rows: [], errors: [], warnings: [], delimiter: options.delimiter ?? 'auto', format, header: false, canImport: false };
  if (format !== 'da' && format !== 'en') {
    result.errors.push(error('format_required', 'Vælg dansk eller engelsk talformat, og kontrollér forhåndsvisningen.'));
    return result;
  }
  if (![true, false, 'auto', undefined].includes(options.header)) {
    result.errors.push(error('header_choice', 'Vælg, om første række er kolonneoverskrifter.'));
    return result;
  }
  try {
    let records;
    if (!options.delimiter || options.delimiter === 'auto') {
      const detected = findDelimiter(text);
      result.delimiter = detected.delimiter;
      records = detected.records;
    } else records = parseRecords(text, options.delimiter);
    result.header = options.header === true || ((options.header === 'auto' || options.header === undefined) && isHeader(records[0]?.cells ?? []));
    if (result.header) records = records.slice(1);
    if (!records.length) throw new CalculationError('empty_import', '', 'Der er ingen varer under kolonneoverskrifterne.');
    if (records.length > MAX_ABC_ROWS) throw new CalculationError('row_count', '', `Der kan højst importeres ${MAX_ABC_ROWS} varer ad gangen.`);
    let ambiguous = false;
    for (const record of records) {
      const entry = { line: record.line, raw: record.cells, item: null, error: null };
      try {
        if (record.cells.length !== 3) throw new CalculationError('invalid_columns', '', 'Rækken skal have præcis tre kolonner: vare, årligt antal og pris pr. enhed.');
        const [rawName, rawQuantity, rawPrice] = record.cells;
        const item = { name: rawName.trim().replace(/\s+/g, ' '), annualQuantity: parseNumber(rawQuantity, format), unitCost: parseNumber(rawPrice, format) };
        // The same bounds and label checks apply to manual entry and imports.
        abc({ items: [item], thresholdA: 80, thresholdB: 95 });
        if ([rawQuantity, rawPrice].some(value => /^[+-]?\d{1,3}[.,]\d{3}$/.test(value.trim()))) ambiguous = true;
        entry.item = item;
        result.items.push(item);
      } catch (problem) {
        entry.error = problem instanceof CalculationError ? problem.message : 'Rækken kunne ikke læses.';
        result.errors.push(error(problem instanceof CalculationError ? problem.code : 'invalid_input', entry.error, record.line));
      }
      result.rows.push(entry);
    }
    if (ambiguous) result.warnings.push(format === 'da' ?
      'Tal med ét skilletegn og tre efterfølgende cifre kan betyde forskellige ting. Dansk format er valgt: 1.234 betyder 1234, og 1,234 betyder 1,234. Kontrollér de aflæste værdier.' :
      'Tal med ét skilletegn og tre efterfølgende cifre kan betyde forskellige ting. Engelsk format er valgt: 1,234 betyder 1234, og 1.234 betyder 1,234. Kontrollér de aflæste værdier.');
    if (new Set(result.items.map(item => item.name.toLocaleLowerCase('da'))).size < result.items.length) result.warnings.push('Flere varer har samme navn. De bevares som selvstændige rækker; kontrollér, at de ikke er dubletter.');
    result.canImport = result.errors.length === 0 && result.items.length > 0;
  } catch (problem) {
    result.errors.push(error(problem instanceof CalculationError ? problem.code : 'invalid_input', problem instanceof CalculationError ? problem.message : 'Listen kunne ikke læses.'));
  }
  return result;
}

export const parseImport = previewImport;

/** Excel-friendly UTF-8 CSV. Text is neutralized against spreadsheet formulas. */
export function exportABC(result) {
  const escapeCell = value => {
    let text = String(value ?? '');
    if (/^[\s]*[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  const numericCell = value => String(value).replace('.', ',');
  const headers = ['Vare', 'Årligt antal', 'Pris pr. enhed', 'Årlig forbrugsværdi', 'Andel (%)', 'Kumuleret (%)', 'Klasse'];
  const lines = [headers.map(escapeCell).join(';')];
  for (const item of result.items) lines.push([
    escapeCell(item.name), numericCell(item.annualQuantity), numericCell(item.unitCost), numericCell(item.annualValue),
    numericCell(item.sharePercent), numericCell(item.cumulativePercent), escapeCell(item.class),
  ].join(';'));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
