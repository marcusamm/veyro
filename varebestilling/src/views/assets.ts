// Statiske filer serveres fra Workeren selv (ingen tredjeparts-CDN eller skrifttyper).
// Farven --accent sættes pr. butik i layoutet ud fra indstillingerne.

export const CSS = `
:root{
  --bg:#F6F7F9;--surface:#FFFFFF;--ink:#111827;--muted:#5B6474;--line:#E3E6EB;--line-strong:#CDD2DA;
  --accent:#1F5EFF;--accent-ink:#FFFFFF;--accent-soft:rgba(31,94,255,.08);
  --ok:#17663A;--ok-bg:#E4F4EA;--warn:#8A4B00;--warn-bg:#FDF0DC;--err:#A3241A;--err-bg:#FBE4E1;--info-bg:#E8EEFB;
  --r:12px;--r-sm:8px;
  --font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--font);font-size:16px;line-height:1.5;
  -webkit-font-smoothing:antialiased;min-height:100vh;display:flex;flex-direction:column}
a{color:inherit;text-underline-offset:3px}
a:hover{color:var(--accent)}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px;border-radius:4px}
img{max-width:100%;display:block}
h1,h2,h3{line-height:1.2;margin:0;letter-spacing:-.01em}
h1{font-size:28px}h2{font-size:20px}h3{font-size:16px}
@media(min-width:720px){h1{font-size:34px}}
p{margin:0}
.skip{position:absolute;left:-9999px;top:8px;background:var(--ink);color:#fff;padding:8px 12px;border-radius:var(--r-sm);z-index:10}
.skip:focus{left:16px}
.wrap{width:100%;max-width:1160px;margin:0 auto;padding:0 16px}
@media(min-width:720px){.wrap{padding:0 28px}}
main{flex:1;padding:24px 0 56px}
@media(min-width:720px){main{padding:36px 0 72px}}
.muted{color:var(--muted)}.small{font-size:14px}.xs{font-size:13px}
.nowrap{white-space:nowrap}.right{text-align:right}.num{font-variant-numeric:tabular-nums}
.stack>*+*{margin-top:12px}.stack-lg>*+*{margin-top:24px}.stack-sm>*+*{margin-top:6px}
.stack>input[type=hidden]+*,.stack-lg>input[type=hidden]+*,.stack-sm>input[type=hidden]+*{margin-top:0}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.row-between{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.grow{flex:1}
.narrow{max-width:560px}
.hidden{display:none!important}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}

/* Header */
.site-header{background:var(--surface);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
.site-header .wrap{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:64px}
.brand{font-weight:700;font-size:19px;text-decoration:none;display:flex;align-items:center;gap:10px;min-width:0}
.brand-dot{width:12px;height:12px;border-radius:50%;background:var(--accent);flex:none}
.brand-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@media(max-width:559px){.hide-sm{display:none!important}}
.header-right{display:flex;align-items:center;gap:8px}
.cart-link{display:inline-flex;align-items:center;gap:8px;text-decoration:none;font-weight:600;padding:9px 14px;border-radius:999px;border:1px solid var(--line-strong);background:var(--surface)}
.cart-link:hover{border-color:var(--accent);color:var(--ink)}
.badge-count{background:var(--accent);color:var(--accent-ink);border-radius:999px;font-size:13px;min-width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;padding:0 6px}

/* Admin-navigation */
.admin-nav{background:var(--surface);border-bottom:1px solid var(--line)}
.admin-nav ul{list-style:none;margin:0;padding:0;display:flex;gap:4px;overflow-x:auto;scrollbar-width:none}
.admin-nav ul::-webkit-scrollbar{display:none}
.admin-nav a{display:block;padding:12px 12px;text-decoration:none;color:var(--muted);font-weight:500;white-space:nowrap;border-bottom:2px solid transparent}
.admin-nav a:hover{color:var(--ink)}
.admin-nav a[aria-current=page]{color:var(--ink);border-bottom-color:var(--accent)}
.nav-count{background:var(--err);color:#fff;border-radius:999px;font-size:12px;padding:1px 7px;margin-left:4px}

/* Footer */
.site-footer{border-top:1px solid var(--line);padding:24px 0;color:var(--muted);font-size:14px;background:var(--surface)}
.site-footer .wrap{display:flex;flex-wrap:wrap;gap:8px 24px;justify-content:space-between}
.site-footer nav{display:flex;flex-wrap:wrap;gap:8px 16px}

/* Knapper */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;font:inherit;font-weight:600;font-size:15px;
  padding:11px 18px;border-radius:var(--r-sm);border:1px solid transparent;cursor:pointer;text-decoration:none;line-height:1.2;
  min-height:44px;transition:background .15s,border-color .15s,filter .15s}
.btn-primary{background:var(--accent);color:var(--accent-ink)}
.btn-primary:hover{filter:brightness(.92);color:var(--accent-ink)}
.btn-secondary{background:var(--surface);color:var(--ink);border-color:var(--line-strong)}
.btn-secondary:hover{border-color:var(--ink);color:var(--ink)}
.btn-danger{background:var(--surface);color:var(--err);border-color:#E9B8B2}
.btn-danger:hover{background:var(--err-bg);color:var(--err)}
.btn-ghost{background:none;color:var(--muted);padding:8px 10px;min-height:36px}
.btn-ghost:hover{color:var(--ink)}
.btn-small{padding:7px 12px;font-size:14px;min-height:36px}
.btn-block{width:100%}
.btn[disabled]{opacity:.5;cursor:not-allowed}
form.inline{display:inline}

/* Kort og paneler */
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:20px}
@media(min-width:720px){.card{padding:24px}}
.card-flush{padding:0;overflow:hidden}
.grid{display:grid;gap:16px}
@media(min-width:720px){.grid-2{grid-template-columns:1fr 1fr}.grid-3{grid-template-columns:repeat(3,1fr)}.grid-4{grid-template-columns:repeat(4,1fr)}}
.layout-side{display:grid;gap:24px}
@media(max-width:959px){.layout-side>.side-first{order:-1}}
@media(min-width:960px){.layout-side{grid-template-columns:minmax(0,1fr) 360px;align-items:start}.layout-side>.side{position:sticky;top:88px}}
.stat{display:block;text-decoration:none}
.stat .n{font-size:30px;font-weight:700;line-height:1.1;font-variant-numeric:tabular-nums}
.stat .l{color:var(--muted);font-size:14px}
a.stat:hover{border-color:var(--accent);color:var(--ink)}

/* Formularer */
label{display:block;font-weight:600;font-size:14px;margin-bottom:6px}
.field+.field{margin-top:16px}
.fields{display:grid;gap:16px}
@media(min-width:720px){.fields-2{grid-template-columns:1fr 1fr}.fields-3{grid-template-columns:1fr 1fr 1fr}}
.fields>.field+.field{margin-top:0}
.hint{color:var(--muted);font-size:13px;margin-top:6px;font-weight:400}
input[type=text],input[type=email],input[type=tel],input[type=number],input[type=search],input[type=url],input:not([type]),select,textarea{
  width:100%;font:inherit;font-size:16px;padding:10px 12px;border:1px solid var(--line-strong);border-radius:var(--r-sm);background:#fff;color:var(--ink);min-height:44px}
textarea{min-height:110px;resize:vertical}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
input[aria-invalid=true]{border-color:var(--err)}
input[type=color]{width:56px;height:44px;padding:4px;border:1px solid var(--line-strong);border-radius:var(--r-sm);background:#fff}
input[type=file]{font:inherit;font-size:15px}
.check{display:flex;gap:10px;align-items:flex-start;font-weight:500;font-size:15px}
.check input{width:20px;height:20px;margin:1px 0 0;accent-color:var(--accent);flex:none}
.radio-cards{display:grid;gap:10px}
@media(min-width:560px){.radio-cards{grid-template-columns:1fr 1fr}}
.radio-card{display:flex;gap:12px;align-items:flex-start;border:1px solid var(--line-strong);border-radius:var(--r-sm);padding:14px;cursor:pointer;font-weight:500;margin:0}
.radio-card:has(input:checked){border-color:var(--accent);box-shadow:0 0 0 1px var(--accent);background:var(--accent-soft)}
.radio-card input{width:20px;height:20px;margin:1px 0 0;accent-color:var(--accent);flex:none}
.radio-card strong{display:block}
.qty{width:84px!important;text-align:center}
fieldset{border:0;margin:0;padding:0;min-width:0}
legend{font-weight:700;font-size:16px;padding:0;margin-bottom:12px}

/* Beskeder */
.alert{padding:12px 16px;border-radius:var(--r-sm);font-size:15px}
.alert-info{background:var(--info-bg)}
.alert-ok{background:var(--ok-bg);color:var(--ok)}
.alert-warn{background:var(--warn-bg);color:var(--warn)}
.alert-err{background:var(--err-bg);color:var(--err)}
.alert ul{margin:6px 0 0;padding-left:20px}

/* Mærker */
.tag{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;padding:3px 10px;border-radius:999px;white-space:nowrap;background:#EEF0F3;color:var(--muted)}
.tag::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.tag-ny{background:var(--info-bg);color:#1D4ED8}
.tag-bekraeftet{background:#EDE7FB;color:#5B21B6}
.tag-klar{background:var(--warn-bg);color:var(--warn)}
.tag-afsluttet{background:var(--ok-bg);color:var(--ok)}
.tag-annulleret{background:#EEF0F3;color:var(--muted)}
.tag-ok{background:var(--ok-bg);color:var(--ok)}
.tag-low{background:var(--warn-bg);color:var(--warn)}
.tag-out{background:var(--err-bg);color:var(--err)}
.tag-off{background:#EEF0F3;color:var(--muted)}

/* Tabeller */
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table.list{width:100%;border-collapse:collapse;font-size:15px}
table.list th{text-align:left;font-size:13px;font-weight:600;color:var(--muted);padding:12px 16px;border-bottom:1px solid var(--line);white-space:nowrap;background:#FAFBFC}
table.list td{padding:12px 16px;border-bottom:1px solid var(--line);vertical-align:middle}
table.list tr:last-child td{border-bottom:0}
table.list tr.row-link{cursor:pointer}
table.list tr.row-link:hover td{background:#FAFBFC}
table.list .right{text-align:right}
table.list a.title{font-weight:600;text-decoration:none}
table.list a.title:hover{text-decoration:underline}
/* Mobil: tabeller bliver til kort */
@media(max-width:719px){
  table.list.stackable thead{display:none}
  table.list.stackable,table.list.stackable tbody,table.list.stackable tr,table.list.stackable td{display:block;width:100%}
  table.list.stackable tr{padding:12px 16px;border-bottom:1px solid var(--line)}
  table.list.stackable tr:last-child{border-bottom:0}
  table.list.stackable td{padding:2px 0;border:0;text-align:left!important}
  table.list.stackable td[data-label]::before{content:attr(data-label) ": ";color:var(--muted);font-size:13px}
  table.list.stackable td.cell-main{font-size:16px;padding-bottom:4px}
}
.totals{width:100%;border-collapse:collapse;font-size:15px}
.totals td{padding:6px 0}
.totals td:last-child{text-align:right;white-space:nowrap}
.totals tr.total td{font-weight:700;font-size:18px;border-top:1px solid var(--line);padding-top:12px}

/* Faner / filtre */
.tabs{display:flex;gap:6px;flex-wrap:wrap}
.tabs a{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border-radius:999px;border:1px solid var(--line-strong);text-decoration:none;font-size:14px;font-weight:500;background:var(--surface)}
.tabs a[aria-current=page]{background:var(--ink);border-color:var(--ink);color:#fff}
.tabs a .c{opacity:.7}
.toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.toolbar input[type=search]{flex:1;min-width:200px}
.toolbar select{width:auto}

/* Webshop */
.hero{display:flex;flex-direction:column;gap:10px;margin-bottom:24px}
.hero .lead{color:var(--muted);font-size:17px;max-width:720px;white-space:pre-line}
.cat-nav{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;margin:0 0 20px;scrollbar-width:thin}
.cat-nav a{flex:none;padding:8px 14px;border-radius:999px;border:1px solid var(--line-strong);text-decoration:none;font-size:14px;font-weight:500;background:var(--surface);white-space:nowrap}
.cat-nav a[aria-current=page]{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.cat-title{margin:0 0 14px;font-size:20px}
.shop-section+.shop-section{margin-top:36px}
.products{display:grid;gap:14px;grid-template-columns:1fr}
@media(min-width:560px){.products{grid-template-columns:1fr 1fr}}
@media(min-width:960px){.products{grid-template-columns:repeat(3,1fr)}}
.product{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);display:flex;flex-direction:column;overflow:hidden}
.product-img{aspect-ratio:4/3;background:#EEF0F3;object-fit:cover;width:100%}
.product-body{padding:16px;display:flex;flex-direction:column;gap:8px;flex:1}
.product-name{font-weight:700;font-size:16px}
.product-desc{color:var(--muted);font-size:14px;white-space:pre-line;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.product-meta{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:auto;padding-top:6px}
.price{font-weight:700;font-size:18px;font-variant-numeric:tabular-nums}
.price small{font-weight:500;color:var(--muted);font-size:13px}
.add-form{display:flex;gap:8px}
.add-form .btn{flex:1}
.empty{text-align:center;padding:48px 16px;color:var(--muted)}
.cart-line{display:grid;grid-template-columns:1fr auto;gap:8px 16px;padding:16px 0;border-bottom:1px solid var(--line)}
.cart-line:first-child{padding-top:0}
.cart-line .ctrl{display:flex;gap:8px;align-items:center;grid-column:1/-1}
@media(min-width:720px){.cart-line{grid-template-columns:1fr auto auto;align-items:center}.cart-line .ctrl{grid-column:auto}}
.steps{display:flex;gap:6px;font-size:14px;color:var(--muted);flex-wrap:wrap}
.steps b{color:var(--ink)}
.timeline{list-style:none;margin-bottom:0;padding:0}
.timeline li{position:relative;padding:0 0 16px 22px;font-size:14px}
.timeline li::before{content:"";position:absolute;left:4px;top:7px;width:9px;height:9px;border-radius:50%;background:var(--line-strong)}
.timeline li::after{content:"";position:absolute;left:8px;top:18px;bottom:0;width:1px;background:var(--line)}
.timeline li:last-child::after{display:none}
.timeline li:last-child::before{background:var(--accent)}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;font-size:15px;margin-bottom:0}
.kv dt{color:var(--muted)}.kv dd{margin:0;overflow-wrap:anywhere}
.devlink{word-break:break-all;font-size:14px}
pre.code{background:#F3F4F6;border-radius:var(--r-sm);padding:12px;font-size:13px;overflow-x:auto;margin:0}
.thumb{width:44px;height:44px;border-radius:6px;object-fit:cover;background:#EEF0F3}
.pager{display:flex;gap:8px;justify-content:center;margin-top:16px}

/* Bestillingsark */
.sheet-help{margin-bottom:10px}
.sheet-wrap{overflow:visible}
table.sheet{width:100%;border-collapse:collapse;font-size:15px}
table.sheet thead th{position:sticky;top:64px;z-index:2;background:#F3F4F6;text-align:left;font-size:13px;font-weight:600;color:var(--muted);padding:10px 12px;border-bottom:1px solid var(--line-strong);white-space:nowrap}
table.sheet thead th:first-child{border-top-left-radius:var(--r)}
table.sheet thead th:last-child{border-top-right-radius:var(--r)}
table.sheet td{padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:middle}
table.sheet td+td{border-left:1px solid var(--line)}
table.sheet .right{text-align:right}
.sheet-group th{background:#FAFBFC;text-align:left;font-size:14px;font-weight:700;padding:10px 12px;border-bottom:1px solid var(--line);scroll-margin-top:110px}
.sheet-row:hover td{background:#FAFBFC}
.sheet-row.has-qty td{background:var(--accent-soft)}
.sheet-row.is-out{color:var(--muted)}
.sheet-row label{margin:0;font-size:15px;font-weight:600;cursor:pointer}
.sheet-desc{display:block;color:var(--muted);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px}
.sheet-sub{display:none}
.c-sku{color:var(--muted);font-size:13px;white-space:nowrap}
.c-unit{color:var(--muted);white-space:nowrap}
.c-price,.c-sum{white-space:nowrap}
.c-sum{font-weight:600;min-width:96px}
.c-qty{width:104px}
table.sheet .sheet-qty{width:80px;min-height:38px;padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums}
.sheet-qty::-webkit-inner-spin-button,.sheet-qty::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
.sheet-qty{-moz-appearance:textfield;appearance:textfield}
.sheet-bar{position:sticky;bottom:0;z-index:4;margin-top:16px;padding:12px 0 0;background:linear-gradient(transparent,var(--bg) 12px)}
.sheet-bar-inner{display:flex;align-items:center;justify-content:space-between;gap:16px;background:var(--surface);border:1px solid var(--line-strong);border-radius:var(--r);padding:12px 12px 12px 18px;box-shadow:0 6px 24px rgba(17,24,39,.08)}
.sheet-total{display:flex;flex-direction:column;line-height:1.25}
.sheet-total strong{font-size:20px;font-variant-numeric:tabular-nums}
@media(max-width:719px){
  table.sheet .c-sku,table.sheet .c-unit,table.sheet .c-stock,table.sheet .c-price,table.sheet .c-sum{display:none}
  table.sheet td{padding:10px 12px}
  table.sheet td+td{border-left:0}
  .sheet-desc{display:none}
  .sheet-sub{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:center;color:var(--muted);font-size:13px;margin-top:2px}
  .sheet-sub .tag{font-size:12px;padding:1px 8px}
  .c-qty{width:92px}
  table.sheet .sheet-qty{width:76px;min-height:44px;font-size:16px}
  .sheet-bar-inner .btn{padding:11px 14px}
}
`;

export const JS = `
document.addEventListener('submit', function (e) {
  var f = e.target;
  var msg = f.getAttribute('data-confirm') || (e.submitter && e.submitter.getAttribute('data-confirm'));
  if (msg && !window.confirm(msg)) e.preventDefault();
});
// Kassen: vis kun adressefelter ved levering
function syncDelivery() {
  var box = document.getElementById('adresse');
  if (!box) return;
  var lev = document.querySelector('input[name=delivery][value=levering]');
  var on = !!(lev && lev.checked);
  box.classList.toggle('hidden', !on);
  box.querySelectorAll('input').forEach(function (i) { i.required = on; });
}
document.addEventListener('change', function (e) {
  if (e.target && e.target.name === 'delivery') syncDelivery();
  if (e.target && e.target.hasAttribute('data-autosubmit')) e.target.form.submit();
});
document.addEventListener('DOMContentLoaded', syncDelivery);
// Klikbare tabelrækker (linket i rækken er stadig det tilgængelige mål)
document.addEventListener('click', function (e) {
  var tr = e.target.closest && e.target.closest('tr[data-href]');
  if (!tr || e.target.closest('a,button,input,select,label')) return;
  window.location.href = tr.getAttribute('data-href');
});
// Bestillingsark: beløb pr. linje og i alt, tastaturnavigation som i et regneark og live-søgning
(function () {
  function kr(oere) {
    var kr = Math.floor(oere / 100), ore = oere % 100;
    var s = String(kr).replace(/\\B(?=(\\d{3})+(?!\\d))/g, '.');
    return s + (ore ? ',' + (ore < 10 ? '0' : '') + ore : '') + ' kr.';
  }
  function qtyOf(input) {
    var v = parseInt(input.value, 10);
    return isNaN(v) || v < 0 ? 0 : v;
  }
  function recalc(form) {
    var total = 0, count = 0;
    form.querySelectorAll('.sheet-row').forEach(function (tr) {
      var input = tr.querySelector('input[name]');
      var q = input ? qtyOf(input) : 0;
      var line = q * Number(tr.getAttribute('data-price'));
      tr.classList.toggle('has-qty', q > 0);
      tr.querySelector('[data-sum]').textContent = q > 0 ? kr(line) : '';
      if (q > 0) { total += line; count++; }
    });
    var c = form.querySelector('[data-count]');
    c.textContent = count;
    c.nextSibling.textContent = count === 1 ? ' vare valgt' : ' varer valgt';
    form.querySelector('[data-total]').textContent = kr(total);
  }
  function inputs(form) {
    return Array.prototype.filter.call(form.querySelectorAll('.sheet-qty:not([disabled])'), function (i) {
      return i.closest('tr').offsetParent !== null;
    });
  }
  document.addEventListener('input', function (e) {
    var f = e.target.closest && e.target.closest('.sheet-form');
    if (f && e.target.classList.contains('sheet-qty')) recalc(f);
  });
  document.addEventListener('focusin', function (e) {
    if (e.target.classList && e.target.classList.contains('sheet-qty')) e.target.select();
  });
  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (!t.classList || !t.classList.contains('sheet-qty')) return;
    var step = e.key === 'Enter' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    var list = inputs(t.form), i = list.indexOf(t), next = list[i + step];
    if (next) next.focus();
  });
  document.addEventListener('DOMContentLoaded', function () {
    var form = document.querySelector('.sheet-form');
    var search = document.querySelector('[data-sheet-search]');
    if (!form || !search) return;
    var box = search.querySelector('input[type=search]');
    if (box.value) return; // Søgning fra serveren: vis resultatet som det er
    search.addEventListener('submit', function (e) { e.preventDefault(); });
    box.addEventListener('input', function () {
      var words = box.value.toLowerCase().split(/\\s+/).filter(Boolean);
      var shown = 0;
      form.querySelectorAll('tbody').forEach(function (tb) {
        var rows = tb.querySelectorAll('.sheet-row');
        if (!rows.length) return;
        var any = 0;
        rows.forEach(function (tr) {
          var hay = tr.getAttribute('data-search');
          var ok = words.every(function (w) { return hay.indexOf(w) !== -1; });
          tr.classList.toggle('hidden', !ok);
          if (ok) any++;
        });
        var head = tb.querySelector('.sheet-group');
        if (head) head.classList.toggle('hidden', !any);
        shown += any;
      });
      form.querySelector('.sheet-none').classList.toggle('hidden', shown > 0);
      var nav = document.querySelector('.cat-nav');
      if (nav) nav.classList.toggle('hidden', words.length > 0);
    });
  });
})();
`;
