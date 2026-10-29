import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BILAG_ASSISTANT_JS, bilagAssistantPage } from '../src/views/bilagassistant.ts';

class Element {
  children = []; style = {}; attributes = {}; handlers = {}; disabled = false;
  value = ''; textContent = ''; hidden = false; files = []; scrollHeight = 50;
  classList = { remove() {} };
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  focus() { this.focused = true; }
  set innerHTML(_value) { throw new Error('Chat must never render untrusted markup'); }
}
const file = (name = 'TESTDATA.png', type = 'image/png', bytes = 10) => new File([new Uint8Array(bytes)], name, { type });
const uploaded = (id = 1, extra = {}) => ({ id, url: '/lager/bilag/' + id, fileName: 'TESTDATA.png', version: 1, file_id: 10 + id, op: 'TESTDATA-next-op-' + id, mime: 'image/png', ...extra });
const ok = data => ({ ok: true, json: async () => data });
const event = () => ({ preventDefault() {} });
function workspace(fetch, { available = true } = {}) {
  const root = new Element(), upload = new Element(), ask = new Element();
  root.setAttribute('data-base', '/lager/bilag'); root.setAttribute('data-max-bytes', String(15 * 1024 * 1024));
  const selectors = ['picker', 'uploadButton', 'askButton', 'question', 'status', 'error', 'messages', 'preview', 'original', 'detail', 'fileName', 'fileHint', 'drop', 'csrf', 'op', 'version', 'file_id', 'history'];
  const n = Object.fromEntries(selectors.map(key => [key, new Element()]));
  n.picker.disabled = n.question.disabled = !available; n.csrf.value = 'TESTDATA-csrf'; n.op.value = 'TESTDATA-op';
  upload.action = 'https://test.invalid/lager/bilag/chat/upload'; ask.action = 'https://test.invalid/lager/bilag/chat';
  const map = {
    '[data-assistant-upload]': upload, '[data-assistant-question]': ask, '[data-assistant-status]': n.status,
    '[data-assistant-error]': n.error, '[data-assistant-messages]': n.messages, '[data-assistant-preview]': n.preview,
    '[data-assistant-original]': n.original, '[data-assistant-detail]': n.detail, '[data-assistant-file-name]': n.fileName,
    '[data-assistant-file-hint]': n.fileHint, '[data-assistant-drop]': n.drop,
  };
  root.querySelector = selector => map[selector];
  upload.querySelector = selector => ({ '[name=file]': n.picker, 'button[type=submit]': n.uploadButton, '[name=_csrf]': n.csrf, '[name=op]': n.op })[selector];
  ask.querySelector = selector => ({ 'button[type=submit]': n.askButton, '[name=question]': n.question, '[name=_csrf]': n.csrf, '[name=version]': n.version, '[name=file_id]': n.file_id, '[name=history]': n.history })[selector];
  const document = { querySelectorAll: () => [root], createElement: () => new Element() };
  vm.runInNewContext(BILAG_ASSISTANT_JS, { document, fetch, FormData, URLSearchParams, URL, AbortController, setTimeout, clearTimeout, location: { origin: 'https://test.invalid' } });
  const pick = files => { n.picker.files = files; n.picker.handlers.change(event()); };
  const uploadFile = async chosen => { pick([chosen]); await upload.handlers.submit(event()); };
  const send = async text => { n.question.value = text; await ask.handlers.submit(event()); };
  return { ...n, root, upload, ask, pick, uploadFile, send };
}

describe('Bilagsassistent: upload direkte i chatten', () => {
  it('viser selvstændige CSRF-formularer, ét bilag og en skrivbar kladde før første upload', async () => {
    const html = String(await bilagAssistantPage({ base: '/lager/bilag', csrf: 'TESTDATA-csrf', op: 'TESTDATA-op', available: true }));
    expect(html).toContain('action="/lager/bilag/chat/upload" enctype="multipart/form-data"');
    expect(html).toContain('name="file"'); expect(html).not.toContain(' multiple');
    expect(html).toContain('name="_csrf" value="TESTDATA-csrf"'); expect(html).toContain('name="op" value="TESTDATA-op"');
    expect(html).toMatch(/name="question"[^>]+maxlength="1000"[^>]*>/); expect(html).not.toMatch(/name="question"[^>]*disabled/);
    expect(html).toContain('Chatten retter eller godkender ikke bilaget.'); expect(html).toContain('src="/static/bilag-assistant.js?v=1"');
    expect(html).not.toMatch(/<script>/);
    const disabled = String(await bilagAssistantPage({ base: '/job/bilag', csrf: 'test', op: 'test', available: false }));
    expect(disabled).toMatch(/name="question"[^>]*disabled/); expect(disabled).toMatch(/name="file"[^>]*disabled/);
  });

  it('uploader kun originalen uden AI-kald og bevarer et spørgsmål skrevet imens', async () => {
    const calls = []; let release;
    const c = workspace(async (url, opts) => { calls.push({ url, opts }); await new Promise(resolve => { release = resolve; }); return ok(uploaded()); });
    expect(c.askButton.disabled).toBe(true); expect(c.question.disabled).toBe(false);
    c.pick([file()]); const running = c.upload.handlers.submit(event());
    c.question.value = 'Hvad står der på bonen?'; expect(c.status.textContent).toContain('Uploader'); expect(c.picker.disabled).toBe(true);
    release(); await running;
    expect(calls).toHaveLength(1); expect(calls[0].url).toBe('https://test.invalid/lager/bilag/chat/upload');
    expect([...calls[0].opts.body.keys()]).toEqual(['_csrf', 'op', 'file']);
    expect(calls[0].opts.body.get('_csrf')).toBe('TESTDATA-csrf'); expect(calls[0].opts.body.get('file').name).toBe('TESTDATA.png');
    expect(c.question.value).toBe('Hvad står der på bonen?'); expect(c.askButton.disabled).toBe(false);
    expect(c.original.href).toBe('/lager/bilag/1/fil'); expect(c.preview.children[0].src).toBe('/lager/bilag/1/fil');
    expect(c.op.value).toBe('TESTDATA-next-op-1'); expect(c.ask.action).toBe('/lager/bilag/1/spoerg');
  });

  it('bruger kun det aktive bilag og nulstiller tidligere samtale ved vellykket ny upload', async () => {
    const calls = [];
    const c = workspace(async (url, opts) => {
      calls.push({ url, opts });
      return url.includes('/upload') ? ok(uploaded(calls.length === 1 ? 1 : 2)) : ok({ answer: '<img src=x onerror=alert(1)>', imageReviewed: true, sources: [{ page: 1, lineStart: 1, lineEnd: 1, text: '<script>kilde</script>' }] });
    });
    await c.uploadFile(file()); await c.send('TESTDATA første spørgsmål');
    expect(c.messages.children[2].children[1].textContent).toBe('<img src=x onerror=alert(1)>');
    expect(c.messages.children[2].children[2].children[1].textContent).toBe('<script>kilde</script>');
    expect(c.messages.children[2].children.at(-1).textContent).toBe('Grundlag: originalbillede og aflæst tekst');
    await c.uploadFile(file('TESTDATA-anden.pdf', 'application/pdf'));
    expect(c.messages.children).toHaveLength(1); expect(c.file_id.value).toBe('12');
    await c.send('TESTDATA andet spørgsmål');
    const ask = calls.at(-1); expect(ask.url).toBe('/lager/bilag/2/spoerg');
    expect(ask.opts.body.get('file_id')).toBe('12'); expect(ask.opts.body.get('history')).toBe('[]');
    expect(ask.opts.body.get('do')).toBe(null);
  });

  it('bevarer den aktive samtale og kladden hvis en ny upload fejler eller returnerer et fremmed previewlink', async () => {
    let uploadNo = 0;
    const c = workspace(async url => {
      if (!url.includes('/upload')) return ok({ answer: 'TESTDATA svar', sources: [] });
      uploadNo++;
      return uploadNo === 1 ? ok(uploaded()) : uploadNo === 2 ? { ok: false, json: async () => ({ error: 'TESTDATA uploadfejl' }) } : ok(uploaded(3, { url: 'https://foreign.invalid/lager/bilag/3' }));
    });
    await c.uploadFile(file()); await c.send('TESTDATA'); c.question.value = 'TESTDATA bevaret kladde';
    expect(c.messages.children[2].children.at(-1).textContent).toBe('Grundlag: aflæst tekst');
    const count = c.messages.children.length;
    await c.uploadFile(file('TESTDATA-ny.png'));
    expect(c.error.textContent).toBe('TESTDATA uploadfejl'); expect(c.messages.children).toHaveLength(count);
    expect(c.ask.action).toBe('/lager/bilag/1/spoerg'); expect(c.question.value).toBe('TESTDATA bevaret kladde');
    await c.uploadFile(file('TESTDATA-ny.png'));
    expect(c.error.textContent).toContain('Uploadsvaret kunne ikke kontrolleres');
    expect(c.original.href).toBe('/lager/bilag/1/fil'); expect(c.ask.action).toBe('/lager/bilag/1/spoerg');
  });

  it('afviser flere, tomme, for store og ikke-understøttede filer uden netværkskald', async () => {
    let calls = 0; const c = workspace(async () => { calls++; return ok(uploaded()); });
    for (const files of [[file(), file()], [file('TESTDATA.png', 'image/png', 0)], [file('TESTDATA.png', 'image/png', 15 * 1024 * 1024 + 1)], [file('TESTDATA.exe', 'application/octet-stream')]]) {
      c.pick(files); expect(c.uploadButton.disabled).toBe(true); await c.upload.handlers.submit(event());
    }
    expect(calls).toBe(0);
    c.drop.handlers.drop({ preventDefault() {}, dataTransfer: { files: [file('TESTDATA.pdf', 'application/pdf')] } });
    expect(c.uploadButton.disabled).toBe(false); expect(c.fileHint.textContent).toContain('TESTDATA.pdf');
    expect(c.picker.required).toBe(false); // native validation must not block a dropped in-memory file
  });
});
