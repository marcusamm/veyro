// Same-origin chat enhancement. All server/model content is rendered as text.
export const BILAG_CHAT_JS = `
(function () {
  'use strict';
  document.querySelectorAll('[data-bilag-chat]').forEach(function (panel) {
    var form = panel.querySelector('[data-chat-form]');
    var question = form.querySelector('[name=question]');
    var messages = panel.querySelector('[data-chat-messages]');
    var status = panel.querySelector('[data-chat-status]');
    var error = panel.querySelector('[data-chat-error]');
    var historyInput = form.querySelector('[data-chat-history]');
    var submit = form.querySelector('button[type=submit]');
    var history = [];
    var busy = false;
    function trimHistory() {
      history = history.slice(-6);
      while (history.length && (history.reduce(function (size, turn) { return size + turn.content.length; }, 0) > 12000 || JSON.stringify(history).length > 16000)) history.splice(0, 2);
    }
    function addMessage(name, text) {
      var entry = document.createElement('div'); entry.className = 'stack-sm';
      var label = document.createElement('strong'); label.textContent = name;
      var body = document.createElement('p'); body.style.whiteSpace = 'pre-wrap'; body.textContent = text;
      entry.append(label, body); messages.append(entry);
      return entry;
    }
    function addSources(entry, sources) {
      if (!Array.isArray(sources)) return;
      sources.slice(0, 8).forEach(function (source) {
        if (!source || typeof source.text !== 'string' || !Number.isSafeInteger(source.page) || !Number.isSafeInteger(source.lineStart) || !Number.isSafeInteger(source.lineEnd)) return;
        var quote = document.createElement('blockquote'); quote.className = 'small';
        quote.style.margin = '8px 0'; quote.style.paddingLeft = '12px'; quote.style.borderLeft = '2px solid var(--line-strong)';
        var label = document.createElement('strong');
        label.textContent = 'Side ' + source.page + ', linje ' + source.lineStart + (source.lineEnd === source.lineStart ? '' : '–' + source.lineEnd);
        var body = document.createElement('p'); body.style.whiteSpace = 'pre-wrap'; body.textContent = source.text;
        quote.append(label, body); entry.append(quote);
      });
    }
    panel.querySelectorAll('[data-chat-question]').forEach(function (button) {
      button.addEventListener('click', function () {
        if (busy || question.disabled) return;
        question.value = button.getAttribute('data-chat-question'); question.focus();
      });
    });
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (busy || question.disabled) return;
      var text = question.value.trim();
      if (!text || text.length > 1000) { question.focus(); return; }
      busy = true; submit.disabled = true; error.hidden = true; error.textContent = '';
      status.textContent = 'Læser bilaget og finder kildeuddrag…'; form.setAttribute('aria-busy', 'true');
      trimHistory(); historyInput.value = JSON.stringify(history);
      var body = new URLSearchParams(new FormData(form));
      var controller = new AbortController(); var timer = setTimeout(function () { controller.abort(); }, 60000);
      addMessage('Dig', text);
      try {
        var response = await fetch(form.action, { method: 'POST', body: body, credentials: 'same-origin', headers: { Accept: 'application/json' }, signal: controller.signal });
        var data;
        try { data = await response.json(); }
        catch (_) { throw new Error('Chatten kunne ikke svare. Genindlæs bilaget, kontrollér at du er logget ind, og prøv igen.'); }
        if (!response.ok || typeof data.answer !== 'string' || !data.answer.trim()) throw new Error(data.error || data.message || 'Chatten kunne ikke svare. Prøv igen.');
        var entry = addMessage('Bilagsassistent', data.answer); addSources(entry, data.sources);
        history.push({ role: 'user', content: text }, { role: 'assistant', content: data.answer.slice(0, 4000) }); trimHistory();
        question.value = ''; historyInput.value = JSON.stringify(history); status.textContent = 'Svaret er klar. Kontrollér kildeuddragene mod originalen.';
        messages.scrollTop = messages.scrollHeight;
      } catch (failure) {
        error.textContent = failure.name === 'AbortError' ? 'Svaret tog for lang tid. Dit spørgsmål er bevaret; prøv igen.' : (failure.message || 'Forbindelsen til chatten blev afbrudt. Prøv igen.');
        error.hidden = false; status.textContent = '';
      } finally {
        clearTimeout(timer); busy = false; submit.disabled = false; form.removeAttribute('aria-busy'); question.focus();
      }
    });
  });
})();
`;
