// Statiske filer serveres fra Workeren selv (ingen tredjeparts-CDN eller skrifttyper).
// Farven --accent sættes i layoutet ud fra indstillingerne.

export const CSS = `
:root{
  --bg:#F4F2EC;--surface:#FBFAF7;--ink:#0F0F0D;--muted:#55534D;--line:rgba(15,15,13,.12);--line-strong:rgba(15,15,13,.24);
  --hover:rgba(15,15,13,.035);--field:#FFFFFF;
  --accent:#FF5A1F;--accent-ink:#0F0F0D;--accent-rgb:255,90,31;--accent-soft:rgba(255,90,31,.1);
  --ok:#1F6B3A;--ok-bg:#E3F0E6;--warn:#8A4B00;--warn-bg:#FBEBD3;--err:#A3241A;--err-bg:#F8E1DE;--info-bg:#E7EEFB;
  --r:18px;--r-sm:10px;
  --shadow-lg:0 2px 4px rgba(15,15,13,.04),0 24px 60px -20px rgba(15,15,13,.22);
  --font:"Inter Tight",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
@font-face{font-family:"Inter Tight";src:url(/static/inter-tight.woff2) format("woff2");font-weight:100 900;font-style:normal;font-display:swap}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--font);font-size:16px;line-height:1.55;
  -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;font-feature-settings:'ss01','cv11';min-height:100vh;display:flex;flex-direction:column}
a{color:inherit;text-underline-offset:3px}
a:hover{color:var(--ink);text-decoration-color:var(--accent)}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px;border-radius:4px}
img{max-width:100%;display:block}
h1,h2,h3{line-height:1.1;margin:0;letter-spacing:-.025em;font-weight:600;text-wrap:balance}
h1{font-size:30px}h2{font-size:20px;letter-spacing:-.015em}h3{font-size:16px;letter-spacing:-.01em}
@media(min-width:720px){h1{font-size:40px}}
.eyebrow{font-size:14px;font-weight:600;color:var(--muted);margin-bottom:8px}
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
.site-header{background:rgba(244,242,236,.92);-webkit-backdrop-filter:saturate(1.4) blur(10px);backdrop-filter:saturate(1.4) blur(10px);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
.site-header .wrap{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:64px}
.brand{font-weight:650;font-size:19px;letter-spacing:-.02em;text-decoration:none;display:flex;align-items:center;gap:10px;min-width:0}
.brand-dot{width:12px;height:12px;border-radius:50%;background:var(--accent);flex:none}
.brand-logo{height:30px;width:auto;max-width:120px;object-fit:contain;flex:none}
@media(max-width:520px){.brand-logo{height:26px;max-width:84px}}
.brand-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@media(max-width:559px){.hide-sm{display:none!important}}
.header-right{display:flex;align-items:center;gap:8px}
.cart-link{display:inline-flex;align-items:center;gap:8px;text-decoration:none;font-weight:600;padding:9px 14px;border-radius:var(--r-sm);border:1px solid var(--line-strong);background:var(--surface)}
.cart-link:hover{border-color:var(--ink);color:var(--ink)}
.badge-count{background:var(--accent);color:var(--accent-ink);border-radius:999px;font-size:13px;min-width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;padding:0 6px}

/* Admin-navigation */
.admin-nav{background:var(--bg);border-bottom:1px solid var(--line)}
.admin-nav ul{list-style:none;margin:0;padding:0;display:flex;gap:4px;overflow-x:auto;scrollbar-width:none}
.admin-nav ul::-webkit-scrollbar{display:none}
.admin-nav a{display:block;padding:12px 12px;text-decoration:none;color:var(--muted);font-weight:500;white-space:nowrap;border-bottom:2px solid transparent}
.admin-nav a:hover{color:var(--ink)}
.admin-nav a[aria-current=page]{color:var(--ink);border-bottom-color:var(--ink)}
.nav-count{background:var(--accent);color:var(--accent-ink);border-radius:999px;font-size:12px;padding:1px 7px;margin-left:4px}

/* Footer */
.site-footer{border-top:1px solid var(--line);padding:24px 0;color:var(--muted);font-size:14px;background:var(--bg)}
.site-footer .wrap{display:flex;flex-wrap:wrap;gap:8px 24px;justify-content:space-between}
.site-footer nav{display:flex;flex-wrap:wrap;gap:8px 16px}

/* Knapper */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;font:inherit;font-weight:600;font-size:15px;
  padding:11px 18px;border-radius:var(--r-sm);border:1px solid transparent;cursor:pointer;text-decoration:none;line-height:1.2;
  min-height:44px;transition:background .15s,border-color .15s,filter .15s}
.btn-primary{background:var(--accent);color:var(--accent-ink)}
.btn-primary:hover{filter:brightness(.94);color:var(--accent-ink)}
.btn-dark{background:var(--ink);color:var(--bg)}
.btn-dark:hover{background:#2a2a26;color:var(--bg)}
.btn-secondary{background:transparent;color:var(--ink);border-color:var(--line-strong)}
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
tr.sec th{background:var(--bg);color:var(--muted);font-size:13px;font-weight:600;text-align:left;letter-spacing:.02em}
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
  width:100%;font:inherit;font-size:16px;padding:10px 12px;border:1px solid var(--line-strong);border-radius:var(--r-sm);background:var(--field);color:var(--ink);min-height:44px}
textarea{min-height:110px;resize:vertical}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--ink);box-shadow:0 0 0 3px rgba(var(--accent-rgb),.28)}
input[aria-invalid=true]{border-color:var(--err)}
input[type=color]{width:56px;height:44px;padding:4px;border:1px solid var(--line-strong);border-radius:var(--r-sm);background:#fff}
input[type=file]{font:inherit;font-size:15px}
.check{display:flex;gap:10px;align-items:flex-start;font-weight:500;font-size:15px}
.check input{width:20px;height:20px;margin:1px 0 0;accent-color:var(--ink);flex:none}
.radio-cards{display:grid;gap:10px}
@media(min-width:560px){.radio-cards{grid-template-columns:1fr 1fr}}
@media(min-width:720px){.radio-cards-3{grid-template-columns:1fr 1fr 1fr}}
.radio-card{display:flex;gap:12px;align-items:flex-start;border:1px solid var(--line-strong);border-radius:var(--r-sm);padding:14px;cursor:pointer;font-weight:500;margin:0}
.radio-card:has(input:checked){border-color:var(--ink);box-shadow:0 0 0 1px var(--ink);background:var(--surface)}
.radio-card input{width:20px;height:20px;margin:1px 0 0;accent-color:var(--ink);flex:none}
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

/* Mærker (pills som på hjemmesidens demo) */
.tag{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;line-height:1.5;padding:2px 9px;border-radius:999px;white-space:nowrap;background:rgba(15,15,13,.07);color:var(--ink)}
.tag-ny{background:rgba(var(--accent-rgb),.16);color:color-mix(in srgb,var(--accent) 45%,#2a0d00)}
.tag-bekraeftet{background:#E7EEFB;color:#1E40AF}
.tag-klar{background:#EDE7FB;color:#5B21B6}
.tag-afsluttet{background:var(--ok-bg);color:var(--ok)}
.tag-annulleret{background:rgba(15,15,13,.07);color:var(--muted)}
.tag-ok{background:var(--ok-bg);color:var(--ok)}
.tag-low{background:var(--warn-bg);color:var(--warn)}
.tag-out{background:var(--err-bg);color:var(--err)}
.tag-off{background:rgba(15,15,13,.07);color:var(--muted)}
.tag-src{background:transparent;border:1px solid var(--line-strong);color:var(--muted);font-weight:500}
tr.is-low>td:first-child{box-shadow:inset 3px 0 0 #F2B84B}
tr.is-out>td:first-child{box-shadow:inset 3px 0 0 #E5534B}

/* Tabeller */
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table.list{width:100%;border-collapse:collapse;font-size:15px}
table.list th{text-align:left;font-size:12.5px;font-weight:500;color:var(--muted);padding:12px 16px;border-bottom:1px solid var(--line);white-space:nowrap}
table.list td{padding:12px 16px;border-bottom:1px solid var(--line);vertical-align:middle}
table.list tr:last-child td{border-bottom:0}
table.list tr.row-link{cursor:pointer}
table.list tr.row-link:hover td{background:var(--hover)}
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
  table.list.stackable tr.sec{background:var(--bg);padding:8px 16px}
  table.list.stackable tr.sec th{display:block;padding:0;border:0}
}
.totals{width:100%;border-collapse:collapse;font-size:15px}
.totals td{padding:6px 0}
.totals td:last-child{text-align:right;white-space:nowrap}
.totals tr.total td{font-weight:700;font-size:18px;border-top:1px solid var(--line);padding-top:12px}

/* Faner / filtre */
.tabs{display:flex;gap:6px;flex-wrap:wrap}
.tabs a{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:8px;border:0;text-decoration:none;font-size:14px;font-weight:500;color:var(--muted);background:rgba(15,15,13,.05)}
.tabs a:hover{color:var(--ink);background:rgba(15,15,13,.08)}
.tabs a[aria-current=page]{background:var(--ink);color:var(--bg)}
.tabs a .c{font-weight:600}
.tabs a .c{opacity:.7}
.toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.toolbar input[type=search]{flex:1;min-width:200px}
.toolbar select{width:auto}
.suggest-wrap{position:relative}
.suggest{position:absolute;left:0;right:0;top:100%;z-index:6;margin:4px 0 0;padding:4px;list-style:none;background:var(--surface);border:1px solid var(--line-strong);border-radius:var(--r-sm);box-shadow:0 8px 24px rgba(15,15,13,.12);max-height:420px;overflow:auto}
.suggest li a{display:block;padding:8px 10px;border-radius:6px;text-decoration:none;color:var(--ink)}
.suggest li a small{display:block;color:var(--muted);font-size:13px}
.suggest li[aria-selected=true] a,.suggest li a:hover{background:var(--bg)}
.suggest li.more{padding:8px 10px;color:var(--muted);font-size:13px}

.empty{text-align:center;padding:48px 16px;color:var(--muted)}
.timeline{list-style:none;margin-bottom:0;padding:0}
.timeline li{position:relative;padding:0 0 16px 22px;font-size:14px}
.timeline li::before{content:"";position:absolute;left:4px;top:7px;width:9px;height:9px;border-radius:50%;background:var(--line-strong)}
.timeline li::after{content:"";position:absolute;left:8px;top:18px;bottom:0;width:1px;background:var(--line)}
.timeline li:last-child::after{display:none}
.timeline li:last-child::before{background:var(--accent)}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;font-size:15px;margin-bottom:0}
.kv dt{color:var(--muted)}.kv dd{margin:0;overflow-wrap:anywhere}
.devlink{word-break:break-all;font-size:14px}
pre.code{background:rgba(15,15,13,.05);border-radius:var(--r-sm);padding:12px;font-size:13px;overflow-x:auto;margin:0}
.thumb{width:44px;height:44px;border-radius:8px;object-fit:cover;background:rgba(15,15,13,.06)}
.pager{display:flex;gap:8px;justify-content:center;margin-top:16px}

/* Administrationspanel (som demoen på hjemmesiden) */
.page-head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap}
.page-head .eyebrow{margin-bottom:6px}
.stats{display:grid;gap:1px;background:var(--line);border:1px solid var(--line);border-radius:var(--r);overflow:hidden;grid-template-columns:1fr 1fr}
@media(min-width:900px){.stats{grid-template-columns:repeat(4,1fr)}}
.stats .stat{background:var(--surface);padding:16px 20px;display:flex;flex-direction:column;gap:2px;text-decoration:none}
.stats .stat .n{font-size:24px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.15}
.stats .stat .l{color:var(--muted);font-size:13.5px}
.stats a.stat:hover{background:#fff;color:var(--ink)}
.app{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow-lg);overflow:hidden;font-size:14.5px}
.app-bar{display:flex;align-items:center;gap:14px;padding:12px 16px;border-bottom:1px solid var(--line);min-height:52px}
.app-name{font-weight:600;font-size:14px}
.app-toast{margin-left:auto;display:inline-flex;align-items:center;gap:8px;padding:5px 12px;border-radius:999px;background:var(--ink);color:var(--bg);font-size:13px;font-weight:500;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.app-toast:hover{color:var(--bg);background:#2a2a26}
.app-toast-dot{width:7px;height:7px;border-radius:50%;background:var(--accent);flex:none}
.app-grid{display:grid;gap:1px;background:var(--line)}
.app-panel{background:var(--surface);padding:clamp(16px,1.2vw + 10px,24px);min-width:0}
@media(min-width:990px){
  .app-grid{grid-template-columns:minmax(0,1.25fr) minmax(0,1fr)}
  .app-panel--alerts{grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr;gap:0 32px;align-items:start}
}
@media(max-width:989px){.app-panel--alerts>div+div{margin-top:24px}}
.app-title{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}
.app-title h2{font-size:15px;font-weight:600;letter-spacing:0}
.app-title a{color:var(--muted)}
.tabs-sm{margin-bottom:12px;gap:6px}
.tabs-sm a{font-size:12.5px;padding:4px 10px}
.tabs-sm a b{font-weight:600;margin-left:2px}
table.mini{width:100%;border-collapse:collapse;font-size:13.5px}
table.mini th{text-align:left;font-weight:500;color:var(--muted);font-size:12px;padding:7px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
table.mini td{padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
table.mini tr:last-child td{border-bottom:0}
table.mini .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
table.mini td a{text-decoration:none;font-weight:600}
table.mini td a:hover{text-decoration:underline}
table.mini td small{display:block;color:var(--muted);font-size:11.5px;font-family:var(--mono)}
table.mini td .tag{margin-left:6px;font-size:11.5px;padding:1px 7px}
table.mini tr.row-link{cursor:pointer}
table.mini tr.row-link:hover td{background:var(--hover)}
.app-alerts{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.app-alerts li{display:grid;gap:2px;padding:10px 12px;border-radius:10px;background:var(--warn-bg);color:#5C3200;font-size:13.5px}
.app-alerts li.is-out{background:var(--err-bg);color:#7A1B13}
.app-alerts a{text-decoration:none;color:inherit}
.app-alerts a:hover{text-decoration:underline}
.app-log{list-style:none;margin:0;padding:0;font-size:13.5px}
.app-log li{display:flex;justify-content:space-between;gap:16px;padding:8px 0;border-bottom:1px dashed var(--line)}
.app-log li:last-child{border-bottom:0}
.app-log em{font-style:normal;color:var(--muted);text-align:right}
.app-log a{font-weight:600;text-decoration:none}
@media(max-width:599px){
  .hide-xs{display:none}
  .app-toast{display:none}
  table.mini th,table.mini td{padding-inline:5px}
}

/* App (hjemmeskærm) */
.steps-list{margin:0;padding-left:20px;display:grid;gap:6px}
.app-banner{position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:20;display:flex;align-items:center;gap:12px;background:var(--ink);color:var(--bg);border-radius:14px;padding:12px 12px 12px 16px;box-shadow:var(--shadow-lg);font-size:14px}
.app-banner a{color:var(--bg);font-weight:600}
.app-banner .grow{line-height:1.35}
.app-banner button{background:none;border:0;color:#A9A69C;font-size:22px;line-height:1;padding:4px 6px;cursor:pointer}
.sheet-form .app-banner{display:none}
.sheet-bar{padding-bottom:env(safe-area-inset-bottom)}
@media(display-mode:standalone){.site-footer{padding-bottom:calc(24px + env(safe-area-inset-bottom))}}

/* Bestillingsark */
.sheet-help{margin-bottom:10px}
.sheet-wrap{overflow:visible}
table.sheet{width:100%;border-collapse:collapse;font-size:15px}
table.sheet thead th{position:sticky;top:64px;z-index:2;background:#EFEDE6;text-align:left;font-size:12.5px;font-weight:500;color:var(--muted);padding:10px 12px;border-bottom:1px solid var(--line-strong);white-space:nowrap}
table.sheet thead th:first-child{border-top-left-radius:var(--r)}
table.sheet thead th:last-child{border-top-right-radius:var(--r)}
table.sheet td{padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:middle}
table.sheet td+td{border-left:1px solid var(--line)}
table.sheet .right{text-align:right}
.sheet-group th{background:rgba(15,15,13,.03);text-align:left;font-size:14px;font-weight:700;padding:10px 12px;border-bottom:1px solid var(--line);scroll-margin-top:110px}
.sheet-row:hover td{background:var(--hover)}
.sheet-row.has-qty td{background:rgba(var(--accent-rgb),.07)}
.sheet-row.has-qty td:first-child{box-shadow:inset 3px 0 0 var(--accent)}
.sheet-row.is-out{color:var(--muted)}
.sheet-row label{margin:0;font-size:15px;font-weight:600;cursor:pointer}
.sheet-desc{display:block;color:var(--muted);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px}
.sheet-sub{display:none}
.c-sku{color:var(--muted);font-size:12.5px;font-family:var(--mono);white-space:nowrap}
.c-unit{color:var(--muted);white-space:nowrap}
.c-price,.c-sum{white-space:nowrap}
.c-sum{font-weight:600;min-width:96px}
.c-qty{width:104px}
table.sheet .sheet-qty{width:80px;min-height:38px;padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums}
.sheet-qty::-webkit-inner-spin-button,.sheet-qty::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
.sheet-qty{-moz-appearance:textfield;appearance:textfield}
.sheet-bar{position:sticky;bottom:0;z-index:4;margin-top:16px;padding:12px 0 0;background:linear-gradient(transparent,var(--bg) 12px)}
.sheet-bar-inner{display:flex;align-items:center;justify-content:space-between;gap:16px;background:var(--ink);color:var(--bg);border-radius:var(--r);padding:12px 12px 12px 20px;box-shadow:var(--shadow-lg)}
.sheet-bar-inner .muted{color:#A9A69C}
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

/* Lagerstyring */
.tag-crit{background:#FBDCC8;color:#8F2E07}
.tag-ready{background:#E7EEFB;color:#1E40AF}
.tag-ordered{background:#EDE7FB;color:#5B21B6}
.tag-sim{background:transparent;border:1px dashed var(--line-strong);color:var(--muted);font-weight:500}
.tag-sent{background:var(--ok-bg);color:var(--ok)}
.tag-fail{background:var(--err-bg);color:var(--err)}
tr.is-crit>td:first-child{box-shadow:inset 3px 0 0 #F08A4B}
.app-alerts li.is-crit{background:#FBDCC8;color:#6E2405}
.app-alerts li.is-info{background:var(--info-bg);color:#1E3A8A}
.app-alerts .row{gap:6px}
.portal{display:inline-flex;background:rgba(15,15,13,.06);border-radius:10px;padding:3px;gap:2px}
.portal a{padding:6px 12px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;color:var(--muted);white-space:nowrap}
.portal a[aria-current=page]{background:var(--surface);color:var(--ink);box-shadow:0 1px 2px rgba(15,15,13,.12)}
.user-name{font-size:14px;color:var(--muted);white-space:nowrap;max-width:160px;overflow:hidden;text-overflow:ellipsis}
.in-num{width:110px!important;text-align:right;font-variant-numeric:tabular-nums}
.in-sm{min-height:36px!important;padding:6px 8px!important;font-size:15px!important}
table.list td.num,table.list th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
table.list.dense td{padding:9px 12px}table.list.dense th{padding:10px 12px}
table.list td small,table.list td .sub{display:block;color:var(--muted);font-size:12.5px}
table.list .sku{color:var(--muted);font-size:12.5px;font-family:var(--mono)}
.miss{color:var(--muted);font-style:italic;font-size:13px;white-space:nowrap}
.meter{height:6px;border-radius:99px;background:rgba(15,15,13,.08);overflow:hidden;min-width:70px;margin-top:5px}
.meter>span{display:block;height:100%;background:var(--ok)}
.meter.low>span{background:#E9A23B}.meter.crit>span{background:#F08A4B}.meter.out>span{background:#E5534B}
details.act{position:relative}
details.act>summary{list-style:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;font-weight:600;font-size:14px;padding:7px 12px;border-radius:var(--r-sm);border:1px solid var(--line-strong);min-height:36px;white-space:nowrap}
details.act>summary::-webkit-details-marker{display:none}
details.act[open]>summary{border-color:var(--ink)}
details.act .act-body{margin-top:10px;display:grid;gap:10px;min-width:240px}
details.act form{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
details.act form input{width:100px}
.panel-note{font-size:13.5px;color:var(--muted)}
.big-actions{display:grid;gap:10px}
@media(min-width:560px){.big-actions{grid-template-columns:1fr 1fr}}
.big-action{display:flex;flex-direction:column;gap:2px;padding:16px;border-radius:var(--r);border:1px solid var(--line-strong);background:var(--surface);text-decoration:none}
.big-action strong{font-size:17px}
.big-action span{color:var(--muted);font-size:14px}
.big-action:hover{border-color:var(--ink);color:var(--ink)}
.big-action.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.big-action.primary span{color:inherit;opacity:.8}
.job-cards{display:grid;gap:12px}
@media(min-width:720px){.job-cards{grid-template-columns:1fr 1fr}}
@media(min-width:1040px){.job-cards{grid-template-columns:1fr 1fr 1fr}}
.job-card{display:flex;flex-direction:column;gap:6px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:16px 18px;text-decoration:none}
.job-card:hover{border-color:var(--ink);color:var(--ink)}
.job-card .no{font-family:var(--mono);font-size:12.5px;color:var(--muted)}
.job-card strong{font-size:17px;line-height:1.25}
.steps-demo{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.steps-demo li{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:16px 18px}
.steps-demo .check{display:inline-flex;font-weight:600;font-size:14px}
.ok-mark{color:var(--ok);font-weight:700}.bad-mark{color:var(--err);font-weight:700}
.sup-head td{background:rgba(15,15,13,.035);font-weight:700;font-size:14px}
.print-only{display:none}
@media print{
  .site-header,.admin-nav,.no-print,.app-banner{display:none!important}
  .print-only{display:block}
  body{background:#fff}
  main{padding:0}
  .card{border:0;padding:0}
  table.list th,table.list td{padding:6px 8px}
}
/* Prisestimat */
.tag-demo{background:#FEF3C7;color:#92400E;border:1px dashed #D97706}
.est-line{border-top:1px solid var(--line);padding:14px 16px;display:grid;gap:10px}
.est-line .alert{margin:0}
.est-pick{text-align:right}
tr.est-chosen td{background:rgba(var(--accent-rgb),.06)}
.est-total{border-top:1px solid var(--line);padding:14px 16px 16px}
.est-total .big{font-size:22px}
.ok-text{color:var(--ok)}.err-text{color:var(--err)}
.est td small .tag{margin-top:4px}
`;

export const JS = `
document.addEventListener('submit', function (e) {
  var f = e.target;
  var msg = f.getAttribute('data-confirm') || (e.submitter && e.submitter.getAttribute('data-confirm'));
  if (msg && !window.confirm(msg)) { e.preventDefault(); return; }
  // Undgå dobbeltklik (serveren afviser i forvejen samme registrering to gange)
  if (f.method && f.method.toLowerCase() === 'post' && !f.hasAttribute('data-multi')) {
    setTimeout(function () {
      f.querySelectorAll('button[type=submit],button:not([type])').forEach(function (b) { b.disabled = true; });
    }, 0);
  }
});
document.addEventListener('change', function (e) {
  if (e.target && e.target.hasAttribute('data-autosubmit')) e.target.form.submit();
  if (e.target && e.target.name === 'safety_method') syncSafety();
});
function syncSafety() {
  var sel = document.querySelector('input[name=safety_method]:checked');
  var v = sel ? sel.value : '';
  document.querySelectorAll('[data-safety]').forEach(function (el) {
    el.classList.toggle('hidden', el.getAttribute('data-safety') !== v);
  });
}
document.addEventListener('DOMContentLoaded', syncSafety);
// Klikbare tabelrækker (linket i rækken er stadig det tilgængelige mål)
document.addEventListener('click', function (e) {
  var tr = e.target.closest && e.target.closest('tr[data-href],div[data-href]');
  if (!tr || e.target.closest('a,button,input,select,label,summary,details')) return;
  window.location.href = tr.getAttribute('data-href');
});
// Registreringsark: tastaturnavigation som i et regneark, markering og live-søgning
(function () {
  function filled(input) { return input.value.trim() !== '' && input.value.trim() !== '0'; }
  function recalc(form) {
    var count = 0;
    form.querySelectorAll('.sheet-row').forEach(function (tr) {
      var input = tr.querySelector('.sheet-qty');
      var on = !!input && filled(input);
      tr.classList.toggle('has-qty', on);
      if (on) count++;
    });
    var c = form.querySelector('[data-count]');
    if (c) {
      c.textContent = count;
      c.nextSibling.textContent = count === 1 ? ' vare valgt' : ' varer valgt';
    }
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
    if (e.key === 'Enter' && t.type === 'search' && t.closest && t.closest('.sheet-form')) { e.preventDefault(); return; }
    if (!t.classList || !t.classList.contains('sheet-qty')) return;
    var step = e.key === 'Enter' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    var list = inputs(t.form), i = list.indexOf(t), next = list[i + step];
    if (next) next.focus();
  });
  document.addEventListener('DOMContentLoaded', function () {
    var form = document.querySelector('.sheet-form');
    if (form) recalc(form);
    var box = document.querySelector('[data-sheet-search]');
    if (!form || !box) return;
    box.addEventListener('input', function () {
      var words = box.value.toLowerCase().split(/\\s+/).filter(Boolean);
      var shown = 0;
      form.querySelectorAll('.sheet-row').forEach(function (tr) {
        var hay = tr.getAttribute('data-search');
        var ok = words.every(function (w) { return hay.indexOf(w) !== -1; });
        tr.classList.toggle('hidden', !ok);
        if (ok) shown++;
      });
      var none = form.querySelector('.sheet-none');
      if (none) none.classList.toggle('hidden', shown > 0);
    });
  });
})();
// Installerbar app
(function () {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
  }
  var deferred = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    document.querySelectorAll('[data-install]').forEach(function (el) { el.hidden = false; });
  });
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-install-button]');
    if (b && deferred) { deferred.prompt(); deferred = null; }
  });
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-print]');
    if (b) window.print();
  });
})();
`;
