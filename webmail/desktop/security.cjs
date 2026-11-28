'use strict';

const MAIL_ORIGIN = 'https://mail.veyro.dk';
const SHELL_URL = 'veyro://shell/index.html';
const CLIENT_URL = 'veyro://mail/index.html';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function parseURL(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try { return new URL(value); } catch { return null; }
}
function allowedRemote(value, origin = MAIL_ORIGIN) {
  const url = parseURL(value);
  return !!url && !url.username && !url.password && url.origin === origin;
}
function externalURL(value) {
  const url = parseURL(value);
  if (!url || url.username || url.password || !['https:', 'http:', 'mailto:'].includes(url.protocol)) return null;
  // Never let links from email launch local files, script URLs or arbitrary OS protocols.
  if (url.protocol === 'mailto:' && /%0[ad]/i.test(value)) return null;
  return url.href;
}
function trustedDocument(actual, expected) {
  const url = parseURL(actual);
  return !!url && !url.username && !url.password && url.href === expected;
}
function partitionFor(id) {
  if (!UUID.test(id)) throw new Error('Ugyldigt konto-id.');
  return `persist:veyro-account-${id}`;
}
function normalizeLabel(value) {
  if (typeof value !== 'string') throw new Error('Giv kontoen et navn.');
  const label = value.trim();
  if (!label || label.length > 64 || /[\u0000-\u001f\u007f]/.test(label)) throw new Error('Kontonavnet skal være 1–64 tegn.');
  return label;
}
function safeFilename(value) {
  const safe = String(value || 'vedhæftning').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').slice(0, 180).trim();
  return safe || 'vedhæftning';
}
function accountEndpoint(value, previous, email, previousEmail) {
  if (!value || typeof value !== 'object') throw new Error('Mailserverens indstillinger mangler.');
  const endpoint = {host: value.host, port: value.port, secure: value.secure, user: value.user || email, password: value.password};
  const same = previous && String(value.host).trim().toLowerCase() === String(previous.host).trim().toLowerCase()
    && Number(value.port) === Number(previous.port) && value.secure === previous.secure
    && String(value.user || email).trim() === String(previous.user || previousEmail).trim();
  if (!endpoint.password && same) endpoint.password = previous.password;
  return endpoint;
}
function resolveOrigin({isPackaged, testMode, testOrigin} = {}) {
  if (!testOrigin) return MAIL_ORIGIN;
  const url = parseURL(testOrigin);
  if (isPackaged || !testMode || !url || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('Test-origin kræver en upakket testkørsel på loopback.');
  }
  return url.origin;
}
const secureWebPreferences = Object.freeze({
  sandbox: true, contextIsolation: true, nodeIntegration: false,
  nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
  webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
  navigateOnDragDrop: false, safeDialogs: true, spellcheck: true,
});
module.exports = {MAIL_ORIGIN, SHELL_URL, CLIENT_URL, UUID, allowedRemote, externalURL, trustedDocument, partitionFor, normalizeLabel, safeFilename, accountEndpoint, resolveOrigin, secureWebPreferences};
