type Folder = 'inbox' | 'sent' | 'archive';

interface Example {
  id: string;
  folder: Folder;
  name: string;
  address: string;
  initials: string;
  color: string;
  title: string;
  time: string;
  date: string;
  snippet: string;
  body: string[];
}

const examples: Example[] = [
  { id: 'oplaeg', folder: 'inbox', name: 'Sofie Lund', address: 'sofie@example.test', initials: 'SL', color: 'apricot',
    title: 'Oplæg til mødet på torsdag', time: '09.42', date: 'Tirsdag 17. november kl. 09.42',
    snippet: 'Jeg har samlet de tre punkter, vi talte om i fredags.',
    body: ['Hej,', 'Jeg har samlet de tre punkter, vi talte om i fredags. På torsdag foreslår jeg, at vi starter med tidsplanen og derefter ser på de første skitser sammen.', 'Jeg tager et print med til mødet. Hvis der er noget, du gerne vil have på dagsordenen, så skriv det endelig inden onsdag.', 'Vi ses torsdag!', 'Bedste hilsner\nSofie'] },
  { id: 'billeder', folder: 'inbox', name: 'Emil Vang', address: 'emil@example.test', initials: 'EV', color: 'moss',
    title: 'De sidste billeder er klar', time: '08.16', date: 'Tirsdag 17. november kl. 08.16',
    snippet: 'Nu ligger udvalget fra mandagens fotosession i projektmappen.',
    body: ['Godmorgen,', 'Nu ligger udvalget fra mandagens fotosession i projektmappen. Jeg har lagt de fire favoritter øverst, så de er nemme at finde.', 'Vil du se dem igennem inden vores møde? Jeg tager den store skærm med.', 'Hilsen\nEmil'] },
  { id: 'tilbud', folder: 'inbox', name: 'Anna Holm', address: 'anna@example.test', initials: 'AH', color: 'blue',
    title: 'Tak for tilbuddet', time: '16. nov.', date: 'Mandag 16. november kl. 14.28',
    snippet: 'Vi har haft tid til at læse det igennem i dag.',
    body: ['Hej,', 'Tak for tilbuddet. Vi har haft tid til at læse det igennem i dag, og omfanget ser rigtigt ud.', 'Jeg samler vores spørgsmål og vender tilbage på onsdag.', 'Venlig hilsen\nAnna'] },
  { id: 'tryk', folder: 'inbox', name: 'Jonas Birch', address: 'jonas@example.test', initials: 'JB', color: 'lilac',
    title: 'Papirprøver til kontoret', time: '16. nov.', date: 'Mandag 16. november kl. 10.03',
    snippet: 'Jeg kommer forbi med prøverne sidst på ugen.',
    body: ['Hej med jer,', 'Jeg kommer forbi med prøverne sidst på ugen. Der er både en mat hvid og en lidt varmere variant, så I kan se forskellen i dagslys.', 'Hilsen\nJonas'] },
  { id: 'tidspunkt', folder: 'sent', name: 'Sofie Lund', address: 'sofie@example.test', initials: 'SL', color: 'apricot',
    title: 'Tidspunkt for mødet', time: '13. nov.', date: 'Fredag 13. november kl. 11.47', snippet: 'Torsdag kl. 10 passer fint her.',
    body: ['Hej Sofie', 'Torsdag kl. 10 passer fint her. Jeg reserverer lokalet, så vi har plads til at lægge skitserne frem.', 'God weekend!'] },
  { id: 'kvittering', folder: 'archive', name: 'Liv Storm', address: 'liv@example.test', initials: 'LS', color: 'moss',
    title: 'Materialet er modtaget', time: '9. nov.', date: 'Mandag 9. november kl. 15.06', snippet: 'Tak for de færdige filer.',
    body: ['Hej,', 'Tak for de færdige filer. De er kommet godt frem, og vi har alt, hvad vi skal bruge.', 'Bedste hilsner\nLiv'] },
];

const folders: Record<Folder, string> = { inbox: 'Indbakke', sent: 'Sendt', archive: 'Arkiv' };
const icons = {
  inbox: '<path d="m3 12 3-7h12l3 7v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M3 13h5l2 3h4l2-3h5"/>',
  sent: '<path d="m3 10 17-6-5 16-4-7z"/><path d="m11 13 9-9"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11h14V8m-10 4h6"/>',
  search: '<circle cx="10" cy="10" r="6.5"/><path d="m15 15 5 5"/>',
};
const icon = (name: keyof typeof icons) =>
  '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + icons[name] + '</svg>';

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));

function messageRow(item: Example): string {
  return `<li data-row data-folder="${item.folder}" data-search="${escape([item.name, item.title, item.snippet, item.address].join(' ').toLocaleLowerCase('da'))}" ${item.folder !== 'inbox' ? 'hidden' : ''}>
    <button class="message-row" type="button" data-open="${item.id}" aria-pressed="${item === examples[0]}" aria-controls="message-${item.id}">
      <span class="row-sender">${item.folder === 'sent' ? 'Til ' : ''}${escape(item.name)}</span><span class="row-time">${escape(item.time)}</span>
      <strong class="row-title">${escape(item.title)}</strong><span class="row-snippet">${escape(item.snippet)}</span>
    </button></li>`;
}

function letter(item: Example): string {
  const sent = item.folder === 'sent';
  return `<article class="letter" id="message-${item.id}" aria-labelledby="title-${item.id}" ${item === examples[0] ? '' : 'hidden'}>
    <h2 id="title-${item.id}" tabindex="-1">${escape(item.title)}</h2>
    <div class="sender">
      <span class="avatar ${item.color}" aria-hidden="true">${escape(sent ? 'VM' : item.initials)}</span>
      <div class="sender-detail"><strong>${sent ? 'Dig' : escape(item.name)}</strong>
        <span>${sent ? 'Til ' + escape(item.address) : escape(item.address)}</span>
      </div>
    </div>
    <p class="letter-date">${escape(item.date)}</p>
    <div class="letter-body">${item.body.map(p => '<p>' + escape(p).replace(/\n/g, '<br>') + '</p>').join('')}</div>
  </article>`;
}

export function previewHtml(): string {
  return `<!doctype html>
<html lang="da"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
  <meta name="theme-color" content="#f4f2ec"><title>Eksempel på indbakken · Veyro Mail</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/forhaandsvisning.css">
  <script src="/forhaandsvisning.js" defer></script>
</head><body>
<header class="appbar"><a class="brand" href="/"><img src="/favicon.svg" alt="" width="32" height="32"><span>Veyro <b>Mail</b></span></a><span class="sample-label">Forhåndsvisning <span>·</span> Eksempelpost</span></header>
<main class="workspace" data-reader="false">
  <nav class="folders" aria-label="Mailmapper">
    <h2>Postkasse</h2>
    ${(Object.keys(folders) as Folder[]).map(folder => `<button type="button" class="folder" data-show="${folder}" aria-pressed="${folder === 'inbox'}">${icon(folder)}<span>${folders[folder]}</span></button>`).join('')}
  </nav>
  <section class="mailbox" aria-labelledby="folder-title">
    <div class="list-head"><div class="folder-summary"><h1 id="folder-title">Indbakke</h1><span id="mail-count" aria-live="polite">4 mails</span></div>
      <label class="search">${icon('search')}<input id="search" type="search" placeholder="Søg i mappen" aria-label="Søg i mappen" autocomplete="off"></label>
    </div>
    <ul class="message-list">${examples.map(messageRow).join('')}</ul>
    <p class="empty" hidden>Ingen mails matcher din søgning.</p>
  </section>
  <section class="reader" aria-label="Læsevisning">
    <button class="back" type="button">Tilbage til mappen</button>
    ${examples.map(letter).join('')}
  </section>
</main>
</body></html>`;
}

export const previewJs = `
(() => {
  const workspace = document.querySelector('.workspace');
  const folders = Array.from(document.querySelectorAll('[data-show]'));
  const rows = Array.from(document.querySelectorAll('[data-row]'));
  const articles = Array.from(document.querySelectorAll('.letter'));
  const search = document.querySelector('#search');
  let folder = 'inbox';
  let selected = rows[0].querySelector('button');

  function select(button, read) {
    selected = button;
    for (const row of rows) {
      const item = row.querySelector('button');
      item.setAttribute('aria-pressed', String(item === button));
    }
    for (const article of articles) article.hidden = !button || article.id !== button.getAttribute('aria-controls');
    workspace.dataset.reader = String(Boolean(read && button));
    if (read && button) document.getElementById(button.getAttribute('aria-controls')).querySelector('h2').focus({ preventScroll: true });
  }

  function filter() {
    const query = search.value.trim().toLocaleLowerCase('da');
    const visible = [];
    for (const row of rows) {
      row.hidden = row.dataset.folder !== folder || !row.dataset.search.includes(query);
      if (!row.hidden) visible.push(row.querySelector('button'));
    }
    document.querySelector('#mail-count').textContent = visible.length + (visible.length === 1 ? ' mail' : ' mails');
    document.querySelector('.empty').hidden = visible.length !== 0;
    select(visible.includes(selected) ? selected : visible[0], false);
  }

  for (const button of folders) button.addEventListener('click', () => {
    folder = button.dataset.show;
    search.value = '';
    for (const item of folders) item.setAttribute('aria-pressed', String(item === button));
    document.querySelector('#folder-title').textContent = button.textContent.trim();
    filter();
  });
  search.addEventListener('input', filter);
  for (const row of rows) {
    const button = row.querySelector('button');
    button.addEventListener('click', () => select(button, true));
  }
  document.querySelector('.back').addEventListener('click', () => {
    workspace.dataset.reader = 'false';
    selected?.focus();
  });
})();`;

export const previewCss = `
@font-face{font-family:Manrope;src:url('/manrope.woff2') format('woff2');font-weight:200 800;font-display:swap}
:root{font-family:Manrope,system-ui,sans-serif;color:#201f1a;background:#fff;--line:#dfded8;--accent:#ef521b;--muted:#68665e;color-scheme:light}
*{box-sizing:border-box}
body{margin:0}
[hidden]{display:none!important}
a,button,input{font:inherit}
button{cursor:pointer}
a:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid #a53a12;outline-offset:2px}
.appbar{height:4.55rem;display:flex;align-items:center;justify-content:space-between;padding:0 clamp(1.2rem,2.6vw,3rem);gap:1rem;border-bottom:1px solid var(--line);background:#faf9f6}
.brand{display:inline-flex;align-items:center;gap:.65rem;font-weight:800;letter-spacing:-.06em;font-size:1.55rem;text-decoration:none;color:inherit;white-space:nowrap}
.brand b{font-weight:450}
.sample-label{color:#5c554b;font-size:.78rem;font-weight:650}
.sample-label span{color:var(--accent);margin:0 .22em}
.workspace{display:grid;grid-template-columns:clamp(10rem,16.4vw,16rem) clamp(18rem,30vw,32rem) minmax(0,1fr);min-height:calc(100svh - 4.55rem)}
.folders{padding:2.6rem .8rem;background:#f4f2ec;border-right:1px solid var(--line)}
.folders h2{font-size:.78rem;font-weight:650;color:var(--muted);margin:0 0 1.1rem .75rem}
.folder{display:flex;align-items:center;gap:.62rem;width:100%;min-height:2.85rem;margin:.2rem 0;padding:.55rem .75rem;border:0;border-radius:.44rem;text-align:left;color:#514f47;background:transparent;font-weight:600;font-size:.92rem}
.folder svg{width:1.2rem;height:1.2rem;flex-shrink:0}
.folder[aria-pressed=true]{color:#2a251e;background:#e7e3d9}
.folder[aria-pressed=true] svg{color:#a03a12}
.folder:hover{background:#eae7df}
.mailbox{border-right:1px solid var(--line);min-width:0}
.list-head{padding:2.05rem clamp(1rem,1.65vw,1.85rem) 1.15rem}
.folder-summary{display:flex;align-items:baseline;gap:.7rem;flex-wrap:wrap;margin-bottom:1.3rem}
.folder-summary h1{font-weight:660;font-size:clamp(1.85rem,2.6vw,2.7rem);margin:0;letter-spacing:-.065em;line-height:1.15}
#mail-count{font-size:.8rem;color:var(--muted)}
.search{display:flex;align-items:center;gap:.6rem;padding:0 .7rem;border:1px solid #dad9d3;border-radius:.4rem;background:#faf9f6}
.search:focus-within{outline:2px solid #9c3d18}
.search svg{width:1.05rem;height:1.05rem;color:#69675d}
.search input{width:100%;min-width:0;height:2.5rem;border:0;background:transparent;font-size:.87rem;color:inherit}
.search input:focus-visible{outline:none}
.message-list{margin:0;padding:0;list-style:none;border-top:1px solid var(--line)}
.message-row{position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.2rem .65rem;width:100%;padding:1rem clamp(1rem,1.65vw,1.85rem) 1.1rem;text-align:left;background:#fff;color:inherit;border:0;border-bottom:1px solid var(--line)}
.message-row:hover{background:#faf9f7}
.message-row[aria-pressed=true]{background:#f9f0e7;box-shadow:inset 3px 0 #e75a22}
.row-sender,.row-title,.row-snippet{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row-sender{font-weight:690;font-size:.89rem}
.row-time{align-self:center;font-size:.72rem;color:var(--muted)}
.row-title,.row-snippet{grid-column:1/-1}
.row-title{font-size:.93rem;font-weight:660}
.row-snippet{font-size:.8rem;color:var(--muted);line-height:1.5}
.empty{margin:1.4rem;color:var(--muted)}
.reader{min-width:0;padding:clamp(2.1rem,4.7vw,5.75rem) clamp(1.5rem,4.2vw,5.6rem)}
.letter{max-width:42rem}
.letter h2{max-width:18ch;margin:0 0 2rem;font-size:clamp(2.1rem,3.5vw,4.4rem);line-height:1.08;font-weight:620;letter-spacing:-.065em;overflow-wrap:anywhere}
.letter h2:focus{outline:none}
.sender{display:flex;align-items:center;gap:.8rem}
.avatar{display:grid;place-items:center;flex-shrink:0;width:2.55rem;height:2.55rem;border-radius:50%;font-size:.82rem;font-weight:720;color:#453427;background:#ebc7a6}
.moss{background:#d8dfc2;color:#39432b}.blue{background:#dae5ed;color:#2b485a}.lilac{background:#e5dbea;color:#54405f}
.sender-detail{display:grid;gap:.15rem;min-width:0}
.sender-detail strong{font-size:.94rem}
.sender-detail span,.letter-date{font-size:.78rem;color:var(--muted);overflow-wrap:anywhere}
.letter-date{margin:1.05rem 0 0;padding-bottom:1.35rem;border-bottom:1px solid var(--line)}
.letter-body{padding-top:.4rem;font-size:clamp(.97rem,1.17vw,1.1rem);line-height:1.75;max-width:61ch}
.letter-body p{margin:1.2em 0}
.back{display:none}
@media(max-width:63rem) and (min-width:46.01rem){.workspace{grid-template-columns:4rem clamp(16rem,32vw,22rem) minmax(0,1fr)}.folders{padding:1.75rem .25rem}.folders h2{display:none}.folder{justify-content:center;position:relative;padding:.5rem}.folder span{position:absolute;height:1px;width:1px;overflow:hidden;clip-path:inset(50%)}.reader{padding-inline:1.5rem}}
@media(max-width:46rem){
  .appbar{height:4rem;padding:0 1rem}.brand{font-size:1.3rem;gap:.45rem}.brand img{width:28px;height:28px}.sample-label{font-size:.72rem;text-align:right}
  .workspace{display:block;min-height:calc(100svh - 4rem)}
  .folders{display:flex;gap:.25rem;align-items:center;padding:.4rem .75rem;border:0;border-bottom:1px solid var(--line)}
  .folders h2{display:none}.folder{width:auto;min-height:2.65rem;margin:0;padding:.45rem .57rem;font-size:.85rem;gap:.38rem}.folder svg{width:1rem;height:1rem}
  .mailbox{border:0}.list-head{padding:1.35rem 1.1rem 1rem}.folder-summary{margin-bottom:.9rem}.search input{height:2.65rem;font-size:1rem}.message-row{padding:1rem 1.15rem}.row-title{font-size:1.02rem}.row-snippet{font-size:.85rem}
  .reader{display:none;padding:1rem 1.15rem 2rem}.workspace[data-reader=true] .reader{display:block}.workspace[data-reader=true] .mailbox,.workspace[data-reader=true] .folders{display:none}
  .back{display:inline-flex;align-items:center;min-height:2.75rem;margin:0 0 1rem;padding:.1rem 0;border:0;background:transparent;text-decoration:underline;text-underline-offset:.22em;color:#6c3927;font-weight:600}
  .letter h2{font-size:2.35rem;margin-bottom:1.35rem}.letter-body{font-size:1rem}.letter-date{padding-bottom:1rem}
}
`;
