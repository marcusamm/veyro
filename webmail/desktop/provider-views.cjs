'use strict';

// Keep UI filters separate from IMAP mailbox names. The folder selected on the
// server owns its UIDs, for both a regular folder and a filtered list of it.
const definitions = [
  {id:'inbox', name:'Indbakke', special:'\\Inbox', hash:'inbox'},
  {id:'starred', name:'Stjernemarkerede', special:'\\Flagged', hash:'starred'},
  {id:'snoozed', name:'Udsatte', special:'\\Snoozed', search:'in:snoozed', hash:'snoozed'},
  {id:'important', name:'Vigtige', special:'\\Important', search:'is:important', hash:'imp'},
  {id:'sent', name:'Sendt', special:'\\Sent', hash:'sent'},
  {id:'drafts', name:'Kladder', special:'\\Drafts', hash:'drafts'},
  {id:'purchases', name:'Køb', search:'category:purchases'},
  {id:'social', name:'Sociale netværk', search:'category:social'},
  {id:'updates', name:'Opdateringer', search:'category:updates'},
  {id:'forums', name:'Fora', search:'category:forums'},
  {id:'promotions', name:'Promoveringer', search:'category:promotions'},
  {id:'scheduled', name:'Planlagt', special:'\\Scheduled', hash:'scheduled'},
  {id:'all', name:'Alle mails', special:'\\All', hash:'all'},
  {id:'spam', name:'Spam', special:'\\Junk', hash:'spam'},
  {id:'trash', name:'Papirkurv', special:'\\Trash', hash:'trash'},
  {id:'archive', name:'Arkiv', special:'\\Archive'},
  {id:'subscriptions', name:'Administrer abonnementer', hash:'sub'},
];

function isGmailHost(host) {
  return /^(?:imap\.gmail\.com|imap\.googlemail\.com)$/i.test(host || '');
}

function sidebarViews(folders, {gmail}) {
  const byUse = new Map(folders.filter(f => f.specialUse && !f.label).map(f => [f.specialUse, f]));
  const inbox = folders.find(f => f.path.toUpperCase() === 'INBOX');
  if (inbox) byUse.set('\\Inbox', inbox);
  const all = byUse.get('\\All');
  const views = [];
  for (const {id,name,special,search,hash} of definitions) {
    const mailbox = byUse.get(special);
    if (mailbox) {
      views.push({id, name, folder:mailbox.path, unseen:mailbox.unseen, total:mailbox.total});
    } else if (id === 'starred' && (all || (!gmail && inbox))) {
      views.push({id, name:all ? name : 'Stjernemarkerede i indbakken', folder:(all || inbox).path, filter:id});
    } else if (gmail && search && all) {
      views.push({id, name, folder:all.path, filter:id});
    } else if (gmail && (hash || search)) {
      views.push({id, name, webView:id});
    }
  }
  return views;
}

function searchCriteria(filter, query, gmail) {
  const criteria = {};
  if (query) criteria.text = query;
  if (!filter) return query ? criteria : null;
  if (filter === 'starred') {
    criteria.flagged = true;
  } else {
    const search = definitions.find(entry => entry.id === filter)?.search;
    if (!gmail || !search) throw new Error('Denne visning er ikke tilgængelig for kontoen.');
    // The user-entered text remains a separate TEXT clause, ANDed by IMAP,
    // including when their text happens to contain Gmail search operators.
    criteria.gmraw = search;
  }
  return criteria;
}

function gmailWebViewUrl(webView, email) {
  const entry = definitions.find(d => d.id === webView);
  if (!entry || !(entry.hash || entry.search)) throw new Error('Ukendt Gmail-visning.');
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error('Ugyldig Gmail-konto.');
  const url = new URL('https://mail.google.com/mail/');
  url.searchParams.set('authuser', email);
  url.hash = entry.hash || 'search/' + encodeURIComponent(entry.search);
  return url.href;
}

module.exports = {sidebarViews, searchCriteria, gmailWebViewUrl, isGmailHost};
