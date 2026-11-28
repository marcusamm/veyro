'use strict';

function labelError(message, code) {
  throw Object.assign(new Error(message), {code});
}

function isCustomName(name) {
  return typeof name === 'string' && !!name.trim() && name.length <= 1000 &&
    !/[\x00-\x1f\x7f]/.test(name) && !/^(?:\\|INBOX$|\[(?:Gmail|GoogleMail)\](?:\/|$))/i.test(name);
}

function isGmailUserLabel(folder) {
  if (!isCustomName(folder.path) || (folder.specialUse && folder.specialUseSource !== 'name')) return false;
  // Flags are authoritative even when multiple folders share a special-use
  // marker and the IMAP library attaches specialUse to just one of them.
  return ![...(folder.flags || [])].some(flag =>
    /^\\(?:NoSelect|NonExistent|All|Archive|Drafts|Flagged|Important|Inbox|Junk|Scheduled|Sent|Snoozed|Trash)$/i.test(flag));
}

// Use the same portable IMAP keywords as the Veyro web reader. IMAP keywords
// are case-insensitive; the hex payload preserves the case of the label name.
const KEYWORD_PREFIX = 'veyro-label-';
function labelKeyword(value) {
  if (typeof value !== 'string') labelError('Vælg en etiket.', 'INVALID_INPUT');
  const name = value.replace(/^[\p{White_Space}\u001c-\u001f]+|[\p{White_Space}\u001c-\u001f]+$/gu, '').normalize('NFC');
  if (!name || [...name].length > 40 || Buffer.byteLength(name) > 120 || /[\p{C}\p{Z}]/u.test(name.replace(/ /g, ''))) {
    labelError('Etiketten må indeholde op til 40 synlige tegn og 120 byte.', 'INVALID_INPUT');
  }
  return KEYWORD_PREFIX + Buffer.from(name).toString('hex');
}

function keywordNames(flags) {
  const names = new Set();
  for (const raw of flags || []) {
    if (typeof raw !== 'string' || raw.length > KEYWORD_PREFIX.length + 240) continue;
    const flag = raw.toLowerCase();
    if (!flag.startsWith(KEYWORD_PREFIX)) continue;
    const hex = flag.slice(KEYWORD_PREFIX.length);
    if (!/^(?:[a-f0-9]{2})+$/.test(hex)) continue;
    const name = Buffer.from(hex, 'hex').toString('utf8');
    try {
      if (labelKeyword(name) === flag) names.add(name);
    } catch {
      // Ignore malformed or older third-party flags while reading a mailbox.
    }
  }
  return [...names].sort((a,b) => a.localeCompare(b, 'da'));
}

function supportsKeywordLabels(mailbox) {
  return !!mailbox && !mailbox.readOnly && !!mailbox.permanentFlags?.has('\\*');
}

function messageLabels(meta, gmail = !!meta.labels) {
  if (!gmail) return {labels:keywordNames(meta.flags), important:false};
  const labels = [...(meta.labels || [])];
  return {
    labels: labels.filter(isCustomName),
    important: labels.some(name => /^\\Important$/i.test(name)),
  };
}

function requireGmail(client) {
  if (!client.capabilities.has('X-GM-EXT-1')) {
    labelError('Denne mailudbyder understøtter ikke Gmail-etiketter.', 'LABELS_UNSUPPORTED');
  }
}

function validNewName(name) {
  if (!isCustomName(name) || name !== name.trim() || name.startsWith('/') || name.endsWith('/') || name.includes('//')) {
    labelError('Vælg et gyldigt navn til etiketten.', 'INVALID_INPUT');
  }
}

async function manageLabel(client, {operation, name, newName}) {
  requireGmail(client);
  if (!['create', 'rename', 'delete'].includes(operation)) labelError('Ukendt etikethandling.', 'INVALID_INPUT');
  const folders = await client.list();
  const source = folders.find(folder => folder.path === name);
  if (operation !== 'create' && (!source || !isGmailUserLabel(source))) {
    labelError('Etiketten kan ikke ændres. Opdater listen.', 'LABEL_UNAVAILABLE');
  }

  if (operation !== 'delete') {
    const target = operation === 'rename' ? newName : name;
    validNewName(target);
    if (operation === 'rename' && name === newName) return {ok:true};
    if (folders.some(folder => folder.path === target)) labelError('Der findes allerede en etiket med det navn.', 'LABEL_EXISTS');
    if (operation === 'rename' && target.startsWith(name + '/')) {
      labelError('En etiket kan ikke placeres under sig selv.', 'INVALID_INPUT');
    }
    if (operation === 'create') {
      const result = await client.mailboxCreate(name);
      if (!result?.created) labelError('Etiketten blev ikke oprettet. Opdater listen.', 'LABEL_UNAVAILABLE');
    } else if (!await client.mailboxRename(name, target)) {
      labelError('Etiketten blev ikke omdøbt. Opdater listen.', 'LABEL_UNAVAILABLE');
    }
  } else {
    if (folders.some(folder => folder.path.startsWith(name + '/'))) {
      labelError('Flyt eller fjern underetiketterne, før du sletter denne etiket.', 'LABEL_HAS_CHILDREN');
    }
    if (!await client.mailboxDelete(name)) labelError('Etiketten blev ikke slettet. Opdater listen.', 'LABEL_UNAVAILABLE');
  }
  return {ok:true};
}

async function messageLabel(client, uid, {add = [], remove = []}) {
  const gmail = client.capabilities.has('X-GM-EXT-1');
  if (!gmail && !supportsKeywordLabels(client.mailbox)) {
    labelError('Mailserveren tillader ikke nye etiketter i denne mappe.', 'LABELS_UNSUPPORTED');
  }
  for (const group of [add, remove]) {
    if (!Array.isArray(group) || group.length > 512 || (gmail && !group.every(isCustomName))) {
      labelError('Vælg gyldige etiketter.', 'INVALID_INPUT');
    }
  }
  add = [...new Set(gmail ? add : add.map(labelKeyword))];
  remove = [...new Set(gmail ? remove : remove.map(labelKeyword))];
  if (remove.some(name => add.includes(name))) labelError('Samme etiket kan ikke både tilføjes og fjernes.', 'INVALID_INPUT');
  if (gmail) {
    const editable = new Set((await client.list()).filter(isGmailUserLabel).map(folder => folder.path));
    if ([...add, ...remove].some(name => !editable.has(name))) {
      labelError('En etiket er ændret hos udbyderen. Opdater listen.', 'LABEL_UNAVAILABLE');
    }
  }
  if (!await client.fetchOne(uid, {uid:true}, {uid:true})) {
    labelError('Mailen findes ikke længere i denne mappe.', 'NOT_FOUND');
  }
  // Delta updates preserve Inbox and labels another client added. Removing the
  // currently selected mailbox label may expunge this UID, so always add first.
  const options = gmail ? {uid:true, useLabels:true} : {uid:true};
  if (add.length && !await client.messageFlagsAdd(uid, add, options)) {
    labelError('Etiketterne blev ikke tilføjet. Opdater mailen.', 'LABEL_UPDATE_FAILED');
  }
  if (!gmail && add.length) await verifyKeywordChange(client, uid, add, true);
  if (remove.length && !await client.messageFlagsRemove(uid, remove, options)) {
    labelError('Ikke alle etiketændringer blev gemt. Opdater mailen.', 'LABEL_UPDATE_FAILED');
  }
  if (!gmail && remove.length) await verifyKeywordChange(client, uid, remove, false);
  return {ok:true};
}

// Some providers acknowledge STORE but drop keywords at the mailbox limit.
// Verify additions before removing any previous labels.
async function verifyKeywordChange(client, uid, keywords, enabled) {
  const current = await client.fetchOne(uid, {flags:true}, {uid:true});
  const flags = new Set(Array.from(current?.flags || [], flag => flag.toLowerCase()));
  if (!current?.flags || keywords.some(flag => flags.has(flag) !== enabled)) {
    labelError('Mailserveren gemte ikke alle etiketter. Opdater mappen.', 'LABEL_UPDATE_FAILED');
  }
}

module.exports = {isGmailUserLabel, messageLabels, manageLabel, messageLabel, labelKeyword, keywordNames, supportsKeywordLabels};
