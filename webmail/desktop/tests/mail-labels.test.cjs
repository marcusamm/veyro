'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {createMailConnector} = require('../mail-connector.cjs');
const {isGmailUserLabel, messageLabels} = require('../mail-labels.cjs');

function mailbox({gmail = true, failRemove = false} = {}) {
  const calls = [];
  const folders = new Map(['INBOX', '[Gmail]/Papirkurv', 'Projekt Æ', 'Før', '[Imap]/Drafts'].map(path => [path, {path}]));
  const labels = new Set(['\\Inbox', '\\Important', 'Før']);
  class Imap extends EventEmitter {
    constructor() {
      super();
      this.capabilities = new Set(gmail ? ['X-GM-EXT-1'] : []);
      this.mailbox = {exists:1, uidValidity:42n};
    }
    async connect() {}
    close() {}
    async list() { return [...folders.values()]; }
    async getMailboxLock(path) { this.path = path; return {release() {}}; }
    async fetchOne(uid) {
      return uid === 12 && (this.path === 'INBOX' || labels.has(this.path)) ? {uid, labels} : false;
    }
    async messageFlagsAdd(uid, names, opts) {
      calls.push(['add', uid, names, opts]);
      for (const name of names) labels.add(name);
      return true;
    }
    async messageFlagsRemove(uid, names, opts) {
      calls.push(['remove', uid, names, opts]);
      if (failRemove) return false;
      for (const name of names) labels.delete(name);
      return true;
    }
    async mailboxCreate(name) {
      calls.push(['create', name]);
      folders.set(name, {path:name});
      return {created:true};
    }
    async mailboxRename(name, target) {
      calls.push(['rename', name, target]);
      folders.delete(name);
      folders.set(target, {path:target});
      return {path:name, newPath:target};
    }
    async mailboxDelete(name) {
      calls.push(['delete', name]);
      folders.delete(name);
      return {path:name};
    }
  }
  const endpoint = {host:'imap.example.test', user:'test@example.test', password:'test'};
  return {connector:createMailConnector({account:{email:endpoint.user, imap:endpoint, smtp:endpoint}, dependencies:{ImapFlow:Imap}}), calls, labels, folders};
}
const source = {folder:'INBOX', uid:12, uidValidity:'42'};

test('custom labels exclude all Gmail system paths and container flags, while preserving genuine nested labels', () => {
  for (const path of ['INBOX', '[Gmail]', '[Gmail]/Alle mails', '[GoogleMail]/Trash', '\\Starred']) {
    assert.equal(isGmailUserLabel({path}), false);
  }
  assert.equal(isGmailUserLabel({path:'Parent', flags:new Set(['\\Noselect'])}), false);
  for (const flag of ['\\Important', '\\Snoozed', '\\Scheduled']) {
    assert.equal(isGmailUserLabel({path:'Some alias', flags:new Set([flag])}), false);
  }
  assert.equal(isGmailUserLabel({path:'Trash alias',specialUse:'\\Trash'}), false);
  assert.equal(isGmailUserLabel({path:'[Imap]/Drafts',specialUse:'\\Drafts',specialUseSource:'name'}), true);
  assert.equal(isGmailUserLabel({path:'Drafts',specialUse:'\\Drafts',specialUseSource:'name'}), true);
  assert.deepEqual(messageLabels({labels:new Set(['\\Inbox','\\IMPORTANT','Projekt Æ','[Imap]/Drafts'])}),
    {labels:['Projekt Æ','[Imap]/Drafts'],important:true});
  assert.deepEqual(messageLabels({}), {labels:[],important:false});
});

test('adding multiple labels before removing the selected one retains inbox membership and unrelated labels on retry', async () => {
  const {connector, calls, labels} = mailbox();
  labels.add('Another client added this');
  await connector.messageLabel({...source, folder:'Før', add:['Projekt Æ','Projekt Æ','[Imap]/Drafts'], remove:['Før']});
  const opts = {uid:true, useLabels:true};
  assert.deepEqual(calls, [['add',12,['Projekt Æ','[Imap]/Drafts'],opts],['remove',12,['Før'],opts]]);
  assert.deepEqual(labels, new Set(['\\Inbox','\\Important','Another client added this','Projekt Æ','[Imap]/Drafts']));
  await connector.messageLabel({...source, add:['Projekt Æ'], remove:['Før']});
  await assert.rejects(connector.messageLabel({...source, folder:'Før', add:['Projekt Æ']}), {code:'NOT_FOUND'});
  assert.ok(labels.has('\\Inbox'));
});

test('stale UID, missing labels, system labels and invalid deltas fail before any change is applied', async () => {
  const {connector, calls} = mailbox();
  for (const payload of [
    {...source, uidValidity:'41', add:['Projekt Æ']}, {...source, uidValidity:undefined, add:['Projekt Æ']},
    {...source, uid:13, add:['Projekt Æ']}, {...source, add:['Projekt Æ'], remove:['Gone']},
    {...source, add:'Projekt Æ'}, {...source, add:['[Gmail]/Papirkurv']}, {...source, remove:['\\Inbox']},
    {...source, add:['Før'],remove:['Før']},
  ]) await assert.rejects(connector.messageLabel(payload));
  assert.deepEqual(calls, []);
});

test('partial write errors are surfaced without rolling back labels added by the user or another client', async () => {
  const {connector, labels} = mailbox({failRemove:true});
  await assert.rejects(connector.messageLabel({...source, add:['Projekt Æ'],remove:['Før']}), {code:'LABEL_UPDATE_FAILED'});
  assert.equal(labels.has('Projekt Æ'), true);
  assert.equal(labels.has('Før'), true);
  assert.equal(labels.has('\\Inbox'), true);
});

test('only personal Gmail label folders can be created, renamed or deleted', async () => {
  const {connector, calls} = mailbox();
  await connector.manageLabel({operation:'create',name:'Regnskab'});
  await connector.manageLabel({operation:'rename',name:'Regnskab',newName:'Økonomi'});
  await connector.manageLabel({operation:'delete',name:'Økonomi'});
  for (const payload of [
    {operation:'create',name:'Projekt Æ'}, {operation:'delete',name:'INBOX'},
    {operation:'create',name:'x\r\ny'}, {operation:'rename',name:'Før',newName:'[GoogleMail]/Foo'},
    {operation:'delete',name:'[Gmail]/Papirkurv'}, {operation:'delete',name:'Missing'},
  ]) await assert.rejects(connector.manageLabel(payload));
  assert.deepEqual(calls, [['create','Regnskab'],['rename','Regnskab','Økonomi'],['delete','Økonomi']]);
});

test('parent deletion cannot cascade into child labels, and generic mailboxes are never treated as Gmail labels', async () => {
  const {connector, folders, calls} = mailbox();
  folders.set('Før/Under', {path:'Før/Under'});
  await assert.rejects(connector.manageLabel({operation:'delete',name:'Før'}), {code:'LABEL_HAS_CHILDREN'});
  assert.deepEqual(calls, []);
  const generic = mailbox({gmail:false});
  await assert.rejects(generic.connector.manageLabel({operation:'delete',name:'Før'}), {code:'LABELS_UNSUPPORTED'});
  await assert.rejects(generic.connector.messageLabel({...source, name:'Før',enabled:true}), {code:'LABELS_UNSUPPORTED'});
  assert.deepEqual(generic.calls, []);
});

const {labelKeyword, keywordNames} = require('../mail-labels.cjs');

test('Veyro IMAP keywords round-trip printable Unicode using the same NFC and UTF-8 hex format as webmail', () => {
  assert.equal(labelKeyword('  Økonomi  '), 'veyro-label-c3986b6f6e6f6d69');
  assert.equal(labelKeyword('A\u030A'), 'veyro-label-c385');
  assert.deepEqual(keywordNames(['VEYRO-LABEL-C3986B6F6E6F6D69', 'veyro-label-c3986b6f6e6f6d69',
    '\\Flagged', 'veyro-category-social', 'veyro-task', 'veyro-label-7', 'veyro-label-ff', 'veyro-label-0a',
    'veyro-label-41cc8a']), ['Økonomi']);
  for (const name of ['a\u00A0b', 'a\u001fb', 'a\u200db', 'x'.repeat(41), '😀'.repeat(31), ' ']) {
    assert.throws(() => labelKeyword(name), {code:'INVALID_INPUT'});
  }
  assert.equal(keywordNames([labelKeyword('😀'.repeat(30))])[0], '😀'.repeat(30));
});

function keywordMailbox({supports = true, readOnly = false, ignoreAdd = false} = {}) {
  const calls = [];
  const raw = Buffer.from('Subject: Synthetic message\r\nFrom: test@example.test\r\n\r\nBody\r\n');
  const flags = new Set(['\\Seen', 'OtherClient', labelKeyword('Tidligere').toUpperCase()]);
  class Imap extends EventEmitter {
    constructor() {
      super();
      this.capabilities = new Set();
      this.mailbox = {exists:1, uidValidity:42n, readOnly, flags:new Set([labelKeyword('Blå'), 'veyro-muted']),
        permanentFlags:new Set(supports ? ['\\Seen', '\\*'] : ['\\Seen'])};
    }
    async connect() {}
    close() {}
    async getMailboxLock(path) {calls.push(['lock',path]); return {release() {}};}
    async search(criteria, opts) {
      calls.push(['search',criteria,opts]);
      return criteria.keyword && ![...flags].some(f => f.toLowerCase() === criteria.keyword) ? [] : [12];
    }
    async fetchAll() {return [{uid:12, size:raw.length, flags:new Set(flags), source:raw}];}
    async fetchOne(uid, query) {
      return uid === 12 ? {uid, size:raw.length, flags:new Set(flags), ...(query.source ? {source:raw} : {})} : false;
    }
    async messageFlagsAdd(uid, add, opts) {
      calls.push(['add',uid,add,opts]);
      for (const name of add) if (!ignoreAdd) flags.add(name.toUpperCase());
      return true;
    }
    async messageFlagsRemove(uid, remove, opts) {
      calls.push(['remove',uid,remove,opts]);
      for (const flag of flags) if (remove.includes(flag.toLowerCase())) flags.delete(flag);
      return true;
    }
  }
  const endpoint = {host:'mail.example.test',user:'test@example.test',password:'test'};
  return {connector:createMailConnector({account:{email:endpoint.user, imap:endpoint, smtp:endpoint}, dependencies:{ImapFlow:Imap}}), flags, calls, raw};
}

test('generic IMAP labels survive reads, background fetch, fresh listings and searches within the selected folder', async () => {
  const {connector, flags, calls, raw} = keywordMailbox();
  const list = await connector.messages({folder:'Sent'});
  assert.equal(list.keywordLabels, true);
  assert.deepEqual(list.availableLabels, ['Blå','Tidligere']);
  assert.deepEqual(list.messages[0].labels, ['Tidligere']);
  const changed = {folder:'Sent', uid:12,uidValidity:'42',add:['A\u030Arsrapport','Årsrapport'],remove:['Tidligere']};
  await connector.messageLabel(changed);
  assert.deepEqual(calls.find(call=>call[0]==='add'), ['add',12,[labelKeyword('Årsrapport')],{uid:true}]);
  assert.deepEqual(flags, new Set(['\\Seen','OtherClient',labelKeyword('Årsrapport').toUpperCase()]));
  const selected = await connector.messages({folder:'Sent',keywordLabel:'Årsrapport',filter:'starred',query:'projekt'});
  assert.deepEqual(calls.find(call=>call[0]==='search'),['search',{text:'projekt',flagged:true,keyword:labelKeyword('Årsrapport')},{uid:true}]);
  assert.deepEqual(selected.messages[0].labels, ['Årsrapport']);
  const empty = await connector.messages({folder:'Sent',keywordLabel:'Tidligere'});
  assert.deepEqual(empty.messages, []);
  assert.deepEqual(empty.availableLabels, ['Blå']);
  const body = await connector.message({...source,folder:'Sent',sizeHint:raw.length,markSeen:false});
  assert.deepEqual(body.labels,['Årsrapport']);
  const warm = await connector.warmMessages({folder:'Sent',uidValidity:'42',messages:[{uid:12,size:raw.length}]});
  assert.deepEqual(warm[0].labels, ['Årsrapport']);
});

test('permanent keywords require a writable selected folder and confirmed server state', async () => {
  for (const opts of [{supports:false},{readOnly:true}]) {
    const {connector,calls} = keywordMailbox(opts);
    assert.equal((await connector.messages()).keywordLabels, false);
    await assert.rejects(connector.messageLabel({...source,add:['Ny']}),{code:'LABELS_UNSUPPORTED'});
    assert.equal(calls.some(c=>c[0]==='add'), false);
  }
  const blocked = keywordMailbox({ignoreAdd:true});
  await assert.rejects(blocked.connector.messageLabel({...source,add:['Ny'],remove:['Tidligere']}),{code:'LABEL_UPDATE_FAILED'});
  assert.equal(blocked.flags.has(labelKeyword('Tidligere').toUpperCase()),true);
  await assert.rejects(blocked.connector.messageLabel({...source,add:['\u212B'],remove:['Å']}),{code:'INVALID_INPUT'});
  const stale = keywordMailbox();
  await assert.rejects(stale.connector.messageLabel({...source,uidValidity:'41',add:['Ny']}),{code:'STALE_MAILBOX'});
  assert.equal(stale.calls.some(c=>c[0]==='add'),false);
  await assert.rejects(stale.connector.messages({keywordLabel:'\u0000'}), {code:'INVALID_INPUT'});
  await assert.rejects(mailbox().connector.messages({keywordLabel:'Ny'}), {code:'INVALID_INPUT'});
});
