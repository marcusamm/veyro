// Browserkode til produktkataloget: forslag mens der skrives, og import af CSV- og Excel-filer.
// Filen læses i browseren (Workers' CPU-grænse), og rækkerne sendes i bidder til serveren, som
// normaliserer, finder dubletter og viser en forhåndsvisning, før noget ændres i kataloget.

export const KATALOG_JS = String.raw`(function () {
  'use strict';

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  // --- Forslag mens der skrives -------------------------------------------------------------
  document.querySelectorAll('input[data-katalog-suggest]').forEach(function (input) {
    var list = document.getElementById(input.getAttribute('aria-controls'));
    var form = input.form;
    if (!list || !form) return;
    var timer = 0, seq = 0, active = -1;
    function items() { return list.querySelectorAll('li[role=option]'); }
    function hide() { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; }
    function mark(i) {
      var all = items();
      all.forEach(function (li, k) { li.setAttribute('aria-selected', k === i ? 'true' : 'false'); });
      active = i;
      if (all[i]) all[i].scrollIntoView({ block: 'nearest' });
    }
    function show(data) {
      list.textContent = '';
      if (!data.hits.length) {
        list.appendChild(el('li', 'more', 'Ingen varer fundet. Tryk Enter for at søge, eller opret varen manuelt.'));
      } else {
        data.hits.forEach(function (h, i) {
          var li = el('li');
          li.setAttribute('role', 'option');
          li.id = 'katalog-forslag-' + i;
          var a = el('a');
          a.href = h.href;
          a.appendChild(el('strong', '', h.name));
          if (h.demo) { a.appendChild(document.createTextNode(' ')); a.appendChild(el('span', 'tag tag-off', 'Demodata')); }
          if (h.detail) a.appendChild(el('small', '', h.detail));
          a.appendChild(el('small', '', h.codes));
          a.appendChild(el('small', '', [h.unit, h.stock, h.price].filter(Boolean).join(' · ')));
          li.appendChild(a);
          list.appendChild(li);
        });
        if (data.total > data.hits.length) list.appendChild(el('li', 'more', data.total.toLocaleString('da-DK') + ' varer i alt. Tryk Enter for at se alle.'));
      }
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      active = -1;
    }
    function fetchHits() {
      var q = input.value.trim();
      if (q.length < 2) { hide(); return; }
      var p = new URLSearchParams({ q: q, ctx: input.dataset.ctx || 'portal', job: input.dataset.job || '', n: '8' });
      var maker = form.querySelector('[name=producent]'), cat = form.querySelector('[name=kategori]');
      if (maker && maker.value) p.set('producent', maker.value);
      if (cat && cat.value) p.set('kategori', cat.value);
      var my = ++seq;
      fetch('/katalog/sog?' + p.toString(), { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) { if (data && my === seq && document.activeElement === input) show(data); })
        .catch(function () {});
    }
    input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(fetchHits, 180); });
    input.addEventListener('keydown', function (e) {
      var all = items();
      if (e.key === 'ArrowDown' && all.length) { e.preventDefault(); if (list.hidden) fetchHits(); mark(Math.min(active + 1, all.length - 1)); }
      else if (e.key === 'ArrowUp' && all.length) { e.preventDefault(); mark(Math.max(active - 1, 0)); }
      else if (e.key === 'Enter' && active >= 0 && all[active]) { e.preventDefault(); location.href = all[active].querySelector('a').href; }
      else if (e.key === 'Escape') hide();
    });
    input.addEventListener('blur', function () { setTimeout(hide, 150); });
    form.querySelectorAll('[data-katalog-filter]').forEach(function (s) { s.addEventListener('change', function () { form.submit(); }); });
  });

  // --- Import -------------------------------------------------------------------------------
  var form = document.getElementById('katalog-import');
  if (!form) return;

  var FIELDS = JSON.parse(form.dataset.fields || '[]');
  var SOURCES = JSON.parse(form.dataset.sources || '[]');
  var csrf = form.dataset.csrf;
  var $ = function (s) { return form.querySelector(s); };
  var sourceSel = $('#imp_source'), fileIn = $('#imp_file'), sheetSel = $('#imp_sheet'), headerIn = $('#imp_header');
  var mapBody = $('[data-mapping]'), sample = $('[data-sample]'), progress = $('[data-progress]'), errBox = $('[data-error]'), startBtn = $('[data-start]');
  var book = null; // { name, sheets: [{ name, rows: [[cell]] }] }, en celle er { v: tekst, n: tal? }

  // Danske, engelske og tyske kolonnenavne (sammenlignes uden mellemrum og tegn)
  var ALIASES = {
    manufacturer: ['producent', 'fabrikant', 'manufacturer', 'brand', 'maerke', 'mærke', 'hersteller', 'marke', 'marke'],
    mpn: ['varenummer', 'varenr', 'producentvarenummer', 'producentensvarenummer', 'producentnr', 'producentnummer', 'artikelnummer', 'artikelnr', 'artnr', 'itemnumber', 'itemno', 'articlenumber', 'articleno', 'partnumber', 'partno', 'mpn', 'materialnummer', 'herstellerartikelnummer', 'katalognummer'],
    dealer_sku: ['forhandlervarenummer', 'forhandlerensvarenummer', 'forhandlernr', 'lavnr', 'vvsnr', 'elnr', 'dealersku', 'suppliersku', 'leverandørvarenummer'],
    ean: ['ean', 'gtin', 'ean13', 'eannummer', 'eannr', 'eancode', 'eankode', 'barcode', 'stregkode', 'gtin13', 'gtin14'],
    name: ['produktnavn', 'varenavn', 'navn', 'betegnelse', 'varebetegnelse', 'name', 'productname', 'title', 'titel', 'artikelbezeichnung', 'bezeichnung', 'kurztext', 'produktbezeichnung'],
    description: ['beskrivelse', 'varebeskrivelse', 'description', 'longdescription', 'langtext', 'beschreibung', 'produktbeschreibung'],
    category: ['kategori', 'varegruppe', 'gruppe', 'category', 'productgroup', 'produktgruppe', 'warengruppe', 'sortiment'],
    variant: ['variant', 'udførelse', 'udforelse', 'ausfuhrung', 'ausführung', 'version', 'farve', 'color', 'colour', 'farbe', 'type'],
    dimensions: ['mål', 'maal', 'dimension', 'dimensioner', 'dimensions', 'størrelse', 'storrelse', 'size', 'abmessung', 'abmessungen', 'nennweite', 'dimensionen'],
    material: ['materiale', 'material', 'werkstoff'],
    unit: ['enhed', 'salgsenhed', 'unit', 'uom', 'einheit', 'mengeneinheit', 'basiseinheit'],
    pack_size: ['pakning', 'pakkestørrelse', 'pakkestorrelse', 'pakkeantal', 'emballage', 'packsize', 'packaging', 'package', 'verpackungseinheit', 've', 'kolli'],
    url: ['link', 'url', 'produktlink', 'weblink', 'productlink', 'productpage', 'produktseite'],
    price: ['pris', 'listepris', 'vejledendepris', 'bruttopris', 'nettopris', 'price', 'listprice', 'preis', 'listenpreis', 'bruttopreis', 'nettopreis'],
    currency: ['valuta', 'currency', 'währung', 'wahrung'],
    vat: ['moms', 'momsgrundlag', 'vat', 'mwst', 'tax'],
    price_per: ['prispr', 'prisenhed', 'priceper', 'priceunit', 'preiseinheit', 'preisper'],
    source_updated: ['opdateret', 'senestopdateret', 'dato', 'updated', 'lastupdated', 'date', 'stand', 'gueltigab', 'gültigab', 'gyldigfra']
  };
  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9æøåäöü]/g, ''); }

  function setError(msg) { errBox.textContent = msg || ''; errBox.hidden = !msg; }
  function setBusy(b, msg) { startBtn.disabled = b; progress.textContent = msg || ''; }

  function source() { return SOURCES.find(function (s) { return String(s.id) === sourceSel.value; }) || null; }
  function savedMapping() {
    var s = source();
    if (!s || !s.mapping) return null;
    try { var m = JSON.parse(s.mapping); return m && m.columns ? m : null; } catch (e) { return null; }
  }
  function onSource() {
    form.querySelector('[data-new-source]').hidden = sourceSel.value !== 'ny';
    var m = savedMapping();
    if (m) {
      if (m.currency !== undefined) $('#imp_currency').value = m.currency;
      if (m.vat) $('#imp_vat').value = m.vat;
      if (m.price_type) $('#imp_ptype').value = m.price_type;
      if (m.header_row) headerIn.value = m.header_row;
    }
    if (book) { pickSavedSheet(); renderMapping(true); }
  }
  sourceSel.addEventListener('change', onSource);

  // --- CSV ---
  function decode(buf) {
    var bytes = new Uint8Array(buf);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, ''); }
    catch (e) { return new TextDecoder('windows-1252').decode(bytes); }
  }
  function detectDelimiter(text) {
    var line = text.split(/\r?\n/).slice(0, 5).join('\n'), best = ';', bestN = -1;
    [';', '\t', ',', '|'].forEach(function (d) {
      var n = 0, q = false;
      for (var i = 0; i < line.length; i++) { var ch = line[i]; if (ch === '"') q = !q; else if (ch === d && !q) n++; }
      if (n > bestN) { best = d; bestN = n; }
    });
    return best;
  }
  function parseCsv(text) {
    var d = detectDelimiter(text), rows = [], row = [], cell = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"' && cell === '') q = true;
      else if (ch === d) { row.push({ v: cell }); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push({ v: cell }); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push({ v: cell }); rows.push(row); }
    return rows;
  }

  // --- XLSX (ZIP med XML) ---
  function u16(dv, o) { return dv.getUint16(o, true); }
  function u32(dv, o) { return dv.getUint32(o, true); }
  function unzip(buf) {
    var dv = new DataView(buf), eocd = -1;
    for (var i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) { if (u32(dv, i) === 0x06054b50) { eocd = i; break; } }
    if (eocd < 0) throw new Error('Filen er ikke en gyldig Excel-fil (.xlsx).');
    var n = u16(dv, eocd + 10), off = u32(dv, eocd + 16), files = {};
    var dec = new TextDecoder('utf-8');
    for (var k = 0; k < n; k++) {
      if (u32(dv, off) !== 0x02014b50) break;
      var method = u16(dv, off + 10), csize = u32(dv, off + 20), nl = u16(dv, off + 28), el2 = u16(dv, off + 30), cl = u16(dv, off + 32), loc = u32(dv, off + 42);
      var name = dec.decode(new Uint8Array(buf, off + 46, nl));
      files[name] = { method: method, csize: csize, loc: loc };
      off += 46 + nl + el2 + cl;
    }
    return {
      has: function (name) { return !!files[name]; },
      text: function (name) {
        var f = files[name];
        if (!f) return Promise.resolve(null);
        var start = f.loc + 30 + u16(dv, f.loc + 26) + u16(dv, f.loc + 28);
        var data = new Uint8Array(buf, start, f.csize);
        if (f.method === 0) return Promise.resolve(dec.decode(data));
        if (f.method !== 8) return Promise.reject(new Error('Excel-filen bruger en komprimering, der ikke understøttes.'));
        if (typeof DecompressionStream === 'undefined') return Promise.reject(new Error('Browseren kan ikke læse Excel-filer. Gem filen som CSV, eller brug en nyere browser.'));
        var stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Response(stream).text();
      }
    };
  }
  function xml(text) { return new DOMParser().parseFromString(text, 'application/xml'); }
  function tags(node, name) { return Array.prototype.slice.call(node.getElementsByTagNameNS('*', name)); }
  function textOf(node) { return tags(node, 't').map(function (t) { return t.textContent; }).join(''); }
  function colIndex(ref) {
    var m = /^([A-Z]+)/.exec(ref || ''), n = 0;
    if (!m) return -1;
    for (var i = 0; i < m[1].length; i++) n = n * 26 + (m[1].charCodeAt(i) - 64);
    return n - 1;
  }
  function readXlsx(buf) {
    var z = unzip(buf);
    return Promise.all([z.text('xl/workbook.xml'), z.text('xl/_rels/workbook.xml.rels'), z.text('xl/sharedStrings.xml')]).then(function (r) {
      if (!r[0]) throw new Error('Filen er ikke en gyldig Excel-fil (.xlsx).');
      var rels = {};
      if (r[1]) tags(xml(r[1]), 'Relationship').forEach(function (x) { rels[x.getAttribute('Id')] = x.getAttribute('Target'); });
      var shared = r[2] ? tags(xml(r[2]), 'si').map(textOf) : [];
      var sheets = tags(xml(r[0]), 'sheet').map(function (s) {
        var rid = s.getAttribute('r:id') || s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
        var t = rels[rid] || '';
        var path = t.charAt(0) === '/' ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
        return { name: s.getAttribute('name'), path: path };
      });
      return Promise.all(sheets.map(function (s) { return z.text(s.path); })).then(function (texts) {
        return sheets.map(function (s, i) {
          var rows = [];
          if (texts[i]) tags(xml(texts[i]), 'row').forEach(function (rowEl) {
            var rn = parseInt(rowEl.getAttribute('r'), 10) || rows.length + 1, row = [];
            tags(rowEl, 'c').forEach(function (c, k) {
              var idx = colIndex(c.getAttribute('r')); if (idx < 0) idx = k;
              var t = c.getAttribute('t'), vEl = tags(c, 'v')[0], v = vEl ? vEl.textContent : '', cell;
              if (t === 's') cell = { v: shared[parseInt(v, 10)] || '' };
              else if (t === 'inlineStr') cell = { v: textOf(c) };
              else if (t === 'str' || t === 'e') cell = { v: v };
              else if (t === 'b') cell = { v: v === '1' ? 'Ja' : 'Nej' };
              else if (v !== '' && isFinite(Number(v))) {
                var num = Number(v);
                cell = { v: /e/i.test(v) && Number.isInteger(num) ? num.toFixed(0) : v, n: num };
              } else cell = { v: v };
              row[idx] = cell;
            });
            for (var j = 0; j < row.length; j++) if (!row[j]) row[j] = { v: '' };
            rows[rn - 1] = row;
          });
          for (var j2 = 0; j2 < rows.length; j2++) if (!rows[j2]) rows[j2] = [];
          return { name: s.name, rows: rows };
        });
      });
    });
  }

  function filled(row) { return (row || []).filter(function (c) { return c && String(c.v).trim() !== ''; }).length; }
  function sheet() { return book ? book.sheets[Math.max(0, sheetSel.selectedIndex)] || book.sheets[0] : null; }
  function headerRow() { return Math.max(1, parseInt(headerIn.value, 10) || 1); }
  function headers() {
    var sh = sheet(); if (!sh) return [];
    var seen = {};
    return (sh.rows[headerRow() - 1] || []).map(function (c, i) {
      var h = String(c && c.v || '').trim() || ('Kolonne ' + (i + 1));
      if (seen[h]) h = h + ' (' + (i + 1) + ')';
      seen[h] = true;
      return h;
    });
  }
  function dataRows() {
    var sh = sheet(), out = [];
    if (!sh) return out;
    for (var i = headerRow(); i < sh.rows.length; i++) if (filled(sh.rows[i])) out.push({ row_no: i + 1, cells: sh.rows[i] });
    return out;
  }
  function guessHeader(sh) {
    for (var i = 0; i < Math.min(sh.rows.length, 30); i++) if (filled(sh.rows[i]) >= 3) return i + 1;
    return 1;
  }
  function pickSavedSheet() {
    var m = savedMapping();
    if (m && m.sheet && book.sheets.length > 1) {
      var i = book.sheets.findIndex(function (s) { return s.name === m.sheet; });
      if (i >= 0) { sheetSel.selectedIndex = i; headerIn.value = m.header_row || guessHeader(book.sheets[i]); }
    }
  }

  function autoMap(hs) {
    var used = {}, map = {}, saved = savedMapping();
    if (saved) Object.keys(saved.columns).forEach(function (f) { var col = saved.columns[f]; if (hs.indexOf(col) >= 0 && !used[col]) { map[f] = col; used[col] = true; } });
    var nh = hs.map(norm);
    FIELDS.forEach(function (f) {
      if (map[f.key]) return;
      var al = (ALIASES[f.key] || []).map(norm);
      var i = nh.findIndex(function (h, k) { return !used[hs[k]] && al.indexOf(h) >= 0; });
      if (i < 0) i = nh.findIndex(function (h, k) { return !used[hs[k]] && h.length > 2 && al.some(function (a) { return a.length > 3 && h.indexOf(a) === 0; }); });
      if (i >= 0) { map[f.key] = hs[i]; used[hs[i]] = true; }
    });
    return map;
  }
  function currentMap() {
    var map = {};
    mapBody.querySelectorAll('select[data-field]').forEach(function (s) { if (s.value) map[s.dataset.field] = s.value; });
    return map;
  }
  function renderMapping(auto) {
    var hs = headers(), prev = auto ? autoMap(hs) : currentMap(), rows = dataRows(), first = rows[0];
    mapBody.textContent = '';
    FIELDS.forEach(function (f) {
      var tr = el('tr'), sel = el('select');
      sel.dataset.field = f.key;
      sel.setAttribute('aria-label', 'Kolonne til ' + f.label);
      var none = el('option', '', '– ikke i filen –'); none.value = ''; sel.appendChild(none);
      hs.forEach(function (h) { var o = el('option', '', h); o.value = h; if (prev[f.key] === h) o.selected = true; sel.appendChild(o); });
      var ex = el('td', 'xs muted');
      function upd() { var i = hs.indexOf(sel.value); ex.textContent = i >= 0 && first && first.cells[i] ? String(first.cells[i].v).slice(0, 60) : ''; }
      sel.addEventListener('change', function () { upd(); renderSample(); });
      upd();
      var lab = el('td', '', f.label);
      if (f.key === 'name' || f.key === 'mpn' || f.key === 'ean') lab.appendChild(el('small', '', f.key === 'name' ? 'Skal udfyldes' : 'Varenummer og/eller EAN skal udfyldes'));
      var td = el('td'); td.appendChild(sel);
      tr.appendChild(lab); tr.appendChild(td); tr.appendChild(ex);
      mapBody.appendChild(tr);
    });
    renderSample();
  }
  function renderSample() {
    var hs = headers(), map = currentMap(), keys = FIELDS.filter(function (f) { return map[f.key]; });
    var rows = dataRows().slice(0, 5);
    sample.textContent = '';
    if (!keys.length) { sample.appendChild(el('p', 'muted', 'Kobl mindst produktnavn og varenummer eller EAN.')); return; }
    var t = el('table', 'list dense mini'), head = el('tr');
    head.appendChild(el('th', '', 'Række'));
    keys.forEach(function (f) { head.appendChild(el('th', '', f.label)); });
    var thead = el('thead'); thead.appendChild(head); t.appendChild(thead);
    var tb = el('tbody');
    rows.forEach(function (r) {
      var tr = el('tr'); tr.appendChild(el('td', 'num', String(r.row_no)));
      keys.forEach(function (f) { var i = hs.indexOf(map[f.key]); var v = i >= 0 && r.cells[i] ? String(r.cells[i].v) : ''; var td = el('td', 'xs', v === '' ? 'Ukendt' : v.slice(0, 80)); if (v === '') td.className += ' muted'; tr.appendChild(td); });
      tb.appendChild(tr);
    });
    t.appendChild(tb); sample.appendChild(t);
  }

  function showBook() {
    sheetSel.textContent = '';
    var best = 0;
    book.sheets.forEach(function (s, i) {
      var n = s.rows.filter(filled).length;
      var o = el('option', '', s.name + ' (' + n.toLocaleString('da-DK') + ' rækker)'); o.value = s.name; sheetSel.appendChild(o);
      if (n > book.sheets[best].rows.filter(filled).length) best = i;
    });
    sheetSel.selectedIndex = best;
    headerIn.value = guessHeader(book.sheets[best]);
    pickSavedSheet();
    form.querySelector('[data-sheet-field]').hidden = book.sheets.length < 2;
    form.querySelectorAll('[data-after-file]').forEach(function (x) { x.hidden = false; });
    form.querySelector('[data-file-info]').textContent = book.name + ': ' + dataRows().length.toLocaleString('da-DK') + ' rækker med data' + (book.sheets.length > 1 ? ' i det valgte faneblad.' : '.');
    renderMapping(true);
  }
  sheetSel.addEventListener('change', function () { headerIn.value = guessHeader(sheet()); renderMapping(true); showInfo(); });
  headerIn.addEventListener('change', function () { renderMapping(true); showInfo(); });
  function showInfo() { form.querySelector('[data-file-info]').textContent = book.name + ': ' + dataRows().length.toLocaleString('da-DK') + ' rækker med data.'; }

  fileIn.addEventListener('change', function () {
    var f = fileIn.files && fileIn.files[0];
    setError('');
    if (!f) return;
    if (f.size > 50 * 1024 * 1024) { setError('Filen er større end 50 MB. Del den op, eller kontakt Veyro.'); return; }
    setBusy(true, 'Læser filen …');
    f.arrayBuffer().then(function (buf) {
      var head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
      var isZip = head[0] === 0x50 && head[1] === 0x4b;
      if (/\.xls$/i.test(f.name) && !isZip) throw new Error('Gamle Excel-filer (.xls) kan ikke læses. Gem filen som .xlsx eller CSV.');
      return isZip ? readXlsx(buf) : [{ name: 'CSV', rows: parseCsv(decode(buf)) }];
    }).then(function (sheets) {
      if (!sheets.length || !sheets.some(function (s) { return s.rows.some(filled); })) throw new Error('Filen er tom.');
      book = { name: f.name, sheets: sheets };
      showBook();
      setBusy(false, '');
    }).catch(function (e) { setBusy(false, ''); setError(e.message || 'Filen kunne ikke læses.'); });
  });

  function post(url, data) {
    var fd = new FormData();
    fd.append('_csrf', csrf);
    Object.keys(data).forEach(function (k) { fd.append(k, data[k]); });
    return fetch(url, { method: 'POST', body: fd, credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(function (r) {
      return r.json().catch(function () { return { error: 'Serveren svarede uventet (' + r.status + '). Genindlæs siden og prøv igen.' }; }).then(function (j) {
        if (!r.ok || j.error) throw new Error(j.error || 'Fejl ' + r.status);
        return j;
      });
    });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    setError('');
    if (!book) { setError('Vælg en fil.'); return; }
    var hs = headers(), map = currentMap(), rows = dataRows();
    if (!rows.length) { setError('Der er ingen rækker under overskrifterne.'); return; }
    var mapping = {
      columns: map, sheet: book.sheets.length > 1 ? sheet().name : '', header_row: headerRow(),
      manufacturer: sourceSel.value === 'ny' ? $('#imp_maker').value.trim() : '',
      currency: $('#imp_currency').value, vat: $('#imp_vat').value, price_type: $('#imp_ptype').value
    };
    var idx = {};
    Object.keys(map).forEach(function (k) { idx[k] = hs.indexOf(map[k]); });
    var payload = rows.map(function (r) {
      var values = {};
      Object.keys(idx).forEach(function (k) {
        var c = r.cells[idx[k]];
        if (!c) { values[k] = ''; return; }
        // Talceller fra Excel sendes med punktum som decimaltegn og fire decimaler, så 1.5 ikke læses som 15
        values[k] = k === 'price' && typeof c.n === 'number' ? c.n.toFixed(4) : String(c.v).trim();
      });
      return { row_no: r.row_no, values: values };
    });
    setBusy(true, 'Opretter importen …');
    post('/lager/katalog/import', {
      source_id: sourceSel.value, new_name: $('#imp_name').value, new_kind: $('#imp_kind').value, new_manufacturer: $('#imp_maker').value,
      filename: book.name + (book.sheets.length > 1 ? ' (' + sheet().name + ')' : ''), mapping: JSON.stringify(mapping)
    }).then(function (res) {
      var id = res.id, size = 250, i = 0;
      function next() {
        if (i >= payload.length) { setBusy(true, 'Sammenligner med kataloget …'); return post('/lager/katalog/import/' + id + '/klar', {}); }
        var chunk = payload.slice(i, i + size);
        i += size;
        setBusy(true, 'Indlæser ' + Math.min(i, payload.length).toLocaleString('da-DK') + ' af ' + payload.length.toLocaleString('da-DK') + ' rækker …');
        return post('/lager/katalog/import/' + id + '/rader', { rows: JSON.stringify(chunk) }).then(next);
      }
      return next();
    }).then(function (r) { location.href = r.url; })
      .catch(function (err) { setBusy(false, ''); setError(err.message || 'Importen kunne ikke indlæses.'); });
  });

  onSource();
})();
`;
