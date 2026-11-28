'use strict';

const {randomUUID} = require('node:crypto');

// For a common multipart/mixed message, MailParser can decode the original
// body and attachment headers without first transferring the attached files.
const MAX_BODY = 2 * 1024 * 1024;
const MAX_HEADER = 32 * 1024;
const addressHeaders = ['From', 'To', 'Cc', 'Bcc', 'Reply-To', 'Message-ID', 'References'];

function ordinaryText(part) {
  return ['text/plain', 'text/html'].includes(part.type) && !part.id &&
    !part.parameters?.name && !part.dispositionParameters?.filename && part.disposition !== 'attachment';
}

async function messagePreview(client, uid, meta, parse, options) {
  const root = meta.bodyStructure;
  if (meta.size < 512 * 1024 || root?.type !== 'multipart/mixed') return null;
  const parts = root.childNodes || [];
  if (parts.length < 2 || parts.length > 31 || !parts.every((p, i) => p.part === String(i + 1))) return null;
  const [body, ...files] = parts;
  const alternative = body.type === 'multipart/alternative' && !body.disposition &&
    body.childNodes?.length && body.childNodes.every(ordinaryText);
  if (!ordinaryText(body) && !alternative) return null;
  if (!files.every(p => p.disposition === 'attachment' && !p.id && !p.childNodes &&
    p.type.startsWith('application/') && (p.dispositionParameters?.filename || p.parameters?.name))) return null;

  const headers = parts.map(p => ({key:p.part + '.mime', maxLength:MAX_HEADER + 1}));
  let fetched;
  try {
    fetched = await client.fetchOne(uid, {
      headers:addressHeaders, bodyParts:[...headers, {key:'1', maxLength:MAX_BODY + 1}],
    }, {uid:true});
  } catch (error) {
    if (['NO', 'BAD'].includes(error.responseStatus)) return null;
    throw error;
  }
  const payload = fetched?.bodyParts?.get('1');
  if (!Buffer.isBuffer(payload) || payload.length > MAX_BODY || !Buffer.isBuffer(fetched.headers) ||
      fetched.headers.length > MAX_HEADER) return null;
  const boundary = 'veyro-' + randomUUID();
  const envelope = fetched.headers.toString('latin1').trimEnd();
  const chunks = [Buffer.from((envelope ? envelope + '\r\n' : '') +
    'MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="' + boundary + '"\r\n', 'latin1')];
  for (const part of parts) {
    const header = fetched.bodyParts.get(part.part + '.mime');
    if (!Buffer.isBuffer(header) || !header.length || header.length > MAX_HEADER) return null;
    chunks.push(Buffer.from('\r\n--' + boundary + '\r\n' + header.toString('latin1').trimEnd() + '\r\n\r\n', 'latin1'));
    if (part === body) chunks.push(payload);
  }
  chunks.push(Buffer.from('\r\n--' + boundary + '--\r\n'));
  let mail;
  try { mail = await parse(Buffer.concat(chunks), options); }
  catch { return null; }
  if (mail.attachments.length !== files.length) return null;
  // Full download/forward still resolves the original UIDVALIDITY and index.
  // The wire size in BODYSTRUCTURE is not the decoded attachment size.
  for (const file of mail.attachments) file.deferred = true;
  return mail;
}

module.exports = {messagePreview};
