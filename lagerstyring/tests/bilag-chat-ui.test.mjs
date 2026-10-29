import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BILAG_CHAT_JS } from '../src/views/bilagchatclient.ts';
import { detailPage } from '../src/views/bilag.ts';

// A narrow DOM double exercises the network/rendering boundary without running a browser.
// Any attempt to parse server/model output as markup fails this fixture.
class Element {
  children = []; style = {}; attributes = {}; handlers = {}; disabled = false;
  value = ''; textContent = ''; hidden = false; scrollHeight = 50;
  append(...nodes) { this.children.push(...nodes); }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  focus() { this.focused = true; }
  set innerHTML(_value) { throw new Error('Untrusted chat content must never be parsed as HTML'); }
}
function client(fetch) {
  const panel = new Element(), form = new Element(), question = new Element(), messages = new Element();
  const status = new Element(), error = new Element(), history = new Element(), submit = new Element();
  form.action = 'https://test.invalid/lager/bilag/7/spoerg';
  const bySelector = {
    '[data-chat-form]': form, '[name=question]': question, '[data-chat-messages]': messages,
    '[data-chat-status]': status, '[data-chat-error]': error, '[data-chat-history]': history, 'button[type=submit]': submit,
  };
  panel.querySelector = form.querySelector = selector => bySelector[selector];
  panel.querySelectorAll = () => [];
  class FormData {
    *[Symbol.iterator]() {
      yield ['_csrf', 'TESTDATA-csrf']; yield ['version', '1']; yield ['file_id', '9'];
      yield ['question', question.value]; yield ['history', history.value];
    }
  }
  const document = { querySelectorAll: () => [panel], createElement: () => new Element() };
  vm.runInNewContext(BILAG_CHAT_JS, { document, fetch, FormData, URLSearchParams, AbortController, setTimeout, clearTimeout });
  const send = text => { question.value = text; return form.handlers.submit({ preventDefault() {} }); };
  return { form, question, messages, status, error, history, submit, send };
}
const ok = (answer, sources = []) => ({ ok: true, json: async () => ({ answer, sources }) });

describe('Bilagschat i browseren', () => {
  it('sender kun til bilagets læserute med CSRF/version og viser svar og kilder som ren tekst', async () => {
    const requests = [], malicious = '<img src=x onerror=alert(1)>', quote = '<script>bad()</script>';
    const c = client(async (url, opts) => { requests.push({ url, opts }); return ok(malicious, [{ page: 2, lineStart: 4, lineEnd: 5, text: quote }]); });
    await c.send('Hvad står der på varen?');
    expect(requests).toHaveLength(1); expect(requests[0].url).toBe(c.form.action);
    expect(requests[0].opts.method).toBe('POST'); expect(requests[0].opts.credentials).toBe('same-origin');
    const body = requests[0].opts.body;
    expect(body.get('_csrf')).toBe('TESTDATA-csrf'); expect(body.get('version')).toBe('1'); expect(body.get('file_id')).toBe('9');
    expect(body.get('question')).toBe('Hvad står der på varen?'); expect(body.get('do')).toBe(null);
    expect(c.messages.children[1].children[1].textContent).toBe(malicious);
    expect(c.messages.children[1].children[2].children[0].textContent).toBe('Side 2, linje 4–5');
    expect(c.messages.children[1].children[2].children[1].textContent).toBe(quote);
    expect(c.question.value).toBe(''); expect(c.submit.disabled).toBe(false);
  });

  it('bevarer spørgsmålet ved fejl, åbner for genforsøg og gemmer ikke et fejlsvar i samtalens kontekst', async () => {
    let requests = 0;
    const c = client(async (_url, opts) => {
      requests++;
      expect(opts.body.get('history')).toBe('[]');
      return requests === 1 ? { ok: false, json: async () => ({ error: 'Aflæs bilaget igen.' }) } : ok('TESTDATA svar');
    });
    await c.send('Hvad står der?');
    expect(c.error.hidden).toBe(false); expect(c.error.textContent).toBe('Aflæs bilaget igen.');
    expect(c.question.value).toBe('Hvad står der?'); expect(c.submit.disabled).toBe(false);
    await c.send(c.question.value);
    expect(requests).toBe(2); expect(c.error.hidden).toBe(true);
    expect(JSON.parse(c.history.value)).toHaveLength(2);
  });

  it('afviser dobbeltklik og sender kun de seneste tre spørgsmål og svar ved opfølgning', async () => {
    let release, calls = 0, last;
    const c = client(async (_url, opts) => {
      calls++; last = JSON.parse(opts.body.get('history'));
      if (calls === 1) await new Promise(resolve => { release = resolve; });
      return ok('TESTDATA svar ' + calls);
    });
    const first = c.send('TESTDATA spørgsmål 1');
    expect(c.submit.disabled).toBe(true); expect(c.form.attributes['aria-busy']).toBe('true');
    await c.send('TESTDATA dobbeltklik'); expect(calls).toBe(1);
    release(); await first;
    for (let n = 2; n <= 5; n++) await c.send('TESTDATA spørgsmål ' + n);
    expect(last).toHaveLength(6); expect(last[0]).toEqual({ role: 'user', content: 'TESTDATA spørgsmål 2' });
    expect(c.form.attributes['aria-busy']).toBeUndefined();
  });

  it('holder også lange og JSON-escape-tunge samtaler inden for serverens kontekstgrænser', async () => {
    const c = client(async (_url, opts) => {
      const raw = opts.body.get('history'), history = JSON.parse(raw);
      expect(raw.length).toBeLessThanOrEqual(16000);
      expect(history.reduce((n, turn) => n + turn.content.length, 0)).toBeLessThanOrEqual(12000);
      expect(history.length % 2).toBe(0);
      return ok('"'.repeat(4000));
    });
    for (let n = 0; n < 5; n++) await c.send('"'.repeat(1000));
    expect(c.error.hidden).toBe(true);
  });

  it('viser en forståelig besked når en udløbet session returnerer en login-side i stedet for JSON', async () => {
    const c = client(async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token < private HTML'); } }));
    await c.send('Hvad står der?');
    expect(c.error.textContent).toContain('kontrollér at du er logget ind');
    expect(c.error.textContent).not.toContain('private HTML'); expect(c.submit.disabled).toBe(false);
    expect(c.question.value).toBe('Hvad står der?');
  });
});

function detail(chat) {
  return {
    base: '/lager/bilag', csrf: 'TESTDATA-csrf', op: 'test', b: {
      id: 7, file_id: 9, version: 1, doc_type: 'kvittering', status: 'klar', supplier_name: 'TESTDATA',
      currency: 'DKK', uncertain: '[]', reading_note: '', reading_token: '', payment: 'virksomhed',
      created_at: 1793291400, file_name: 'TESTDATA.png', uploaded_name: 'TESTDATA bruger',
    }, file: { mime: 'image/png', size: 100 }, lines: [], allocs: [], events: [],
    checks: { errors: [], warnings: [], base: null, allocated: 0 }, jobs: [], products: [], users: [], suggestions: [],
    canEdit: false, canDelete: false, manager: false, vatRegistered: true, errs: [], chat,
  };
}
describe('Bilagschat på detaljesiden', () => {
  it('ligger sammen med originalen, har en selvstændig CSRF-form og kræver ikke redigeringsret', async () => {
    const html = String(await detailPage(detail({ available: true })));
    const form = html.match(/<form[^>]+data-chat-form[\s\S]*?<\/form>/)[0];
    expect(form).toContain('action="/lager/bilag/7/spoerg"'); expect(form).toContain('name="_csrf" value="TESTDATA-csrf"');
    expect(form).toContain('name="version" value="1"'); expect(form).toContain('name="file_id" value="9"');
    expect(form).toContain('maxlength="1000"'); expect(form).not.toContain(' disabled');
    expect(html).toContain('Chatten ændrer ikke bilaget.'); expect(html).toContain('href="/lager/bilag/7/fil"');
    expect(html).toContain('src="/static/bilag-chat.js?v=1"'); expect(html).not.toMatch(/<script>(?!<\/script>)/);
  });
  it('blokerer afsendelse når kilde/model mangler og HTML-escaper et eventuelt serversvar', async () => {
    const html = String(await detailPage(detail({ available: false, message: 'TESTDATA kilde mangler', question: '<b>spørgsmål</b>', answer: '<script>bad()</script>', sources: [{ page: 1, lineStart: 2, lineEnd: 2, text: '<img>' }] })));
    expect(html).toContain('TESTDATA kilde mangler'); expect(html).toMatch(/name="question"[^>]+disabled/);
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;'); expect(html).toContain('&lt;img&gt;');
  });
});
