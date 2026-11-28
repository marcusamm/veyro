'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {RecentMessages, onlyOtherReadAcknowledgements} = require('../recent-messages.cjs');

const inbox = {folder: 'INBOX', uidValidity: '41', uid: 10, markSeen: false};
const mail = {uid: 10, uidValidity: '41', seen: false, flagged: false, html: '<p>Hello</p>', text: 'Hello'};

test('cached opens can bypass only unrelated read acknowledgements in this folder', () => {
  const otherRead = {...inbox, uid: 11};
  assert.equal(onlyOtherReadAcknowledgements(new Set([otherRead]), inbox), true);
  assert.equal(onlyOtherReadAcknowledgements(new Set([otherRead]), {...inbox, markSeen: true}), false);
  for (const barrier of [undefined, inbox, {...otherRead, folder: 'All'}, {...otherRead, uid: '10'}, {...otherRead, uidValidity: '42'}]) {
    assert.equal(onlyOtherReadAcknowledgements(new Set([otherRead, barrier]), inbox), false);
  }
});

test('cached bodies are scoped to the exact account, folder and UID generation', () => {
  const recent = new RecentMessages();
  recent.remember('a', inbox, {...mail});
  assert.equal(recent.get('a', inbox).html, mail.html);
  assert.equal(recent.get('b', inbox), undefined);
  for (const changed of [{folder: 'Sent'}, {uidValidity: '42'}, {uidValidity: undefined}, {uid: 11}]) {
    assert.equal(recent.get('a', {...inbox, ...changed}), undefined);
  }
  recent.remember('b', inbox, {...mail, uidValidity: '42'});
  assert.equal(recent.get('b', inbox), undefined);
  recent.clear('b');
  assert.equal(recent.get('a', inbox).text, mail.text);
  recent.clear('a');
  assert.equal(recent.get('a', inbox), undefined);
});

test('reading a prefetched unread body preserves the flags until a server-confirmed action', () => {
  const recent = new RecentMessages();
  const alias = {...inbox, folder: 'All'};
  recent.remember('a', inbox, {...mail});
  recent.remember('a', alias, {...mail});
  assert.equal(recent.get('a', inbox).seen, false);
  assert.equal(recent.get('a', {...inbox, markSeen: true}), undefined);
  recent.applyAction('a', {...inbox, action: 'read'});
  assert.equal(recent.get('a', {...inbox, markSeen: true}).seen, true);
  assert.equal(recent.get('a', alias), undefined);
  recent.applyAction('a', {...inbox, action: 'star'});
  assert.equal(recent.get('a', inbox).flagged, true);
  recent.applyAction('a', {...inbox, action: 'unread'});
  assert.equal(recent.get('a', inbox).seen, false);
  recent.applyAction('a', {...inbox, action: 'trash'});
  assert.equal(recent.get('a', inbox), undefined);
});

test('new folder listings update flags, evict removed UIDs and reject old UID generations', () => {
  const recent = new RecentMessages();
  recent.remember('a', inbox, {...mail});
  recent.remember('a', {...inbox, uid: 11}, {...mail, uid: 11});
  recent.remember('b', inbox, {...mail});
  recent.refreshFolder('a', inbox.folder, {uidValidity: '41', messages: [{uid: 10, seen: true, flagged: true}]});
  assert.deepEqual(recent.get('a', inbox), {...mail, seen: true, flagged: true});
  assert.equal(recent.get('a', {...inbox, uid: 11}), undefined);
  recent.refreshFolder('a', inbox.folder, {uidValidity: '42', messages: [{uid: 10, seen: true, flagged: true}]});
  assert.equal(recent.get('a', inbox), undefined);
  assert.equal(recent.get('b', inbox).text, mail.text);
  recent.clear();
  assert.equal(recent.get('b', inbox), undefined);
});

test('a refreshed list reflects importance and evicts a body with outdated Gmail labels', () => {
  const recent = new RecentMessages();
  recent.remember('a', inbox, {...mail, labels: ['Arbejde'], important: false});
  const row = {uid: inbox.uid, seen: false, flagged: false, labels: ['Arbejde'], important: true};
  recent.refreshFolder('a', inbox.folder, {uidValidity: inbox.uidValidity, messages: [row]});
  assert.equal(recent.get('a', inbox).important, true);
  recent.refreshFolder('a', inbox.folder, {uidValidity: inbox.uidValidity, messages: [{...row, labels: []}]});
  assert.equal(recent.get('a', inbox), undefined);
  assert.equal(recent.bytes, 0);
});

test('the cache has account-wide size and count limits and expires bodies while idle', async () => {
  const recent = new RecentMessages({maxEntries: 2, maxBytes: 300, ttl: 20});
  recent.remember('a', inbox, {...mail});
  recent.remember('b', inbox, {...mail});
  recent.get('a', inbox);
  recent.remember('c', inbox, {...mail});
  assert.equal(recent.get('b', inbox), undefined);
  assert.equal(recent.get('a', inbox).text, mail.text);
  recent.remember('d', inbox, {...mail, text: 'x'.repeat(140)});
  assert.equal(recent.get('c', inbox), undefined);
  assert.equal(recent.get('a', inbox), undefined);
  assert.equal(recent.get('d', inbox).text.length, 140);
  recent.remember('e', inbox, {...mail, text: 'x'.repeat(400)});
  assert.equal(recent.get('e', inbox), undefined);
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(recent.entries.size, 0);
  assert.equal(recent.bytes, 0);
});

test('on-screen messages stay ready until leaving the viewport, with a bounded cache', t => {
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const recent = new RecentMessages({maxEntries:2, maxBytes:1024, ttl:10});
  try {
    recent.remember('a', inbox, {...mail});
    recent.setViewport('a', 'INBOX', '41', [10,11]);
    recent.remember('a', {...inbox, uid:11}, {...mail,uid:11});
    t.mock.timers.tick(100);
    assert.equal(recent.get('a', inbox).uid,10);
    assert.equal(recent.get('a', {...inbox,uid:11}).uid,11);
    recent.remember('other', inbox, {...mail});
    assert.equal(recent.get('other', inbox),undefined);
    recent.setViewport('a', 'INBOX','41', [11]);
    t.mock.timers.tick(11);
    assert.equal(recent.get('a', inbox),undefined);
    assert.equal(recent.get('a',{...inbox,uid:11}).uid,11);
    recent.clearViewport('a');
    t.mock.timers.tick(11);
    assert.equal(recent.bytes,0);
  } finally { recent.clear(); }
});
