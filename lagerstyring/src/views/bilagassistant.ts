import { html } from 'hono/html';
import { FILE_MAX_BYTES } from '../lib/files';
import { errors, pageHead } from './common';
import { csrfField, opField, type H } from './layout';

export interface BilagAssistantData {
  base: string;
  csrf: string;
  op: string;
  available: boolean;
  message?: string;
  errs?: string[];
}

/** One active original per conversation; changing it starts a fresh context. */
export function bilagAssistantPage(d: BilagAssistantData): H {
  const dis = !d.available ? html` disabled` : '';
  return html`<div class="stack-lg" data-bilag-assistant data-base="${d.base}" data-max-bytes="${FILE_MAX_BYTES}">
    ${pageHead(html`<a href="${d.base}">Bilag</a>`, 'Bilagsassistent', '', 'Upload et bilag direkte i chatten, og stil spørgsmål til indholdet.')}
    ${errors(d.errs ?? [])}
    ${d.message ? html`<p class="alert alert-info" role="status">${d.message}</p>` : ''}
    ${!d.available ? html`<p class="alert alert-info" role="status">Bilagschatten er ikke tilsluttet på denne installation.</p>` : ''}
    <div class="bilag-split">
      <section class="card stack" aria-labelledby="assistant-original-title">
        <div class="row-between"><h2 id="assistant-original-title">Originalbilag</h2><a class="small" data-assistant-original target="_blank" rel="noopener" hidden>Åbn originalen</a></div>
        <p class="muted" data-assistant-file-name>Intet bilag valgt</p>
        <div data-assistant-preview><p class="hint">Dit bilag vises her, når du har uploadet det. PDF, JPG, PNG eller HEIC, højst 15 MB.</p></div>
        <p class="hint">Originalen gemmes uændret. Samtalen bruger ét bilag ad gangen.</p>
        <a class="btn btn-secondary hidden" data-assistant-detail hidden>Åbn bilagets oplysninger</a>
      </section>
      <section class="card stack" aria-labelledby="assistant-chat-title">
        <h2 id="assistant-chat-title">Spørg til bilaget</h2>
        <p class="hint">AI hjælper dig med at gennemgå bilaget. Kildeuddrag kommer fra den aflæste tekst. Sammenhold med originalen. Chatten retter eller godkender ikke bilaget.</p>
        <p class="hint">PNG/JPG op til 6 MB kan gennemgås som billede. PDF, HEIC og større billeder gennemgås ud fra aflæst tekst.</p>
        <div class="stack" data-assistant-messages role="log" aria-label="Samtale om det valgte bilag" aria-live="polite" aria-relevant="additions" style="min-height:8rem;max-height:32rem;overflow-y:auto;overflow-wrap:anywhere">
          <p class="muted">Vedhæft dit bilag nedenfor. Du kan skrive dit spørgsmål, mens filen uploades.</p>
        </div>
        <form class="stack" method="post" action="${d.base}/chat/upload" enctype="multipart/form-data" data-assistant-upload data-multi>
          ${csrfField(d.csrf)}${opField(d.op)}
          <div class="field" data-assistant-drop style="border:1px dashed var(--line-strong);border-radius:10px;padding:14px">
            <label for="assistant-file">Vedhæft bilag</label>
            <input id="assistant-file" type="file" name="file" accept="application/pdf,image/jpeg,image/png,image/heic,.pdf,.jpg,.jpeg,.png,.heic" required${dis}>
            <p class="hint" data-assistant-file-hint>Vælg eller træk ét bilag hertil. Et nyt bilag starter en ny samtale.</p>
          </div>
          <button class="btn btn-secondary" type="submit"${dis}>Upload bilag</button>
          <noscript><p class="hint">Efter upload åbnes bilagets side, hvor du kan stille dit spørgsmål.</p></noscript>
        </form>
        <form class="stack" method="post" action="${d.base}/chat" data-assistant-question data-multi>
          ${csrfField(d.csrf)}<input type="hidden" name="version" value=""><input type="hidden" name="file_id" value=""><input type="hidden" name="history" value="[]">
          <div class="field"><label for="assistant-question">Dit spørgsmål</label><textarea id="assistant-question" name="question" rows="3" maxlength="1000" required aria-describedby="assistant-help" placeholder="Fx: Hvad står der på varelinjerne?"${dis}></textarea><p class="hint" id="assistant-help">Upload et bilag, og tryk derefter Spørg. Første svar kan tage et par minutter, mens teksten aflæses.</p></div>
          <div class="row"><button class="btn btn-primary" type="submit" disabled>Spørg</button><span class="hint" role="status" data-assistant-status></span></div>
          <p class="err-text small" role="alert" data-assistant-error hidden></p>
        </form>
      </section>
    </div>
  </div><script src="/static/bilag-assistant.js?v=1" defer></script>`;
}

export const BILAG_ASSISTANT_JS = `
(function () {
  'use strict';
  document.querySelectorAll('[data-bilag-assistant]').forEach(function (root) {
    var base = root.getAttribute('data-base');
    if (!/^\\/(lager|job)\\/bilag$/.test(base)) return;
    var maxBytes = Number(root.getAttribute('data-max-bytes')) || 15728640;
    var upload = root.querySelector('[data-assistant-upload]');
    var ask = root.querySelector('[data-assistant-question]');
    var picker = upload.querySelector('[name=file]');
    var uploadButton = upload.querySelector('button[type=submit]');
    var askButton = ask.querySelector('button[type=submit]');
    var question = ask.querySelector('[name=question]');
    var status = root.querySelector('[data-assistant-status]');
    var error = root.querySelector('[data-assistant-error]');
    var messages = root.querySelector('[data-assistant-messages]');
    var preview = root.querySelector('[data-assistant-preview]');
    var original = root.querySelector('[data-assistant-original]');
    var detail = root.querySelector('[data-assistant-detail]');
    var fileName = root.querySelector('[data-assistant-file-name]');
    var fileHint = root.querySelector('[data-assistant-file-hint]');
    var drop = root.querySelector('[data-assistant-drop]');
    var active = null, selected = null, busy = false, history = [], available = !question.disabled && !picker.disabled;
    // A dropped File is held in memory rather than assigned to the native
    // input's read-only FileList. JS validates it; no-JS keeps native required.
    picker.required = false;
    function showError(text) { error.textContent = text; error.hidden = false; }
    function controls() {
      picker.disabled = !available || busy;
      uploadButton.disabled = !available || busy || !selected;
      askButton.disabled = !available || busy || !active;
    }
    function addMessage(label, text) {
      var entry = document.createElement('div'); entry.className = 'stack-sm';
      var heading = document.createElement('strong'); heading.textContent = label;
      var body = document.createElement('p'); body.style.whiteSpace = 'pre-wrap'; body.textContent = text;
      entry.append(heading, body); messages.append(entry); return entry;
    }
    function sources(entry, refs) {
      if (!Array.isArray(refs)) return;
      refs.slice(0, 8).forEach(function (ref) {
        if (!ref || typeof ref.text !== 'string' || !Number.isSafeInteger(ref.page) || !Number.isSafeInteger(ref.lineStart) || !Number.isSafeInteger(ref.lineEnd)) return;
        var quote = document.createElement('blockquote'); quote.className = 'small';
        quote.style.margin = '8px 0'; quote.style.paddingLeft = '12px'; quote.style.borderLeft = '2px solid var(--line-strong)';
        var label = document.createElement('strong'); label.textContent = 'Side ' + ref.page + ', linje ' + ref.lineStart + (ref.lineEnd === ref.lineStart ? '' : '–' + ref.lineEnd);
        var body = document.createElement('p'); body.style.whiteSpace = 'pre-wrap'; body.textContent = ref.text;
        quote.append(label, body); entry.append(quote);
      });
    }
    function trimHistory() {
      history = history.slice(-6);
      while (history.length && (history.reduce(function (n, turn) { return n + turn.content.length; }, 0) > 12000 || JSON.stringify(history).length > 16000)) history.splice(0, 2);
    }
    function select(files) {
      if (busy || picker.disabled) return;
      error.hidden = true;
      if (files.length !== 1) { selected = null; fileHint.textContent = 'Vælg ét bilag ad gangen.'; showError('Vedhæft ét bilag til samtalen.'); controls(); return; }
      var file = files[0];
      if (!file.size || file.size > maxBytes) { selected = null; showError('Filen skal være større end 0 og højst 15 MB.'); controls(); return; }
      if (!/\\.(pdf|jpe?g|png|heic)$/i.test(file.name) && !['application/pdf', 'image/jpeg', 'image/png', 'image/heic'].includes(file.type)) { selected = null; showError('Vælg en PDF, JPG, PNG eller HEIC-fil.'); controls(); return; }
      selected = file; fileHint.textContent = file.name + ' · klar til upload'; controls();
    }
    async function json(response) {
      var data;
      try { data = await response.json(); } catch (_) { throw new Error('Genindlæs siden, kontrollér at du er logget ind, og prøv igen.'); }
      if (!response.ok) throw new Error(data.error || data.message || 'Handlingen kunne ikke gennemføres. Prøv igen.');
      return data;
    }
    function setOriginal(data, file) {
      var url = new URL(data.url, location.origin);
      if (!Number.isSafeInteger(data.id) || data.id < 1 || !Number.isSafeInteger(data.version) || data.version < 1 || !Number.isSafeInteger(data.file_id) || data.file_id < 1 || typeof data.fileName !== 'string' || data.fileName.length > 300 || url.origin !== location.origin || url.username || url.password || url.pathname !== base + '/' + data.id || url.search || url.hash) throw new Error('Uploadsvaret kunne ikke kontrolleres. Det tidligere bilag er stadig valgt.');
      active = { id: data.id, url: url.pathname, version: data.version, file_id: data.file_id };
      history = []; messages.replaceChildren(); addMessage('Bilag valgt', data.fileName + '. Samtalen handler nu kun om dette bilag.');
      fileName.textContent = data.fileName; original.href = active.url + '/fil'; original.hidden = false;
      detail.href = active.url; detail.hidden = false; detail.classList.remove('hidden'); preview.replaceChildren();
      var mime = typeof data.mime === 'string' ? data.mime : file.type;
      if (mime === 'application/pdf') { var frame = document.createElement('iframe'); frame.className = 'orig-frame'; frame.title = 'Originalbilag (PDF)'; frame.src = original.href; preview.append(frame); }
      else if (mime === 'image/png' || mime === 'image/jpeg') { var image = document.createElement('img'); image.className = 'orig-img'; image.alt = 'Originalbilag: ' + data.fileName; image.src = original.href; preview.append(image); }
      else { var note = document.createElement('p'); note.className = 'hint'; note.textContent = 'Denne filtype kan ikke vises i alle browsere. Brug Åbn originalen for at se eller hente filen.'; preview.append(note); }
      ask.action = active.url + '/spoerg'; ask.querySelector('[name=version]').value = String(active.version); ask.querySelector('[name=file_id]').value = String(active.file_id); ask.querySelector('[name=history]').value = '[]';
      if (typeof data.op === 'string' && data.op) upload.querySelector('[name=op]').value = data.op;
    }
    picker.addEventListener('change', function () { select(Array.from(picker.files || [])); });
    drop.addEventListener('dragover', function (event) { event.preventDefault(); });
    drop.addEventListener('drop', function (event) { event.preventDefault(); if (event.dataTransfer) select(Array.from(event.dataTransfer.files || [])); });
    upload.addEventListener('submit', async function (event) {
      event.preventDefault(); if (busy || picker.disabled) return;
      if (!selected) { showError('Vælg et bilag først.'); return; }
      busy = true; controls(); error.hidden = true; status.textContent = 'Uploader originalbilaget…'; upload.setAttribute('aria-busy', 'true');
      var file = selected; var body = new FormData();
      body.set('_csrf', upload.querySelector('[name=_csrf]').value); body.set('op', upload.querySelector('[name=op]').value); body.set('file', file);
      var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, 60000);
      try {
        var data = await json(await fetch(upload.action, { method: 'POST', body: body, credentials: 'same-origin', headers: { Accept: 'application/json' }, signal: controller.signal }));
        setOriginal(data, file); selected = null; picker.value = ''; fileHint.textContent = 'Vedhæft et nyt bilag for at starte en ny samtale.'; uploadButton.textContent = 'Upload nyt bilag'; status.textContent = 'Bilaget er gemt uændret. Stil dit spørgsmål nedenfor.';
      } catch (failure) { showError(failure.name === 'AbortError' ? 'Upload tog for lang tid. Dit spørgsmål er bevaret; prøv upload igen.' : failure.message); status.textContent = ''; }
      finally { clearTimeout(timer); busy = false; upload.removeAttribute('aria-busy'); controls(); question.focus(); }
    });
    ask.addEventListener('submit', async function (event) {
      event.preventDefault(); if (busy || question.disabled) return;
      if (!active) { showError('Upload et bilag, før du sender dit spørgsmål.'); return; }
      var text = question.value.trim(); if (!text || text.length > 1000) { question.focus(); return; }
      busy = true; controls(); error.hidden = true; status.textContent = 'Henter bilagets tekst og finder kildeuddrag…'; ask.setAttribute('aria-busy', 'true');
      trimHistory(); var body = new URLSearchParams();
      body.set('_csrf', ask.querySelector('[name=_csrf]').value); body.set('version', String(active.version)); body.set('file_id', String(active.file_id)); body.set('question', text); body.set('history', JSON.stringify(history));
      addMessage('Dig', text); var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, 180000);
      try {
        var data = await json(await fetch(ask.action, { method: 'POST', body: body, credentials: 'same-origin', headers: { Accept: 'application/json' }, signal: controller.signal }));
        if (typeof data.answer !== 'string' || !data.answer.trim()) throw new Error('Chatten gav ikke et svar. Prøv igen.');
        var reply = addMessage('Bilagsassistent', data.answer); sources(reply, data.sources);
        var basis = document.createElement('p'); basis.className = 'hint'; basis.textContent = data.imageReviewed === true ? 'Grundlag: originalbillede og aflæst tekst' : 'Grundlag: aflæst tekst'; reply.append(basis);
        history.push({ role: 'user', content: text }, { role: 'assistant', content: data.answer.slice(0, 4000) }); trimHistory();
        ask.querySelector('[name=history]').value = JSON.stringify(history); if (question.value.trim() === text) question.value = '';
        status.textContent = 'Svaret er klar. Sammenhold kildeuddragene med originalen.'; messages.scrollTop = messages.scrollHeight;
      } catch (failure) { showError(failure.name === 'AbortError' ? 'Svaret tog for lang tid. Dit spørgsmål er bevaret; prøv igen.' : failure.message); status.textContent = ''; }
      finally { clearTimeout(timer); busy = false; ask.removeAttribute('aria-busy'); controls(); question.focus(); }
    });
    controls();
  });
})();
`;
