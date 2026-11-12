#!/usr/bin/env node
/** Read-only FRM collector. Requires Node >=22; contains no credentials. */
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { BridgeError, DEFAULT_ENDPOINTS, ENDPOINTS, createSnapshot, normalizeBatch, visibleText } from './lib/frm-world.mjs';

const DEFAULT_INGEST = 'https://satisfactoryvenner.veyro.dk/api/world/ingest';
const RAW_RESPONSE_LIMIT = 16_000_000;
function fail(message) { throw new BridgeError(message); }
function urlFrom(value, label) {
  let url;
  try { url = new URL(value); } catch { fail(`${label} is not a valid URL.`); }
  if (url.username || url.password || url.search || url.hash) fail(`${label} must not contain credentials, query parameters, or a fragment. Use the token environment variables.`);
  return url;
}
function isPrivateHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return isIP(host) === 6 && /^(fc|fd)[0-9a-f]{2}:/i.test(host);
}
export function loadConfig(env = process.env) {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') fail('TLS certificate verification must remain enabled. Remove NODE_TLS_REJECT_UNAUTHORIZED=0.');
  const ingestToken = env.WORLD_INGEST_TOKEN;
  if (typeof ingestToken !== 'string' || !/^[0-9a-f]{64}$/.test(ingestToken)) fail('Set WORLD_INGEST_TOKEN to the 64-character connection token created by Marcus in the website’s world map settings.');
  const worldId = visibleText(env.WORLD_ID, 'WORLD_ID', 128), worldName = visibleText(env.WORLD_NAME, 'WORLD_NAME', 160);
  const frmUrl = urlFrom(env.FRM_URL || 'http://127.0.0.1:8080', 'FRM_URL');
  if (!['http:', 'https:'].includes(frmUrl.protocol) || (frmUrl.protocol === 'http:' && !isPrivateHost(frmUrl.hostname))) fail('FRM_URL requires a loopback/private IP for HTTP, or explicit HTTPS with a valid certificate. For a private hostname use its private IP.');
  if (frmUrl.pathname !== '/') fail('FRM_URL must be the FRM server root, without an endpoint path.');
  const ingestUrl = urlFrom(env.WORLD_INGEST_URL || DEFAULT_INGEST, 'WORLD_INGEST_URL');
  if (ingestUrl.protocol !== 'https:' || ingestUrl.pathname !== '/api/world/ingest') fail('WORLD_INGEST_URL must use HTTPS and the exact /api/world/ingest path.');
  const intervalSeconds = Number(env.WORLD_POLL_SECONDS || 15);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 10 || intervalSeconds > 3_600) fail('WORLD_POLL_SECONDS must be between 10 and 3600 seconds.');
  const endpoints = env.FRM_ENDPOINTS === undefined ? [...DEFAULT_ENDPOINTS] : env.FRM_ENDPOINTS.split(',').map(value => value.trim());
  if (!endpoints.length || endpoints.some(endpoint => !Object.hasOwn(ENDPOINTS, endpoint)) || new Set(endpoints).size !== endpoints.length) fail(`FRM_ENDPOINTS must be a unique comma-separated selection of: ${DEFAULT_ENDPOINTS.join(', ')}.`);
  const frmToken = env.FRM_AUTH_TOKEN || '';
  if (frmToken && (frmToken.length > 1024 || /[\u0000-\u0020\u007f]/u.test(frmToken))) fail('FRM_AUTH_TOKEN contains unsupported characters.');
  return { ingestToken, worldId, worldName, frmUrl, ingestUrl, intervalMs: intervalSeconds * 1000, endpoints, frmToken };
}
/** Stream a bounded body; error messages deliberately omit URLs, bodies and tokens. */
export async function readLimitedJson(response, label, maxBytes = RAW_RESPONSE_LIMIT) {
  const length = response.headers.get('content-length');
  if (length && Number(length) > maxBytes) {
    await response.body?.cancel();
    fail(`${label} response exceeds its byte limit.`);
  }
  const type = response.headers.get('content-type') || '';
  if (type && !/^(application\/json|[^;]+\+json)(;|$)/i.test(type)) {
    await response.body?.cancel();
    fail(`${label} did not return JSON. Check the address, FRM version, and authentication.`);
  }
  if (!response.body) fail(`${label} returned an empty response.`);
  const reader = response.body.getReader(), chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); fail(`${label} response exceeds its byte limit.`); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, total).toString('utf8')); }
  catch { fail(`${label} returned malformed JSON. No partial world was sent.`); }
}
async function fetchJson(url, options, label, { fetchImpl, signal, timeoutMs = 12_000, maxBytes = RAW_RESPONSE_LIMIT }) {
  const timedSignal = AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(timeoutMs)]);
  try {
    const response = await fetchImpl(url, { ...options, redirect: 'error', signal: timedSignal });
    if (!response.ok) {
      await response.body?.cancel();
      if (label === 'Website' && response.status === 401) fail('Website rejected the connection token (401). Ask Marcus to create/rotate it and update WORLD_INGEST_TOKEN.');
      if (label === 'Website' && response.status === 409) fail('Website rejected this world or observation (409). Check WORLD_ID, run only one bridge, and synchronize the bridge clock. Existing data was kept.');
      if (response.status === 404) fail(`${label} is unavailable (404). Check the FRM version/endpoint selection; endpoints are never silently skipped.`);
      fail(`${label} returned HTTP ${response.status}. No successful snapshot was confirmed.`);
    }
    return await readLimitedJson(response, label, maxBytes);
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    if (timedSignal.aborted) fail(`${label} request timed out or was stopped. The last accepted world is unchanged.`);
    fail(`${label} request failed. Check network access, TLS certificates, and the configured address; redirects are not followed.`);
  }
}
/** Strictly sequential reads and one upload only after every selected read succeeds. */
export async function pollAndPublish(config, { fetchImpl = fetch, now = Date.now, previousSequence = 0, signal } = {}) {
  const startedAt = now();
  const pollSignal = AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(90_000)]);
  const headers = { accept: 'application/json', ...(config.frmToken ? { 'X-FRM-Authorization': config.frmToken } : {}) };
  const batches = [];
  for (const endpoint of config.endpoints) {
    const response = await fetchJson(new URL(endpoint, config.frmUrl), { method: 'GET', headers }, endpoint, { fetchImpl, signal: pollSignal });
    batches.push(normalizeBatch(endpoint, response));
  }
  const completedAt = now();
  const sequence = Math.max(completedAt, previousSequence + 1);
  // Sequential endpoints are not atomic. The oldest observation bound is
  // honest even when a large save takes a long time to collect.
  const snapshot = createSnapshot(batches, { ...config, sequence, observedAt: startedAt });
  const accepted = await fetchJson(config.ingestUrl, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${config.ingestToken}` },
    body: JSON.stringify(snapshot),
  }, 'Website', { fetchImpl, signal, timeoutMs: 20_000, maxBytes: 8_192 });
  if (!accepted || accepted.accepted !== true || accepted.sequence !== sequence) fail('Website did not acknowledge the exact snapshot sequence. Check the website’s integration version.');
  return { sequence, observedAt: snapshot.observedAt, entities: snapshot.entities.length, links: snapshot.links.length };
}
export function retryDelay(intervalMs, failures) { return Math.min(300_000, intervalMs * 2 ** Math.min(failures, 5)); }
export async function runBridge(config, { signal, fetchImpl = fetch, now = Date.now, wait = sleep, log = console.log } = {}) {
  let sequence = 0, failures = 0;
  log(`World bridge started. ${config.endpoints.length} read-only endpoints; polling every ${config.intervalMs / 1000}s after successful uploads.`);
  while (!signal?.aborted) {
    try {
      const result = await pollAndPublish(config, { signal, fetchImpl, now, previousSequence: sequence });
      sequence = result.sequence; failures = 0;
      log(`Map accepted at ${result.observedAt}: ${result.entities} entities, ${result.links} connections.`);
    } catch (error) {
      if (signal?.aborted) break;
      failures++;
      log(error instanceof BridgeError ? error.message : 'Bridge processing failed. Check the installed bridge and FRM versions.');
      log(`Retrying in ${retryDelay(config.intervalMs, failures) / 1000}s. The last accepted map is retained.`);
    }
    try { await wait(failures ? retryDelay(config.intervalMs, failures) : config.intervalMs, undefined, { signal }); }
    catch (error) { if (!signal?.aborted) throw error; }
  }
}
export async function main() {
  try {
    if (Number(process.versions.node.split('.')[0]) < 22) fail('The world bridge requires Node.js 22 or newer.');
    if (process.argv.length > 2) fail('Configure the bridge through environment variables, not command-line arguments.');
    const config = loadConfig(), controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try { await runBridge(config, { signal: controller.signal }); }
    finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  } catch (error) {
    console.error(error instanceof BridgeError ? error.message : 'World bridge failed to start. Check Node.js and the configuration.');
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
