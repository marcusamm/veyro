// Kassens egen stylesheet og browserkode (/static/kasse.css og /static/kasse.js).
// Bygger på admin-designets farver (--bg, --surface, --ink, --accent …). Ingen tredjepartskode.
// Browserkoden regner totaler på samme måde som src/lib/pos/calc.ts, men serveren bestemmer:
// priser, rabatter, moms og lager tjekkes igen ved betaling.

export const KASSE_CSS = `
.kasse .wrap{max-width:1480px}
main:has(.pos-page){padding-top:24px}
.hidden{display:none!important}
.pos-err{color:var(--err)}
.pos-side{display:grid;gap:24px;align-items:start}
@media(min-width:960px){.pos-side{grid-template-columns:minmax(0,1fr) 340px}}
.pos-kv{display:grid;grid-template-columns:max-content 1fr;gap:8px 20px;margin:0}
.pos-kv dt{color:var(--muted);font-size:14px}.pos-kv dd{margin:0}
.pos-timeline{list-style:none;margin:0;padding:0 0 0 16px;border-left:2px solid var(--line);display:flex;flex-direction:column;gap:12px}
.pos-form-grid{display:grid;gap:16px}
@media(min-width:640px){.pos-form-grid{grid-template-columns:1fr 1fr}.pos-span{grid-column:1/-1}}
.pos-tabs-sm a{font-size:13px;padding:5px 11px}
.pos-page{display:flex;flex-direction:column;gap:14px}
.pos-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.pos-tabs{display:flex;gap:6px;flex-wrap:wrap}
@media(max-width:899px){.pos-tabs{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;margin-right:-16px;padding-right:16px}.pos-tabs a{flex:none}}
span.pos-item-img{aspect-ratio:auto;height:72px}
.pos-tabs a{padding:7px 13px;border-radius:9px;text-decoration:none;font-size:14px;font-weight:500;color:var(--muted);background:rgba(15,15,13,.05)}
.pos-tabs a:hover{color:var(--ink);background:rgba(15,15,13,.08)}
.pos-tabs a[aria-current=page]{background:var(--ink);color:var(--surface)}
kbd{font:inherit;font-size:12px;border:1px solid var(--line-strong);border-bottom-width:2px;border-radius:5px;padding:0 5px;background:var(--surface)}
.pos{display:grid;gap:16px;align-items:start}
@media(min-width:900px){.pos{grid-template-columns:minmax(0,1fr) 380px}}
@media(min-width:1280px){.pos{grid-template-columns:minmax(0,1fr) 420px}}
.pos-products{min-width:0;display:flex;flex-direction:column;gap:12px}
.pos-search input{width:100%;font:inherit;font-size:17px;padding:13px 16px;border:1px solid var(--line-strong);border-radius:12px;background:#fff;min-height:52px}
.pos-search input:focus{outline:none;border-color:var(--ink);box-shadow:0 0 0 3px rgba(255,90,31,.25)}
.pos-cats{display:flex;gap:8px;overflow-x:auto;padding-bottom:2px;scrollbar-width:thin}
.pos-cats button{flex:none;font:inherit;font-size:14px;font-weight:500;padding:9px 14px;border-radius:999px;border:1px solid var(--line-strong);background:var(--surface);color:var(--ink);cursor:pointer;min-height:40px}
.pos-cats button[aria-pressed=true]{background:var(--ink);border-color:var(--ink);color:var(--surface)}
.pos-grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}
.pos-item{position:relative;display:flex;flex-direction:column;text-align:left;font:inherit;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:0;overflow:hidden;cursor:pointer;min-height:150px;transition:border-color .12s,box-shadow .12s}
.pos-item:hover{border-color:var(--line-strong);box-shadow:0 6px 18px -10px rgba(15,15,13,.25)}
.pos-item:active{transform:scale(.99)}
.pos-item[disabled]{cursor:not-allowed;opacity:.55}
.pos-item-img{aspect-ratio:16/10;width:100%;object-fit:cover;background:rgba(15,15,13,.06);display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:650;color:var(--muted)}
.pos-item-body{padding:10px 12px 12px;display:flex;flex-direction:column;gap:4px;flex:1}
.pos-item-name{font-weight:600;font-size:14.5px;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.pos-item-meta{display:flex;justify-content:space-between;align-items:center;gap:6px;margin-top:auto;font-size:13px}
.pos-item-price{font-weight:700;font-size:15px;font-variant-numeric:tabular-nums}
.pos-item-qty{position:absolute;top:8px;right:8px;background:var(--accent);color:#0F0F0D;font-weight:700;font-size:13px;border-radius:999px;min-width:26px;height:26px;display:flex;align-items:center;justify-content:center;padding:0 7px}
.pos-stock{font-size:12px;font-weight:600;padding:1px 8px;border-radius:999px;white-space:nowrap}
.pos-stock.ok{background:var(--ok-bg);color:var(--ok)}.pos-stock.low{background:var(--warn-bg);color:var(--warn)}.pos-stock.out{background:var(--err-bg);color:var(--err)}.pos-stock.off{color:var(--muted)}
.pos-state{grid-column:1/-1;text-align:center;color:var(--muted);padding:40px 12px}
.pos-cart{background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:16px;display:flex;flex-direction:column;gap:12px}
@media(min-width:900px){.pos-cart{position:sticky;top:16px;max-height:calc(100vh - 32px);overflow:auto}}
.pos-cart-head{display:flex;justify-content:space-between;align-items:center;gap:8px}
.pos-cart-head h2{font-size:18px;margin:0}
.pos-customer{display:flex;justify-content:space-between;align-items:center;gap:8px;background:rgba(15,15,13,.04);border-radius:10px;padding:8px 12px;font-size:14px}
.pos-lines{list-style:none;margin:0;padding:0}
.pos-line{display:grid;grid-template-columns:1fr auto;gap:6px 10px;padding:10px 0;border-bottom:1px solid var(--line)}
.pos-line:first-child{padding-top:0}
.pos-line-name{font-weight:600;font-size:14.5px;line-height:1.3}
.pos-line-sub{font-size:12.5px;color:var(--muted)}
.pos-line-total{font-weight:650;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.pos-line-ctrl{grid-column:1/-1;display:flex;align-items:center;gap:6px}
.pos-step{display:inline-flex;align-items:center;border:1px solid var(--line-strong);border-radius:10px;overflow:hidden;background:#fff}
.pos-step button{font:inherit;font-size:20px;line-height:1;width:44px;height:42px;border:0;background:none;cursor:pointer;color:var(--ink)}
.pos-step button:hover{background:rgba(15,15,13,.05)}
.pos-step input{width:52px;height:42px;border:0;border-left:1px solid var(--line);border-right:1px solid var(--line);text-align:center;font:inherit;font-size:16px;font-variant-numeric:tabular-nums;-moz-appearance:textfield;appearance:textfield}
.pos-step input::-webkit-inner-spin-button,.pos-step input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
.pos-chip{font:inherit;font-size:13px;font-weight:500;border:1px solid var(--line-strong);background:none;border-radius:999px;padding:6px 11px;cursor:pointer;color:var(--ink);min-height:36px}
.pos-chip.on{background:var(--warn-bg);border-color:transparent;color:var(--warn)}
.pos-x{margin-left:auto;font:inherit;font-size:22px;line-height:1;border:0;background:none;color:var(--muted);cursor:pointer;width:40px;height:40px;border-radius:10px}
.pos-x:hover{background:var(--err-bg);color:var(--err)}
.pos-empty{color:var(--muted);font-size:14px;text-align:center;padding:16px 0;margin:0}
.pos-note summary{cursor:pointer;font-size:14px;color:var(--muted)}
.pos-note textarea{margin-top:8px;width:100%;font:inherit;font-size:15px;padding:8px 10px;border:1px solid var(--line-strong);border-radius:10px;min-height:0}
.pos-totals{width:100%;border-collapse:collapse;font-size:15px}
.pos-totals td{padding:4px 0}
.pos-totals td:last-child{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.pos-totals tr.total td{font-weight:750;font-size:22px;border-top:1px solid var(--line);padding-top:10px;letter-spacing:-.01em}
.link-btn{font:inherit;font-size:13px;background:none;border:0;padding:0;color:var(--muted);text-decoration:underline;cursor:pointer}
.pos-actions{display:grid;grid-template-columns:auto 1fr;gap:8px}
.pos-pay{font-size:18px!important;min-height:58px!important}
.pos-bar{display:none}
.pos-toasts{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:50;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;width:min(92vw,460px)}
.pos-toast{background:var(--ink);color:var(--surface);padding:10px 16px;border-radius:12px;font-size:14.5px;box-shadow:0 10px 30px -10px rgba(0,0,0,.4)}
.pos-toast.err{background:var(--err)}.pos-toast.ok{background:var(--ok)}
.pos-dialog{border:0;border-radius:20px;padding:0;width:min(560px,calc(100vw - 24px));max-height:calc(100vh - 24px);background:var(--surface);color:var(--ink);box-shadow:0 30px 80px -20px rgba(0,0,0,.45)}
.pos-dialog-sm{width:min(420px,calc(100vw - 24px))}
.pos-dialog::backdrop{background:rgba(15,15,13,.45)}
.pos-dlg{display:flex;flex-direction:column;gap:14px;padding:20px}
.pos-dlg-head{display:flex;justify-content:space-between;align-items:center;gap:12px}
.pos-dlg-head h2{font-size:20px;margin:0}
.pos-due{font-size:34px;font-weight:750;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.1}
.pos-methods{display:grid;gap:8px;grid-template-columns:repeat(auto-fit,minmax(130px,1fr))}
.pos-methods button{font:inherit;font-weight:600;font-size:16px;min-height:56px;border-radius:12px;border:1px solid var(--line-strong);background:#fff;cursor:pointer;color:var(--ink)}
.pos-methods button:hover{border-color:var(--ink)}
.pos-pays{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.pos-pays li{border:1px solid var(--line);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px;background:#fff}
.pos-pays .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.pos-pays label{font-size:13px;font-weight:600;margin:0}
.pos-money{width:140px;font:inherit;font-size:18px;padding:9px 11px;border:1px solid var(--line-strong);border-radius:10px;text-align:right;font-variant-numeric:tabular-nums}
.pos-quick{display:flex;gap:6px;flex-wrap:wrap}
.pos-quick button{font:inherit;font-size:14px;padding:8px 12px;border-radius:9px;border:1px solid var(--line-strong);background:var(--surface);cursor:pointer;min-height:40px}
.pos-change{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}
.pos-change.short{color:var(--err)}
.pos-msg{font-size:14.5px;padding:10px 12px;border-radius:10px;background:var(--err-bg);color:var(--err)}
.pos-msg.info{background:rgba(15,15,13,.05);color:var(--ink)}
.pos-msg.ok{background:var(--ok-bg);color:var(--ok)}
.pos-dlg-foot{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.pos-dlg-foot .btn{min-height:50px}
.pos-big{font-size:17px!important;min-height:56px!important}
.pos-spin{width:28px;height:28px;border:3px solid var(--line-strong);border-top-color:var(--accent);border-radius:50%;animation:pos-spin 1s linear infinite;flex:none}
@keyframes pos-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.pos-spin{animation-duration:3s}}
.pos-results{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;max-height:260px;overflow:auto}
.pos-results button{width:100%;text-align:left;font:inherit;border:1px solid var(--line);border-radius:10px;background:#fff;padding:10px 12px;cursor:pointer}
.pos-results button:hover{border-color:var(--ink)}
.pos-fields{display:grid;gap:10px}
@media(min-width:560px){.pos-fields.two{grid-template-columns:1fr 1fr}}
.pos-fields label{display:block;font-size:13px;font-weight:600;margin:0 0 4px}
.pos-fields input,.pos-fields select{width:100%;font:inherit;font-size:16px;padding:10px 12px;border:1px solid var(--line-strong);border-radius:10px;background:#fff;min-height:44px}
.pos-seg{display:inline-flex;border:1px solid var(--line-strong);border-radius:10px;overflow:hidden}
.pos-seg button{font:inherit;font-size:15px;padding:9px 14px;border:0;background:#fff;cursor:pointer;min-height:42px}
.pos-seg button[aria-pressed=true]{background:var(--ink);color:var(--surface)}
.pos-done{text-align:center;display:flex;flex-direction:column;gap:10px;align-items:center}
.pos-done .pos-due{font-size:44px}
.pos-check{width:56px;height:56px;border-radius:50%;background:var(--ok-bg);color:var(--ok);display:flex;align-items:center;justify-content:center;font-size:30px;font-weight:700}
.pos-filter{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}
.pos-filter label{font-size:14px}
.plain-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.plain-list>li{display:flex;justify-content:space-between;gap:12px}
.pos-mini{width:100%;border-collapse:collapse;font-size:14px}
.pos-mini th{text-align:left;font-weight:600;color:var(--muted);font-size:12.5px;padding:7px 8px;border-bottom:1px solid var(--line-strong)}
.pos-mini td{padding:8px;border-bottom:1px solid var(--line);vertical-align:top}
.pos-mini th:first-child,.pos-mini td:first-child{padding-left:0}
.pos-mini .num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.pos-mini small{display:block;color:var(--muted);font-size:12px}
.pos-tag{display:inline-block;font-size:12.5px;font-weight:600;padding:2px 9px;border-radius:999px;white-space:nowrap;background:rgba(15,15,13,.07)}
.pos-tag.ok{background:var(--ok-bg);color:var(--ok)}.pos-tag.warn{background:var(--warn-bg);color:var(--warn)}.pos-tag.err{background:var(--err-bg);color:var(--err)}.pos-tag.new{background:rgba(255,90,31,.15);color:#7a2a08}
input.pos-qty{width:80px;flex:none;text-align:center}
@media(max-width:899px){
  .pos{padding-bottom:84px}
  .pos-cart{position:fixed;inset:auto 0 0 0;z-index:30;border-radius:20px 20px 0 0;max-height:85vh;overflow:auto;transform:translateY(105%);transition:transform .2s;box-shadow:0 -20px 60px -20px rgba(0,0,0,.35)}
  .pos.cart-open .pos-cart{transform:none}
  .pos-bar{display:flex;position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:20;gap:8px;background:var(--ink);border-radius:16px;padding:8px}
  .pos-bar-cart{flex:1;display:flex;justify-content:space-between;align-items:center;gap:10px;font:inherit;color:var(--surface);background:none;border:0;padding:0 10px;cursor:pointer;font-size:15px}
  .pos-bar .btn{min-height:48px}
  .pos.cart-open .pos-bar{display:none}
  .pos-keys{display:none}
}
@media(prefers-reduced-motion:reduce){.pos-cart{transition:none}}
`;

export const KASSE_JS = String.raw`
(function () {
  'use strict';
  // Kvittering: udskriv automatisk og knap
  document.addEventListener('DOMContentLoaded', function () {
    if (document.body.hasAttribute('data-autoprint')) setTimeout(function () { window.print(); }, 300);
  });
  document.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('[data-print]')) window.print();
    var all = e.target.closest && e.target.closest('[data-refund-all]');
    if (all) {
      all.form.querySelectorAll('input[data-max]').forEach(function (i) { i.value = i.getAttribute('data-max'); });
    }
  });

  var root = document.querySelector('[data-pos]');
  if (!root) return;
  var cfg = JSON.parse(root.getAttribute('data-config'));
  var $ = function (sel, el) { return (el || root).querySelector(sel); };
  var $$ = function (sel, el) { return Array.prototype.slice.call((el || root).querySelectorAll(sel)); };
  var STORE = 'veyro-kasse-v1';

  var state = { products: [], byId: {}, cats: [], cat: '', q: '', cart: [], orderDiscount: null, customer: null, note: '', key: newKey(), loading: true, error: '' };

  // ---------- Hjælpere ----------
  function newKey() {
    var a = new Uint8Array(18);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function kr(oere, dec) {
    var neg = oere < 0; oere = Math.abs(Math.round(oere));
    var k = Math.floor(oere / 100), o = oere % 100;
    var s = String(k).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (neg ? '-' : '') + s + (o || dec ? ',' + (o < 10 ? '0' : '') + o : '') + ' kr.';
  }
  function parseKr(v) {
    var s = String(v || '').trim().replace(/\s|kr\.?/gi, '');
    if (!s) return null;
    if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.');
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    return Math.round(parseFloat(s) * 100);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function pctText(bp) { return (bp / 100).toLocaleString('da-DK') + ' %'; }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify({ cart: state.cart, orderDiscount: state.orderDiscount, customer: state.customer, note: state.note, key: state.key })); } catch (e) {}
  }
  function restore() {
    try {
      var s = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (s && Array.isArray(s.cart)) {
        state.cart = s.cart; state.orderDiscount = s.orderDiscount || null; state.customer = s.customer || null; state.note = s.note || ''; state.key = s.key || newKey();
      }
    } catch (e) {}
  }
  function toast(msg, kind) {
    var box = $('.pos-toasts');
    var d = document.createElement('div');
    d.className = 'pos-toast' + (kind ? ' ' + kind : '');
    d.textContent = msg;
    box.appendChild(d);
    setTimeout(function () { d.remove(); }, kind === 'err' ? 6000 : 3000);
  }
  function api(method, url, data) {
    var opts = { method: method, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
    if (method === 'POST') {
      var p = new URLSearchParams();
      p.set('_csrf', cfg.csrf);
      Object.keys(data || {}).forEach(function (k) { if (data[k] !== undefined && data[k] !== null) p.set(k, typeof data[k] === 'string' ? data[k] : JSON.stringify(data[k])); });
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      opts.body = p.toString();
    }
    return fetch(url, opts).then(function (res) {
      var ct = res.headers.get('Content-Type') || '';
      if (ct.indexOf('application/json') < 0) {
        var err = new Error(res.redirected || res.status === 403 ? 'Du er logget ud. Genindlæs siden og log ind igen.' : 'Uventet svar fra serveren (' + res.status + ').');
        err.fatal = true;
        throw err;
      }
      return res.json().then(function (j) { j.httpStatus = res.status; return j; });
    });
  }

  // ---------- Beregning (samme som serveren) ----------
  function discountAmount(base, d) {
    if (!d || base <= 0) return 0;
    if (d.type === 'pct') return Math.min(base, Math.round(base * Math.min(10000, Math.max(0, d.value)) / 10000));
    return Math.min(base, Math.max(0, d.value));
  }
  function allocate(amount, weights) {
    var total = weights.reduce(function (a, b) { return a + b; }, 0);
    if (amount <= 0 || total <= 0) return weights.map(function () { return 0; });
    var raw = weights.map(function (w) { return amount * w / total; });
    var out = raw.map(Math.floor);
    var rest = amount - out.reduce(function (a, b) { return a + b; }, 0);
    var order = raw.map(function (r, i) { return [r - Math.floor(r), i]; }).sort(function (a, b) { return b[0] - a[0] || a[1] - b[1]; });
    for (var k = 0; rest > 0 && k < order.length; k++, rest--) out[order[k][1]] += 1;
    return out;
  }
  function calc() {
    var lines = state.cart.map(function (l) {
      var p = state.byId[l.id];
      var gross = (p ? p.price : 0) * l.qty;
      var ld = discountAmount(gross, l.discount);
      return { gross: gross, ld: ld, after: gross - ld };
    });
    var after = lines.reduce(function (a, l) { return a + l.after; }, 0);
    var od = discountAmount(after, state.orderDiscount);
    var shares = allocate(od, lines.map(function (l) { return l.after; }));
    var subtotal = lines.reduce(function (a, l) { return a + l.gross; }, 0);
    var total = 0;
    lines.forEach(function (l, i) { l.net = l.after - shares[i]; total += l.net; });
    var discount = subtotal - total;
    return {
      lines: lines, subtotal: subtotal, discount: discount, orderDiscount: od, total: total,
      vat: cfg.vatBp > 0 ? Math.round(total * cfg.vatBp / (10000 + cfg.vatBp)) : 0,
      discountBp: subtotal > 0 ? Math.ceil(discount * 10000 / subtotal) : 0
    };
  }
  function roundCash(a) { return cfg.cashRounding ? Math.floor((a + 25) / 50) * 50 : a; }

  // ---------- Varer ----------
  function stockInfo(p) {
    if (p.available === null) return { cls: 'off', text: '' };
    if (p.available <= 0) return { cls: 'out', text: 'Udsolgt' };
    if (p.available <= 3) return { cls: 'low', text: p.available + ' tilbage' };
    return { cls: 'ok', text: p.available + ' på lager' };
  }
  function inCart(id) {
    for (var i = 0; i < state.cart.length; i++) if (state.cart[i].id === id) return state.cart[i];
    return null;
  }
  function matches(p, words) {
    var hay = (p.name + ' ' + p.sku + ' ' + p.barcode + ' ' + p.category).toLowerCase();
    return words.every(function (w) { return hay.indexOf(w) !== -1; });
  }
  function visible() {
    var words = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    return state.products.filter(function (p) { return (!state.cat || p.category === state.cat || words.length) && matches(p, words); });
  }
  function renderCats() {
    var box = $('.pos-cats');
    if (!state.cats.length) { box.innerHTML = ''; return; }
    box.innerHTML = ['<button type="button" data-cat="" aria-pressed="' + (!state.cat) + '">Alle</button>'].concat(state.cats.map(function (c) {
      return '<button type="button" data-cat="' + esc(c) + '" aria-pressed="' + (state.cat === c) + '">' + esc(c) + '</button>';
    })).join('');
  }
  function renderGrid() {
    var grid = $('.pos-grid');
    grid.setAttribute('aria-busy', state.loading ? 'true' : 'false');
    if (state.loading) { grid.innerHTML = '<p class="pos-state">Henter ydelser og varer …</p>'; return; }
    if (state.error) { grid.innerHTML = '<div class="pos-state"><p>' + esc(state.error) + '</p><button class="btn btn-secondary" type="button" data-act="reload">Prøv igen</button></div>'; return; }
    if (!state.products.length) { grid.innerHTML = '<p class="pos-state">Der er ingen ydelser eller varer i kassen endnu. ' + (cfg.canManage ? '<a href="/admin/kasse/varer/ny">Opret den første</a>.' : 'Bed en administrator oprette dem.') + '</p>'; return; }
    var list = visible();
    if (!list.length) { grid.innerHTML = '<p class="pos-state">Ingen ydelser eller varer matcher "' + esc(state.q) + '".</p>'; return; }
    grid.innerHTML = list.slice(0, 300).map(function (p) {
      var s = stockInfo(p), c = inCart(p.id);
      var img = p.image ? '<img class="pos-item-img" src="' + esc(p.image) + '" alt="" loading="lazy">' : '<span class="pos-item-img" aria-hidden="true">' + esc(p.name.charAt(0).toUpperCase()) + '</span>';
      return '<button class="pos-item" type="button" data-add="' + p.id + '"' + (p.available === 0 ? ' disabled' : '') + ' aria-label="' + esc(p.name) + ', ' + kr(p.price) + (s.text ? ', ' + s.text : '') + '">' +
        img + (c ? '<span class="pos-item-qty" aria-hidden="true">' + c.qty + '</span>' : '') +
        '<span class="pos-item-body"><span class="pos-item-name">' + esc(p.name) + '</span>' +
        '<span class="pos-item-meta"><span class="pos-item-price">' + kr(p.price) + '</span>' + (s.text ? '<span class="pos-stock ' + s.cls + '">' + s.text + '</span>' : '') + '</span></span></button>';
    }).join('');
  }
  function loadProducts(quiet) {
    if (!quiet) { state.loading = true; state.error = ''; renderGrid(); }
    return api('GET', '/admin/kasse/api/varer').then(function (j) {
      if (!j.ok) throw new Error(j.message || 'Kunne ikke hente varer.');
      state.products = j.products; state.cats = j.categories; state.byId = {};
      j.products.forEach(function (p) { state.byId[p.id] = p; });
      // Fjern varer, der ikke længere findes, fra kurven
      var before = state.cart.length;
      state.cart = state.cart.filter(function (l) { return state.byId[l.id]; });
      if (state.cart.length < before) toast('En vare i kurven findes ikke længere og er fjernet.', 'err');
      state.loading = false; state.error = '';
      renderCats(); renderGrid(); renderCart();
    }).catch(function (e) {
      state.loading = false;
      state.error = e.message || 'Kunne ikke hente varer. Tjek forbindelsen.';
      if (!quiet) renderGrid();
    });
  }

  // ---------- Kurv ----------
  function add(id, qty) {
    var p = state.byId[id];
    if (!p) return;
    var line = inCart(id);
    var want = (line ? line.qty : 0) + (qty || 1);
    if (p.available !== null && want > p.available) { toast(p.available <= 0 ? p.name + ' er udsolgt.' : 'Der er kun ' + p.available + ' af ' + p.name + '.', 'err'); return; }
    if (line) line.qty = want; else state.cart.push({ id: id, qty: qty || 1, discount: null });
    changed();
  }
  function setQty(id, qty) {
    var line = inCart(id), p = state.byId[id];
    if (!line || !p) return;
    if (!(qty >= 1)) qty = 1;
    if (qty > 9999) qty = 9999;
    if (p.available !== null && qty > p.available) { toast('Der er kun ' + p.available + ' af ' + p.name + '.', 'err'); qty = Math.max(1, p.available); }
    line.qty = qty;
    changed();
  }
  function remove(id) {
    state.cart = state.cart.filter(function (l) { return l.id !== id; });
    changed();
  }
  function changed() { save(); renderCart(); renderGrid(); }
  function renderCart() {
    var c = calc();
    var count = state.cart.reduce(function (a, l) { return a + l.qty; }, 0);
    $('[data-count]').textContent = count ? '(' + count + ')' : '';
    $('[data-empty]').classList.toggle('hidden', state.cart.length > 0);
    $('[data-lines]').innerHTML = state.cart.map(function (l, i) {
      var p = state.byId[l.id];
      if (!p) return '';
      var cl = c.lines[i];
      return '<li class="pos-line"><div><div class="pos-line-name">' + esc(p.name) + '</div><div class="pos-line-sub">' + kr(p.price) + (p.unit ? ' / ' + esc(p.unit) : '') + (cl.ld ? ' · rabat ' + kr(cl.ld) : '') + '</div></div>' +
        '<div class="pos-line-total">' + kr(cl.gross - cl.ld) + (cl.ld ? '<div class="pos-line-sub"><s>' + kr(cl.gross) + '</s></div>' : '') + '</div>' +
        '<div class="pos-line-ctrl"><span class="pos-step"><button type="button" data-dec="' + l.id + '" aria-label="Færre ' + esc(p.name) + '">−</button>' +
        '<input type="number" inputmode="numeric" min="1" max="9999" value="' + l.qty + '" data-qty="' + l.id + '" aria-label="Antal ' + esc(p.name) + '">' +
        '<button type="button" data-inc="' + l.id + '" aria-label="Flere ' + esc(p.name) + '">+</button></span>' +
        '<button type="button" class="pos-chip' + (l.discount ? ' on' : '') + '" data-line-disc="' + l.id + '">' + (l.discount ? (l.discount.type === 'pct' ? '−' + pctText(l.discount.value) : '−' + kr(l.discount.value)) : 'Rabat') + '</button>' +
        '<button type="button" class="pos-x" data-remove="' + l.id + '" aria-label="Fjern ' + esc(p.name) + '">×</button></div></li>';
    }).join('');
    $('[data-t=subtotal]').textContent = kr(c.subtotal);
    var dr = $('[data-row=discount]');
    dr.classList.toggle('hidden', !c.discount);
    $('[data-t=discount]').textContent = '-' + kr(c.discount);
    $('[data-act=remove-order-discount]').classList.toggle('hidden', !state.orderDiscount);
    $('[data-t=total]').textContent = kr(c.total);
    $('[data-t=vat]').textContent = kr(c.vat);
    $('[data-t=pay]').textContent = state.cart.length ? kr(c.total) : '';
    $$('[data-act=pay]').forEach(function (b) { b.disabled = !state.cart.length || !cfg.methods.length && c.total > 0; });
    $('[data-bar-count]').textContent = count + (count === 1 ? ' vare' : ' varer');
    $('[data-bar-total]').textContent = kr(c.total);
    var cust = $('[data-customer]');
    cust.classList.toggle('hidden', !state.customer);
    if (state.customer) cust.innerHTML = '<span><strong>' + esc(state.customer.company || state.customer.name) + '</strong>' + (state.customer.email ? ' · ' + esc(state.customer.email) : '') + '</span><button type="button" class="link-btn" data-act="remove-customer">Fjern</button>';
    var note = $('#pos-note');
    if (document.activeElement !== note) note.value = state.note;
  }
  function clearSale() {
    state.cart = []; state.orderDiscount = null; state.customer = null; state.note = ''; state.key = newKey();
    changed();
  }

  // ---------- Dialoger ----------
  function dlg(name) { return $('[data-dialog=' + name + ']'); }
  function openDlg(name, htmlStr) {
    var d = dlg(name);
    d.innerHTML = htmlStr;
    if (!d.open) d.showModal();
    var f = d.querySelector('[autofocus]');
    if (f) f.focus();
    return d;
  }
  function closeDlg(name) { var d = dlg(name); if (d.open) d.close(); }
  function head(id, title) { return '<div class="pos-dlg-head"><h2 id="' + id + '">' + title + '</h2><button type="button" class="pos-x" data-close aria-label="Luk">×</button></div>'; }

  function confirmBox(title, text, okLabel, onOk) {
    var d = openDlg('confirm', '<div class="pos-dlg">' + head('confirm-title', esc(title)) + '<p>' + esc(text) + '</p><div class="pos-dlg-foot"><button class="btn btn-secondary" type="button" data-close>Fortryd</button><button class="btn btn-danger" type="button" data-ok autofocus>' + esc(okLabel) + '</button></div></div>');
    d.querySelector('[data-ok]').onclick = function () { closeDlg('confirm'); onOk(); };
  }

  // Rabat (på en linje eller hele ordren)
  function discountDialog(lineId) {
    var line = lineId ? inCart(lineId) : null;
    var cur = line ? line.discount : state.orderDiscount;
    var p = line ? state.byId[lineId] : null;
    var type = cur ? cur.type : 'pct';
    var d = openDlg('discount', '<form class="pos-dlg" data-disc-form>' + head('disc-title', line ? 'Rabat på ' + esc(p.name) : 'Rabat på hele ordren') +
      (cfg.presets.length ? '<div class="pos-quick">' + cfg.presets.map(function (x) { return '<button type="button" data-preset="' + x + '">' + x.toLocaleString('da-DK') + ' %</button>'; }).join('') + '</div>' : '') +
      '<div class="pos-fields"><div><label for="disc-v">Rabat</label><div style="display:flex;gap:8px;align-items:center"><input id="disc-v" class="pos-money" inputmode="decimal" autocomplete="off" value="' + (cur ? (cur.type === 'pct' ? String(cur.value / 100).replace('.', ',') : String(cur.value / 100).replace('.', ',')) : '') + '" autofocus>' +
      '<span class="pos-seg" role="group" aria-label="Type"><button type="button" data-type="pct" aria-pressed="' + (type === 'pct') + '">%</button><button type="button" data-type="amount" aria-pressed="' + (type === 'amount') + '">kr.</button></span></div></div></div>' +
      '<p class="small muted" data-disc-hint>Du må give op til ' + pctText(cfg.maxDiscountBp) + ' uden godkendelse.</p>' +
      '<div class="pos-dlg-foot">' + (cur ? '<button class="btn btn-secondary" type="button" data-disc-remove>Fjern rabat</button>' : '') + '<button class="btn btn-primary" type="submit">Giv rabat</button></div></form>');
    function apply(t, raw) {
      var v = t === 'pct' ? Math.round(parseFloat(String(raw).replace(',', '.')) * 100) : parseKr(raw);
      if (!(v > 0) || (t === 'pct' && v > 10000)) { toast('Skriv en rabat, fx 10 % eller 50 kr.', 'err'); return; }
      var disc = { type: t, value: v };
      if (line) line.discount = disc; else state.orderDiscount = disc;
      closeDlg('discount'); changed();
      var c = calc();
      if (c.discountBp > cfg.maxDiscountBp) toast('Rabatten er over din grænse og skal godkendes ved betaling.', '');
    }
    d.querySelectorAll('[data-type]').forEach(function (b) {
      b.onclick = function () { type = b.getAttribute('data-type'); d.querySelectorAll('[data-type]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); };
    });
    d.querySelectorAll('[data-preset]').forEach(function (b) { b.onclick = function () { apply('pct', b.getAttribute('data-preset')); }; });
    var rm = d.querySelector('[data-disc-remove]');
    if (rm) rm.onclick = function () { if (line) line.discount = null; else state.orderDiscount = null; closeDlg('discount'); changed(); };
    d.querySelector('[data-disc-form]').onsubmit = function (e) { e.preventDefault(); apply(type, d.querySelector('#disc-v').value); };
  }

  // Kunde
  function customerDialog() {
    var d = openDlg('customer', '<div class="pos-dlg">' + head('cust-title', 'Kunde') +
      '<div class="pos-fields"><div><label for="cust-q">Søg efter kunde</label><input id="cust-q" type="search" autocomplete="off" placeholder="Navn, firma, e-mail eller telefon" autofocus></div></div>' +
      '<ul class="pos-results" data-results></ul>' +
      '<details data-new><summary class="small">Ny kunde</summary><form class="pos-dlg" style="padding:12px 0 0" data-new-form><div class="pos-fields two">' +
      '<div><label for="nc-name">Navn</label><input id="nc-name" name="name" required maxlength="100"></div>' +
      '<div><label for="nc-company">Firma</label><input id="nc-company" name="company" maxlength="100"></div>' +
      '<div><label for="nc-email">E-mail</label><input id="nc-email" name="email" type="email" maxlength="254"></div>' +
      '<div><label for="nc-phone">Telefon</label><input id="nc-phone" name="phone" type="tel" maxlength="30"></div></div>' +
      '<div class="pos-dlg-foot"><button class="btn btn-primary" type="submit">Vælg kunde</button></div></form></details></div>');
    var timer = null, input = d.querySelector('#cust-q'), list = d.querySelector('[data-results]');
    input.oninput = function () {
      clearTimeout(timer);
      var q = input.value.trim();
      if (q.length < 2) { list.innerHTML = ''; return; }
      timer = setTimeout(function () {
        list.innerHTML = '<li class="small muted">Søger …</li>';
        api('GET', '/admin/kasse/api/kunder?q=' + encodeURIComponent(q)).then(function (j) {
          var rows = j.customers || [];
          list.innerHTML = rows.length ? rows.map(function (c, i) {
            return '<li><button type="button" data-pick="' + i + '"><strong>' + esc(c.company || c.name || c.email) + '</strong><span class="small muted" style="display:block">' + esc([c.company ? c.name : '', c.email, c.phone].filter(Boolean).join(' · ')) + '</span></button></li>';
          }).join('') : '<li class="small muted">Ingen kunder fundet. Opret en ny herunder.</li>';
          list.querySelectorAll('[data-pick]').forEach(function (b) {
            b.onclick = function () { var c = rows[Number(b.getAttribute('data-pick'))]; state.customer = { id: c.id || null, name: c.name || '', email: c.email || '', phone: c.phone || '', company: c.company || '' }; closeDlg('customer'); changed(); };
          });
          if (!rows.length) d.querySelector('[data-new]').open = true;
        }).catch(function (e) { list.innerHTML = '<li class="small" style="color:var(--err)">' + esc(e.message) + '</li>'; });
      }, 250);
    };
    d.querySelector('[data-new-form]').onsubmit = function (e) {
      e.preventDefault();
      var f = e.target;
      var email = f.email.value.trim();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { toast('E-mailadressen ser forkert ud.', 'err'); return; }
      state.customer = { id: null, name: f.name.value.trim(), email: email, phone: f.phone.value.trim(), company: f.company.value.trim() };
      closeDlg('customer'); changed();
    };
  }

  // ---------- Betaling ----------
  var pay = null; // { payments: [...], approval, busy, message }
  function payDialog() {
    if (!state.cart.length) return;
    var c = calc();
    pay = { payments: [], approvalEmail: '', approvalPin: '', busy: false, message: '', kind: '', needApproval: c.discountBp > cfg.maxDiscountBp, sale: null };
    // Én betalingsform: vælg den med det samme
    if (cfg.methods.length === 1 && c.total > 0) addPayment(cfg.methods[0].key, true);
    renderPay();
  }
  function method(key) { for (var i = 0; i < cfg.methods.length; i++) if (cfg.methods[i].key === key) return cfg.methods[i]; return null; }
  function nonCashSum() { return pay.payments.reduce(function (a, p) { return a + (p.method === 'kontant' ? 0 : (p.amount || 0)); }, 0); }
  function cashDue() { var due = calc().total - nonCashSum(); return due > 0 ? roundCash(due) : 0; }
  function addPayment(key, silent) {
    var m = method(key);
    if (!m) return;
    if (m.method === 'kontant' && pay.payments.some(function (p) { return p.method === 'kontant'; })) return;
    if (m.method === 'stripe_terminal' && pay.payments.some(function (p) { return p.method === 'stripe_terminal'; })) return;
    var remaining = calc().total - nonCashSum() - (pay.payments.some(function (p) { return p.method === 'kontant'; }) ? Infinity : 0);
    var p = { key: m.key, label: m.label, method: m.method, amount: m.method === 'kontant' ? 0 : Math.max(0, remaining === -Infinity ? 0 : remaining), received: null, reference: '', confirmed: false };
    if (p.method !== 'kontant' && p.amount <= 0) { if (!silent) toast('Beløbet er allerede dækket.', ''); return; }
    pay.payments.push(p);
    if (!silent) renderPay();
  }
  function payReady() {
    var c = calc();
    if (c.total === 0) return pay.payments.length === 0 ? true : false;
    var non = nonCashSum();
    var cash = pay.payments.filter(function (p) { return p.method === 'kontant'; })[0];
    if (non > c.total) return false;
    if (pay.payments.some(function (p) { return p.method !== 'kontant' && !(p.amount > 0); })) return false;
    if (pay.payments.some(function (p) { return p.method === 'kort_terminal' && !p.confirmed; })) return false;
    if (cash) { var due = cashDue(); return due > 0 && (cash.received === null || cash.received >= due); }
    return non === c.total;
  }
  function renderPay() {
    var c = calc();
    var due = c.total;
    var cash = pay.payments.filter(function (p) { return p.method === 'kontant'; })[0];
    var rest = c.total - nonCashSum();
    var rows = pay.payments.map(function (p, i) {
      if (p.method === 'kontant') {
        var cd = cashDue();
        var rec = p.received === null ? cd : p.received;
        // Præcist beløb og de næste runde sedler/beløb over det
        var quick = [cd];
        [5000, 10000, 20000, 50000, 100000].forEach(function (d) { var v = Math.ceil(cd / d) * d; if (v > cd && quick.indexOf(v) < 0) quick.push(v); });
        quick = quick.slice(0, 5);
        return '<li><div class="row" style="justify-content:space-between"><strong>Kontant ' + kr(cd) + (cd !== rest && rest > 0 ? ' <span class="small muted">(afrundet fra ' + kr(rest) + ')</span>' : '') + '</strong><button type="button" class="link-btn" data-unpay="' + i + '">Fjern</button></div>' +
          '<div class="row"><label for="recv">Modtaget</label><input id="recv" class="pos-money" inputmode="decimal" autocomplete="off" data-recv value="' + (p.received === null ? '' : String(p.received / 100).replace('.', ',')) + '" placeholder="' + (cd / 100).toLocaleString('da-DK', { minimumFractionDigits: 2 }) + '"></div>' +
          '<div class="pos-quick">' + quick.map(function (n, k) { return '<button type="button" data-recv-q="' + n + '">' + (k === 0 ? 'Præcis ' : '') + kr(n) + '</button>'; }).join('') + '</div>' +
          '<div>Byttepenge: <span class="pos-change' + (rec < cd ? ' short' : '') + '" data-change>' + (rec < cd ? 'mangler ' + kr(cd - rec) : kr(rec - cd)) + '</span></div></li>';
      }
      return '<li><div class="row" style="justify-content:space-between"><strong>' + esc(p.label) + '</strong><button type="button" class="link-btn" data-unpay="' + i + '">Fjern</button></div>' +
        '<div class="row"><label for="amt-' + i + '">Beløb</label><input id="amt-' + i + '" class="pos-money" inputmode="decimal" autocomplete="off" data-amt="' + i + '" value="' + String(p.amount / 100).replace('.', ',') + '"></div>' +
        (p.method === 'kort_terminal' || p.method === 'andet' ? '<div class="row"><label for="ref-' + i + '">Reference (valgfri)</label><input id="ref-' + i + '" class="pos-money" style="width:180px;text-align:left" maxlength="60" data-ref="' + i + '" value="' + esc(p.reference) + '"></div>' : '') +
        (p.method === 'kort_terminal' ? '<label class="check" style="font-weight:500;font-size:15px;display:flex;gap:8px;align-items:center"><input type="checkbox" data-conf="' + i + '"' + (p.confirmed ? ' checked' : '') + ' style="width:22px;height:22px"> Terminalen har godkendt betalingen på ' + kr(p.amount) + '</label>' : '') +
        (p.method === 'stripe_terminal' ? '<p class="small muted">Beløbet sendes til kortlæseren, når du trykker Gennemfør. Salget er først betalt, når kortet er godkendt.</p>' : '') +
        '</li>';
    }).join('');
    var used = pay.payments.map(function (p) { return p.method; });
    var avail = cfg.methods.filter(function (m) { return !((m.method === 'kontant' || m.method === 'stripe_terminal') && used.indexOf(m.method) >= 0); });
    var covered = nonCashSum() >= c.total || !!cash;
    var html = '<div class="pos-dlg">' + head('pay-title', 'Betaling') +
      '<div><div class="small muted">At betale' + (state.customer ? ' · ' + esc(state.customer.company || state.customer.name) : '') + '</div><div class="pos-due">' + kr(due) + '</div>' + (c.discount ? '<div class="small muted">Inkl. rabat ' + kr(c.discount) + ' · heraf moms ' + kr(c.vat) + '</div>' : '<div class="small muted">Heraf moms ' + kr(c.vat) + '</div>') + '</div>' +
      (c.total === 0 ? '<p class="pos-msg info">Salget er på 0 kr. og kræver ingen betaling.</p>' : '') +
      (rows ? '<ul class="pos-pays">' + rows + '</ul>' : '') +
      (c.total > 0 && !covered && avail.length ? '<div><div class="small muted" style="margin-bottom:6px">' + (pay.payments.length ? 'Rest ' + kr(rest) + ' – vælg betalingsform' : 'Vælg betalingsform') + '</div><div class="pos-methods">' + avail.map(function (m) { return '<button type="button" data-method="' + esc(m.key) + '">' + esc(m.label) + '</button>'; }).join('') + '</div></div>' : '') +
      (c.total > 0 && covered && avail.length && !cash ? '' : '') +
      (pay.needApproval ? '<fieldset class="pos-fields two" style="border:1px solid var(--line);border-radius:12px;padding:12px"><legend class="small" style="font-weight:600">Rabatten på ' + pctText(c.discountBp) + ' skal godkendes</legend>' +
        '<div><label for="ap-email">Godkendt af (e-mail)</label><input id="ap-email" type="email" autocomplete="off" data-ap-email value="' + esc(pay.approvalEmail) + '"></div>' +
        '<div><label for="ap-pin">PIN-kode</label><input id="ap-pin" type="password" inputmode="numeric" maxlength="8" autocomplete="off" data-ap-pin></div></fieldset>' : '') +
      (pay.message ? '<div class="pos-msg ' + (pay.kind || '') + '" role="alert">' + pay.message + '</div>' : '') +
      '<div class="pos-dlg-foot"><button class="btn btn-secondary" type="button" data-close>Tilbage</button><button class="btn btn-primary pos-big" type="button" data-submit' + (payReady() && !pay.busy ? '' : ' disabled') + '>' + (pay.busy ? 'Gemmer …' : 'Gennemfør') + '</button></div></div>';
    var d = openDlg('pay', html);
    var r = d.querySelector('[data-recv]');
    if (r && document.activeElement !== r && !pay.focused) { r.focus(); pay.focused = true; }
  }
  function updateFoot() {
    var b = dlg('pay').querySelector('[data-submit]');
    if (b) b.disabled = !payReady() || pay.busy;
  }
  function submitSale() {
    if (!payReady() || pay.busy) return;
    var c = calc();
    pay.busy = true; pay.message = ''; renderPay();
    var payments = pay.payments.map(function (p) {
      return p.method === 'kontant' ? { key: p.key, received: p.received === null ? cashDue() : p.received } : { key: p.key, amount: p.amount, reference: p.reference };
    });
    api('POST', '/admin/kasse/api/salg', {
      key: state.key,
      lines: state.cart.map(function (l) { return { id: l.id, qty: l.qty, discount: l.discount }; }),
      order_discount: state.orderDiscount,
      customer: state.customer || {},
      note: state.note,
      payments: payments,
      expected_total: String(c.total),
      approver_email: pay.needApproval ? pay.approvalEmail : '',
      approver_pin: pay.needApproval ? (dlg('pay').querySelector('[data-ap-pin]') || {}).value || '' : ''
    }).then(function (j) {
      pay.busy = false;
      if (!j.ok) return saleFailed(j);
      if (j.sale.status === 'afventer') return cardWaiting(j.sale, j.stripeError);
      saleDone(j.sale);
    }).catch(function (e) {
      pay.busy = false;
      pay.kind = '';
      pay.message = e.fatal ? esc(e.message) : 'Ingen forbindelse til serveren. Prøv igen – salget registreres ikke to gange.';
      renderPay();
    });
  }
  function saleFailed(j) {
    pay.kind = '';
    if (j.code === 'approval_required' || j.code === 'approval_invalid' || j.code === 'approval_rate') pay.needApproval = true;
    var msg = esc(j.message || 'Salget kunne ikke gennemføres.');
    if (j.short && j.short.length) msg += '<ul style="margin:6px 0 0;padding-left:18px">' + j.short.map(function (s) { return '<li>' + esc(s.name) + ': ' + s.quantity + ' i kurven, ' + s.available + ' kan sælges</li>'; }).join('') + '</ul>';
    pay.message = msg;
    if (j.code === 'price_changed' || j.code === 'stock' || j.code === 'unknown_product') {
      loadProducts(true).then(function () { renderPay(); });
    }
    renderPay();
  }
  var pollTimer = null;
  function cardWaiting(sale, err) {
    pay.sale = sale;
    var failed = !!err;
    var d = openDlg('pay', '<div class="pos-dlg">' + head('pay-title', 'Kortbetaling · salg #' + sale.number) +
      '<div class="pos-due">' + kr(sale.payments.filter(function (p) { return p.method === 'stripe_terminal'; }).reduce(function (a, p) { return a + p.amount; }, 0)) + '</div>' +
      '<div class="row" style="gap:12px;display:flex;align-items:center" data-card-state>' + (failed ? '<div class="pos-msg" role="alert">' + esc(err) + '</div>' : '<span class="pos-spin" aria-hidden="true"></span><span>Kunden betaler på kortlæseren …</span>') + '</div>' +
      '<p class="small muted">Varerne er reserveret, til betalingen er gennemført eller salget annulleret.</p>' +
      '<div class="pos-dlg-foot"><button class="btn btn-danger" type="button" data-card-cancel>Annullér salg</button><button class="btn btn-secondary" type="button" data-card-retry' + (failed ? '' : ' hidden') + '>Prøv igen</button></div></div>');
    d.querySelector('[data-card-cancel]').onclick = function () { cancelCard(sale); };
    d.querySelector('[data-card-retry]').onclick = function () {
      api('POST', '/admin/kasse/api/salg/' + sale.id + '/kort', {}).then(function (j) { cardWaiting(j.sale || sale, j.ok ? null : j.message); }).catch(function (e) { toast(e.message, 'err'); });
    };
    clearTimeout(pollTimer);
    if (!failed) poll(sale);
  }
  function poll(sale) {
    pollTimer = setTimeout(function () {
      if (!dlg('pay').open) return;
      api('GET', '/admin/kasse/api/salg/' + sale.id + '/status').then(function (j) {
        if (!j.ok) throw new Error(j.message);
        if (j.card.state === 'betalt') return saleDone(j.sale);
        if (j.card.state === 'annulleret') { closeDlg('pay'); toast('Salget er annulleret.', ''); state.key = newKey(); save(); return; }
        var box = dlg('pay').querySelector('[data-card-state]');
        if (j.card.state === 'fejlet') {
          box.innerHTML = '<div class="pos-msg" role="alert">' + esc(j.card.message) + '</div>';
          dlg('pay').querySelector('[data-card-retry]').hidden = false;
          return;
        }
        box.innerHTML = '<span class="pos-spin" aria-hidden="true"></span><span>' + esc(j.card.message) + '</span>';
        poll(sale);
      }).catch(function () { poll(sale); });
    }, 2000);
  }
  function cancelCard(sale) {
    confirmBox('Annullér salget?', 'Kortbetalingen stoppes, og varerne frigives. Er der betalt en del kontant, skal det gives tilbage til kunden.', 'Annullér salg', function () {
      api('POST', '/admin/kasse/api/salg/' + sale.id + '/annuller', { reason: 'Annulleret i kassen' }).then(function (j) {
        if (j.ok && j.completed) return saleDone(j.sale);
        if (!j.ok) { toast(j.message, 'err'); return; }
        clearTimeout(pollTimer);
        closeDlg('pay');
        state.key = newKey(); save();
        toast('Salget er annulleret. Kurven er bevaret.', '');
        loadProducts(true);
      }).catch(function (e) { toast(e.message, 'err'); });
    });
  }
  function saleDone(sale) {
    clearTimeout(pollTimer);
    closeDlg('pay');
    var email = (state.customer && state.customer.email) || sale.email || '';
    clearSale();
    loadProducts(true);
    var d = openDlg('done', '<div class="pos-dlg pos-done">' + '<div class="pos-check" aria-hidden="true">✓</div><h2 id="done-title">Salg #' + sale.number + ' er gennemført</h2>' +
      (sale.change ? '<div class="small muted">Byttepenge</div><div class="pos-due">' + kr(sale.change) + '</div>' : '<div class="pos-due">' + kr(sale.total + sale.rounding) + '</div>') +
      '<div class="small muted">' + sale.payments.filter(function (p) { return p.status === 'gennemfoert'; }).map(function (p) { return esc(p.label) + ' ' + kr(p.amount); }).join(' + ') + '</div>' +
      '<div class="pos-dlg-foot" style="justify-content:center"><a class="btn btn-secondary" href="' + sale.receiptUrl + '?print=1" target="_blank" rel="noopener">Udskriv kvittering</a><button class="btn btn-primary pos-big" type="button" data-close autofocus>Nyt salg</button></div>' +
      (cfg.canEmail ? '<form class="pos-fields" style="width:100%" data-mail><label for="mail-to">Send kvittering på e-mail</label><div style="display:flex;gap:8px"><input id="mail-to" type="email" required value="' + esc(email) + '" placeholder="kunde@example.dk"><button class="btn btn-secondary" type="submit">Send</button></div></form>' : '') +
      '</div>');
    if (cfg.autoPrint) window.open(sale.receiptUrl + '?print=1', '_blank', 'noopener');
    var mf = d.querySelector('[data-mail]');
    if (mf) mf.onsubmit = function (e) {
      e.preventDefault();
      var btn = mf.querySelector('button'); btn.disabled = true;
      api('POST', '/admin/kasse/api/salg/' + sale.id + '/send', { email: mf.querySelector('input').value }).then(function (j) {
        btn.disabled = false;
        toast(j.message, j.ok ? 'ok' : 'err');
      }).catch(function (er) { btn.disabled = false; toast(er.message, 'err'); });
    };
    d.addEventListener('close', function () { $('#pos-q').focus(); }, { once: true });
  }

  // ---------- Hændelser ----------
  root.addEventListener('click', function (e) {
    var t = e.target.closest('button, [data-close]');
    if (!t) return;
    if (t.hasAttribute('data-close')) { var dd = t.closest('dialog'); if (dd) dd.close(); return; }
    var id;
    if ((id = t.getAttribute('data-add'))) { add(Number(id)); return; }
    if ((id = t.getAttribute('data-inc'))) { var l = inCart(Number(id)); setQty(Number(id), l.qty + 1); return; }
    if ((id = t.getAttribute('data-dec'))) { var l2 = inCart(Number(id)); if (l2.qty <= 1) remove(Number(id)); else setQty(Number(id), l2.qty - 1); return; }
    if ((id = t.getAttribute('data-remove'))) { remove(Number(id)); return; }
    if ((id = t.getAttribute('data-line-disc'))) { discountDialog(Number(id)); return; }
    if (t.hasAttribute('data-cat')) { state.cat = t.getAttribute('data-cat'); renderCats(); renderGrid(); return; }
    if (t.hasAttribute('data-method')) { addPayment(t.getAttribute('data-method')); return; }
    if (t.hasAttribute('data-unpay')) { pay.payments.splice(Number(t.getAttribute('data-unpay')), 1); renderPay(); return; }
    if (t.hasAttribute('data-recv-q')) { var cp = pay.payments.filter(function (p) { return p.method === 'kontant'; })[0]; cp.received = Number(t.getAttribute('data-recv-q')); renderPay(); return; }
    if (t.hasAttribute('data-submit')) { submitSale(); return; }
    var act = t.getAttribute('data-act');
    if (act === 'pay') { root.classList.remove('cart-open'); payDialog(); }
    else if (act === 'customer') customerDialog();
    else if (act === 'discount') { if (state.cart.length) discountDialog(null); }
    else if (act === 'remove-order-discount') { state.orderDiscount = null; changed(); }
    else if (act === 'remove-customer') { state.customer = null; changed(); }
    else if (act === 'clear') { if (state.cart.length) confirmBox('Tøm kurven?', 'Alle varer, rabatter, kunde og note fjernes fra salget.', 'Tøm kurven', function () { clearSale(); toast('Kurven er tømt.', ''); }); }
    else if (act === 'toggle-cart') root.classList.toggle('cart-open');
    else if (act === 'reload') loadProducts();
  });
  root.addEventListener('input', function (e) {
    var t = e.target;
    if (t.id === 'pos-q') { state.q = t.value; renderGrid(); return; }
    if (t.id === 'pos-note') { state.note = t.value.slice(0, 1000); save(); return; }
    if (!pay) return;
    if (t.hasAttribute('data-recv')) {
      var cp = pay.payments.filter(function (p) { return p.method === 'kontant'; })[0];
      var v = parseKr(t.value); cp.received = v === null ? null : v;
      var cd = cashDue(), rec = cp.received === null ? cd : cp.received;
      var ch = dlg('pay').querySelector('[data-change]');
      ch.textContent = rec < cd ? 'mangler ' + kr(cd - rec) : kr(rec - cd);
      ch.classList.toggle('short', rec < cd);
      updateFoot(); return;
    }
    if (t.hasAttribute('data-amt')) { var v2 = parseKr(t.value); pay.payments[Number(t.getAttribute('data-amt'))].amount = v2 || 0; updateFoot(); return; }
    if (t.hasAttribute('data-ref')) { pay.payments[Number(t.getAttribute('data-ref'))].reference = t.value; return; }
    if (t.hasAttribute('data-ap-email')) { pay.approvalEmail = t.value; return; }
  });
  root.addEventListener('change', function (e) {
    var t = e.target;
    if (t.hasAttribute('data-qty')) { setQty(Number(t.getAttribute('data-qty')), parseInt(t.value, 10)); return; }
    if (pay && t.hasAttribute('data-conf')) { pay.payments[Number(t.getAttribute('data-conf'))].confirmed = t.checked; updateFoot(); }
  });
  // Beløbsfelt forladt: tegn betalingen igen (rest og betalingsformer), men ikke hvis fokus går til en
  // knap eller et andet felt; knappens egen handling tegner igen, og et klik må ikke gå tabt.
  root.addEventListener('focusout', function (e) {
    if (!pay || !e.target.hasAttribute || !e.target.hasAttribute('data-amt')) return;
    if (e.relatedTarget && (e.relatedTarget.tagName === 'BUTTON' || e.relatedTarget.tagName === 'INPUT')) return;
    setTimeout(function () { if (dlg('pay').open && !pay.busy && !pay.sale) renderPay(); }, 0);
  });
  root.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && pay && dlg('pay').open && e.target.matches('[data-recv],[data-amt],[data-ap-pin]')) { e.preventDefault(); if (e.target.hasAttribute('data-amt')) renderPay(); else submitSale(); }
  });

  // Søgefeltet: Enter med præcist varenummer/stregkode (eller ét resultat) lægger varen i kurven
  function lookup(code) {
    var c = String(code).trim().toLowerCase();
    if (!c) return null;
    for (var i = 0; i < state.products.length; i++) {
      var p = state.products[i];
      if ((p.barcode && p.barcode.toLowerCase() === c) || p.sku.toLowerCase() === c) return p;
    }
    return null;
  }
  $('#pos-q').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    var exact = lookup(this.value);
    var list = visible();
    var p = exact && (cfg.scannerAutoAdd || !cfg.scanner) ? exact : list.length === 1 ? list[0] : null;
    if (p) { if (p.available === 0) toast(p.name + ' er udsolgt.', 'err'); else { add(p.id); toast(p.name + ' lagt i kurven', 'ok'); } this.value = ''; state.q = ''; renderGrid(); }
    else if (exact) { state.q = this.value; renderGrid(); }
    else if (!list.length) toast('Ingen vare med "' + this.value + '".', 'err');
  });

  // Stregkodescanner uden for søgefeltet: hurtige tastetryk afsluttet med Enter
  var buf = '', last = 0;
  document.addEventListener('keydown', function (e) {
    var t = e.target;
    var typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    var anyDialog = $$('dialog').some(function (d) { return d.open; });
    // Genveje
    if (!anyDialog) {
      if ((e.key === '/' && !typing) || e.key === 'F2') { e.preventDefault(); $('#pos-q').focus(); $('#pos-q').select(); return; }
      if (e.key === 'F4') { e.preventDefault(); customerDialog(); return; }
      if (e.key === 'F6') { e.preventDefault(); if (state.cart.length) discountDialog(null); return; }
      if (e.key === 'F8') { e.preventDefault(); root.querySelector('[data-act=clear]').click(); return; }
      if (e.key === 'F9' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); if (state.cart.length) payDialog(); return; }
    }
    if (!cfg.scanner || typing || anyDialog || e.ctrlKey || e.metaKey || e.altKey) return;
    var now = Date.now();
    if (e.key === 'Enter') {
      if (buf.length >= 3) {
        e.preventDefault();
        var p = lookup(buf);
        if (p && cfg.scannerAutoAdd) { if (p.available === 0) toast(p.name + ' er udsolgt.', 'err'); else { add(p.id); toast(p.name + ' lagt i kurven', 'ok'); } }
        else if (p) { $('#pos-q').value = buf; state.q = buf; renderGrid(); }
        else toast('Ukendt stregkode: ' + buf, 'err');
      }
      buf = ''; return;
    }
    if (e.key.length !== 1) return;
    if (now - last > 60) buf = '';
    buf += e.key; last = now;
  });

  restore();
  renderCart();
  loadProducts();
  setInterval(function () { if (!$$('dialog').some(function (d) { return d.open; })) loadProducts(true); }, 60000);
  window.addEventListener('beforeunload', save);
})();
`;
