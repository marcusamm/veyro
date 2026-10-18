// Statiske filer serveres fra Workeren selv (ingen tredjeparts-CDN eller skrifttyper).

export const CSS = `
@font-face{font-family:"Inter Tight";src:url(/static/inter-tight.woff2) format("woff2");font-weight:100 900;font-style:normal;font-display:swap}
:root{
  --bg:#F4F2EC;--surface:#FBFAF7;--ink:#0F0F0D;--muted:#55534D;--accent:#FF5A1F;
  --line:rgba(15,15,13,.10);--line-strong:rgba(15,15,13,.18);
  --ok:#1F6B3A;--ok-bg:#E3F0E6;--warn:#8A4B00;--warn-bg:#FBEBD3;--err:#A3241A;--err-bg:#F8E1DE;
  --r-card:18px;--r-btn:10px;
  --font:"Inter Tight","Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--font);font-size:16px;line-height:1.55;
  -webkit-font-smoothing:antialiased;min-height:100vh;display:flex;flex-direction:column}
a{color:var(--ink);text-decoration-thickness:1px;text-underline-offset:3px}
a:hover{text-decoration-color:var(--accent)}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px;border-radius:4px}
.skip{position:absolute;left:-9999px;top:8px;background:var(--ink);color:var(--surface);padding:8px 12px;border-radius:var(--r-btn);z-index:10}
.skip:focus{left:16px}
.wrap{width:100%;max-width:1040px;margin:0 auto;padding:0 16px}
@media(min-width:720px){.wrap{padding:0 32px}}

/* Header */
.site-header{padding:20px 0 0}
.site-header .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px}
.logo{font-weight:700;font-size:22px;letter-spacing:-.03em;text-decoration:none;color:var(--ink)}
.logo span{color:var(--accent)}
.header-right{display:flex;align-items:center;gap:12px;min-width:0}
.who{color:var(--muted);font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px;display:none}
@media(min-width:720px){.who{display:block}}
.nav{margin-top:20px;box-shadow:inset 0 -1px 0 var(--line)}
.nav ul{list-style:none;margin:0 -12px;padding:0;display:flex;gap:0;overflow-x:auto;scrollbar-width:none}
.nav ul::-webkit-scrollbar{display:none}
.nav a{display:block;padding:10px 12px 12px;text-decoration:none;color:var(--muted);font-size:15px;white-space:nowrap;border-bottom:2px solid transparent}
.nav .short{display:none}
@media(max-width:639px){.nav .long{display:none}.nav .short{display:inline}.nav a{padding:10px 10px 12px}.nav ul{margin:0 -10px}}
.nav a:hover{color:var(--ink)}
.nav a[aria-current="page"]{color:var(--ink);border-bottom-color:var(--accent);font-weight:600}

main{flex:1;padding:32px 0 56px}
@media(min-width:720px){main{padding:48px 0 72px}}

/* Typografi */
h1{font-size:28px;line-height:1.15;letter-spacing:-.025em;margin:0 0 8px;font-weight:650}
@media(min-width:720px){h1{font-size:36px}}
h2{font-size:20px;line-height:1.25;letter-spacing:-.015em;margin:0 0 12px;font-weight:650}
h3{font-size:16px;margin:0 0 4px;font-weight:650}
p{margin:0 0 12px}
.lead{color:var(--muted);font-size:17px;margin-bottom:28px;max-width:60ch}
.muted{color:var(--muted)}
.small{font-size:14px}
.eyebrow{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:600;margin:0 0 6px}

/* Kort og layout */
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-card);padding:24px}
@media(min-width:720px){.card{padding:32px}}
.stack>*+*{margin-top:16px}
.stack>input[type=hidden]:first-child+*,.stack>input[type=hidden]+input[type=hidden]+*{margin-top:0}
.stack-lg>*+*{margin-top:24px}
.grid{display:grid;gap:16px}
@media(min-width:720px){.grid-2{grid-template-columns:1fr 1fr}.grid-3{grid-template-columns:repeat(3,1fr)}}
.narrow{max-width:480px;margin:0 auto}
.medium{max-width:680px}
.row{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.between{justify-content:space-between}

/* Nøgletal */
.facts{display:grid;grid-template-columns:1fr;gap:0;margin:20px 0 0;padding:0}
@media(min-width:560px){.facts{grid-template-columns:1fr 1fr}}
.facts div{padding:14px 0;border-top:1px solid var(--line)}
@media(min-width:560px){.facts div:nth-child(odd){padding-right:16px}}
.facts dt{font-size:13px;color:var(--muted);margin-bottom:2px}
.facts dd{margin:0;font-weight:600;font-size:17px}
.plan-title{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.price-big{font-size:32px;font-weight:650;letter-spacing:-.02em}

/* Knapper */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:10px 18px;border-radius:var(--r-btn);
  font:inherit;font-weight:600;font-size:15px;line-height:1.2;text-decoration:none;cursor:pointer;border:1px solid transparent;
  transition:background-color .15s,border-color .15s,color .15s}
.btn-primary{background:var(--ink);color:var(--surface)}
.btn-primary:hover{background:#2A2A26}
.btn-accent{background:var(--accent);color:var(--ink)}
.btn-accent:hover{background:#FF7443}
.btn-secondary{background:transparent;color:var(--ink);border-color:var(--line-strong)}
.btn-secondary:hover{border-color:var(--ink)}
.btn-danger{background:transparent;color:var(--err);border-color:rgba(163,36,26,.35)}
.btn-danger:hover{border-color:var(--err);background:var(--err-bg)}
.btn-small{min-height:36px;padding:6px 12px;font-size:14px}
.btn-block{width:100%}
.btn[disabled],.btn[aria-disabled="true"]{opacity:.5;cursor:not-allowed}
.linkbtn{background:none;border:0;padding:0;font:inherit;color:var(--ink);text-decoration:underline;text-underline-offset:3px;cursor:pointer}
form.inline{display:inline}

/* Formularer */
label{display:block;font-weight:600;font-size:15px;margin-bottom:6px}
.hint{font-size:14px;color:var(--muted);margin-top:4px}
input[type=email],input[type=text],textarea,select{width:100%;font:inherit;font-size:16px;color:var(--ink);background:#fff;
  border:1px solid var(--line-strong);border-radius:var(--r-btn);padding:11px 14px;min-height:46px}
textarea{min-height:140px;resize:vertical;line-height:1.5}
select{appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--muted) 50%),linear-gradient(135deg,var(--muted) 50%,transparent 50%);
  background-position:calc(100% - 20px) 50%,calc(100% - 15px) 50%;background-size:5px 5px;background-repeat:no-repeat;padding-right:40px}
input:focus-visible,textarea:focus-visible,select:focus-visible{outline:3px solid var(--accent);outline-offset:1px;border-color:var(--ink)}
.field+.field{margin-top:18px}
fieldset{border:0;margin:0;padding:0}
legend{font-weight:600;font-size:15px;margin-bottom:8px;padding:0}
.choices{display:grid;gap:8px}
@media(min-width:560px){.choices{grid-template-columns:repeat(3,1fr)}}
.choice{position:relative}
.choice input{position:absolute;opacity:0;inset:0;width:100%;height:100%;margin:0;cursor:pointer}
.choice span{display:block;border:1px solid var(--line-strong);border-radius:var(--r-btn);padding:11px 14px;background:#fff;font-weight:500;text-align:center}
.choice input:checked+span{border-color:var(--ink);box-shadow:inset 0 0 0 1px var(--ink);font-weight:600}
.choice input:focus-visible+span{outline:3px solid var(--accent);outline-offset:2px}

/* Beskeder */
.alert{border-radius:12px;padding:14px 16px;font-size:15px;border:1px solid transparent}
.alert-info{background:var(--surface);border-color:var(--line)}
.alert-ok{background:var(--ok-bg);color:var(--ok)}
.alert-warn{background:var(--warn-bg);color:var(--warn)}
.alert-err{background:var(--err-bg);color:var(--err)}
.alert a{color:inherit}
.devlink{word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}

/* Status-mærker */
.badge{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;padding:4px 10px;border-radius:999px;white-space:nowrap;line-height:1.3}
.badge::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.b-ok{background:var(--ok-bg);color:var(--ok)}
.b-warn{background:var(--warn-bg);color:var(--warn)}
.b-err{background:var(--err-bg);color:var(--err)}
.b-neutral{background:rgba(15,15,13,.06);color:var(--muted)}
.b-accent{background:var(--accent);color:var(--ink)}
.b-accent::before{display:none}

/* Planer */
.plans{display:grid;gap:16px;align-items:stretch}
@media(min-width:880px){.plans{grid-template-columns:repeat(3,1fr)}}
.plan{display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-card);padding:28px;position:relative}
.plan.featured{border-color:var(--ink);box-shadow:0 1px 0 var(--ink),0 18px 40px -24px rgba(15,15,13,.35)}
.plan.selected{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent),0 18px 40px -24px rgba(15,15,13,.35)}
.plan .badge{position:absolute;top:-13px;left:28px}
.plan h2{font-size:22px;margin-bottom:4px}
.plan .price{font-size:34px;font-weight:650;letter-spacing:-.025em;margin:8px 0 2px}
.plan .price small{font-size:15px;font-weight:500;color:var(--muted);letter-spacing:0}
.plan .vat{font-size:13px;color:var(--muted);margin-bottom:20px}
.plan ul{list-style:none;padding:0;margin:0 0 24px;flex:1}
.plan li{padding:8px 0 8px 28px;position:relative;border-top:1px solid var(--line);font-size:15px}
.plan li::before{content:"";position:absolute;left:4px;top:15px;width:10px;height:6px;border-left:2px solid var(--accent);border-bottom:2px solid var(--accent);transform:rotate(-45deg)}
.plan.current{border-color:var(--line-strong)}

/* Tabeller og lister */
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:15px}
th{text-align:left;font-size:13px;color:var(--muted);font-weight:600;padding:10px 12px;border-bottom:1px solid var(--line-strong);white-space:nowrap}
td{padding:14px 12px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
th:first-child,td:first-child{padding-left:0}
th:last-child,td:last-child{padding-right:0}
.num{text-align:right;white-space:nowrap}
.list{list-style:none;margin:0;padding:0}
.list>li{padding:18px 0;border-top:1px solid var(--line)}
.list>li:first-child{border-top:0;padding-top:0}
.list>li:last-child{padding-bottom:0}
.card>.list:first-child{margin-top:0!important}
.item-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
.meta{font-size:14px;color:var(--muted)}
details summary{cursor:pointer;color:var(--muted);font-size:14px;margin-top:6px}
details[open] summary{margin-bottom:6px}
.prewrap{white-space:pre-wrap;word-break:break-word}
.empty{text-align:center;padding:24px 0;color:var(--muted)}

/* Mobil-tabeller: fakturaer som kort */
@media(max-width:639px){
  table.responsive thead{position:absolute;left:-9999px}
  table.responsive tr{display:block;padding:14px 0;border-bottom:1px solid var(--line)}
  table.responsive tr:last-child{border-bottom:0}
  table.responsive td{display:flex;justify-content:space-between;gap:16px;padding:3px 0;border:0;text-align:right}
  table.responsive td::before{content:attr(data-label);color:var(--muted);font-size:14px;text-align:left}
  table.responsive td.num{text-align:right}
}

/* Bekræftelse */
.compare{display:grid;grid-template-columns:1fr auto 1fr;gap:12px;align-items:center;margin:0}
.compare .box{border:1px solid var(--line);border-radius:14px;padding:16px;background:#fff}
.compare .arrow{color:var(--muted);font-size:20px}

/* Footer */
.site-footer{border-top:1px solid var(--line);padding:24px 0 32px;font-size:14px;color:var(--muted)}
.site-footer .wrap{display:flex;flex-wrap:wrap;gap:8px 20px;justify-content:space-between}
.site-footer nav{display:flex;flex-wrap:wrap;gap:8px 20px}
.site-footer a{color:var(--muted)}
.site-footer a:hover{color:var(--ink)}

.visually-hidden{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
`;

export const JS = `
// Forhindrer dobbelt-indsendelse af formularer
document.addEventListener('submit', function (e) {
  var form = e.target;
  if (!(form instanceof HTMLFormElement)) return;
  if (form.dataset.submitted === '1') { e.preventDefault(); return; }
  form.dataset.submitted = '1';
  var btns = form.querySelectorAll('button[type=submit],button:not([type])');
  btns.forEach(function (b) {
    b.setAttribute('aria-disabled', 'true');
    if (b.dataset.loading) b.textContent = b.dataset.loading;
  });
}, true);
// Sikrer at formularer kan sendes igen, hvis brugeren går tilbage i browseren
window.addEventListener('pageshow', function (e) {
  if (!e.persisted) return;
  document.querySelectorAll('form[data-submitted]').forEach(function (f) {
    delete f.dataset.submitted;
    f.querySelectorAll('[aria-disabled]').forEach(function (b) { b.removeAttribute('aria-disabled'); });
  });
});
// Tegntæller for tekstfelter med maxlength
document.querySelectorAll('textarea[maxlength][data-counter]').forEach(function (t) {
  var out = document.getElementById(t.dataset.counter);
  if (!out) return;
  var max = Number(t.getAttribute('maxlength'));
  var upd = function () { out.textContent = t.value.length + ' / ' + max + ' tegn'; };
  t.addEventListener('input', upd); upd();
});
`;

export const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0F0F0D"/><path d="M17 18h8l7 20 7-20h8L36 47h-8z" fill="#FBFAF7"/><circle cx="49" cy="45" r="4" fill="#FF5A1F"/></svg>`;
