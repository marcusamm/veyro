// All message headers, file names and bodies are untrusted plain text.
(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const node = (tag, className, value) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (value != null) el.textContent = value;
    return el;
  };
  const icons = {
    inbox: '<path d="m3 12 3-7h12l3 7v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM3 13h5l2 3h4l2-3h5"/>',
    sent: '<path d="m3 10 17-6-5 16-4-7zM11 13l9-9"/>',
    archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11h14V8m-10 4h6"/>',
    search: '<circle cx="10" cy="10" r="6.5"/><path d="m15 15 5 5"/>',
    drafts: '<path d="M6 3h8l4 4v14H6zM14 3v5h4m-9 4h6m-6 4h6"/>',
    trash: '<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
    junk: '<path d="m8 3-5 5v8l5 5h8l5-5V8l-5-5zM12 7v6m0 3v.5"/>',
    other: '<path d="M3 6h6l2 2h10v11H3z"/>',
    write: '<path d="m13 6 5 5M4 20l4-1 12-12a2 2 0 0 0-4-4L4 16z"/>',
    close: '<path d="m5 5 14 14M19 5 5 19"/>',
    refresh: '<path d="M19 8a8 8 0 1 0 1 7M19 3v6h-6"/>',
    back: '<path d="m10 5-7 7 7 7M3 12h18"/>',
    reply: '<path d="m10 5-7 7 7 7M3 12h10q7 0 8 7"/>',
    clip: '<path d="m9 13 6-6a2 2 0 0 1 3 3l-8 8a4 4 0 1 1-6-6l9-9"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  };
  function icon(name) {
    const el = node('span', 'glyph');
    el.setAttribute('aria-hidden', 'true');
    // Only the static paths above enter the SVG template.
    const path = Object.hasOwn(icons, name) ? icons[name] : icons.other;
    el.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
    return el;
  }
  document.querySelectorAll('[data-icon]').forEach(el => el.replaceWith(icon(el.dataset.icon)));

  const folderNames = {inbox: 'Indbakke', sent: 'Sendt', drafts: 'Kladder', archive: 'Arkiv', junk: 'Spam', trash: 'Papirkurv'};
  const shortDate = new Intl.DateTimeFormat('da-DK', {day: 'numeric', month: 'short'});
  const dateTime = new Intl.DateTimeFormat('da-DK', {dateStyle: 'long', timeStyle: 'short'});
  const clock = new Intl.DateTimeFormat('da-DK', {timeStyle: 'short'});
  const count = new Intl.NumberFormat('da-DK');
  let session = null;
  let folders = [], folder = null, messages = [], cursor = null, selected = null, reply = null;
  let listRequest, detailRequest, folderRequest, retryList, searchTimer, noticeTimer;
  let sending = false;
  let sendAttempt = null;

  class ApiError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }
  function message(error) {
    return error instanceof ApiError ? error.message : 'Forbindelsen blev afbrudt. Kontrollér din forbindelse.';
  }
  async function api(path, options = {}) {
    const {body, signal, idempotencyKey, method = 'GET'} = options;
    const current = session;
    const headers = {Accept: 'application/json'};
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && session) headers['X-CSRF-Token'] = session.csrfToken;
    const response = await fetch('/api/' + path, {method, headers, signal, mode: 'same-origin',
      credentials: 'same-origin', cache: 'no-store', body: body === undefined ? undefined : JSON.stringify(body)});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && current && session === current && path !== 'login') loggedOut('Din session er udløbet. Log ind igen.');
      throw new ApiError(typeof data.error === 'string' ? data.error : 'Postkassen kunne ikke behandle anmodningen.', response.status);
    }
    return data;
  }
  function setError(id, value = '') {
    byId(id).textContent = value;
    byId(id).hidden = !value;
  }
  function notify(value) {
    clearTimeout(noticeTimer);
    byId('notice').textContent = value;
    byId('notice').hidden = false;
    noticeTimer = setTimeout(() => { byId('notice').hidden = true; }, 7000);
  }
  function resetDraft() {
    byId('draft').reset();
    reply = null; sendAttempt = null;
    setError('send-error');
  }
  function revealPassword(visible) {
    byId('password').type = visible ? 'text' : 'password';
    byId('show-password').setAttribute('aria-pressed', String(visible));
    byId('show-password').title = visible ? 'Skjul adgangskode' : 'Vis adgangskode';
  }
  byId('show-password').onclick = () => revealPassword(byId('password').type === 'password');
  function loggedOut(reason = '') {
    session = null;
    document.body.classList.add('entry');
    folderRequest?.abort(); listRequest?.abort(); detailRequest?.abort();
    clearTimeout(searchTimer); clearTimeout(noticeTimer);
    if (byId('composer').open) byId('composer').close();
    resetDraft();
    folders = []; folder = null; messages = []; cursor = null; selected = null;
    byId('paper').replaceChildren(); byId('messages').replaceChildren(); byId('folders').replaceChildren();
    byId('address').textContent = ''; byId('search').value = ''; byId('notice').hidden = true;
    byId('account').hidden = byId('workspace').hidden = byId('connecting').hidden = true;
    byId('gate').hidden = byId('login').hidden = false;
    byId('password').value = '';
    revealPassword(false);
    document.title = 'Log ind · Veyro Mail';
    setError('login-error', reason);
    if (matchMedia('(min-width: 46.01rem)').matches && document.activeElement === document.body) byId('email').focus({preventScroll: true});
  }
  function loggedIn(data) {
    if (!data.email || !data.csrfToken) throw new ApiError('Postkassen returnerede en ugyldig session.', 502);
    session = {email: data.email, csrfToken: data.csrfToken};
    document.body.classList.remove('entry');
    byId('password').value = '';
    byId('address').textContent = data.email;
    byId('gate').hidden = true;
    byId('account').hidden = byId('workspace').hidden = false;
    clearReader();
    loadFolders();
  }
  async function connect() {
    byId('connect-again').hidden = true;
    byId('connection-status').textContent = 'Henter din postkasse …';
    try { loggedIn(await api('session')); }
    catch (error) {
      if (error.status === 401) return loggedOut();
      byId('connection-status').textContent = message(error);
      byId('connect-again').hidden = false;
    }
  }
  byId('connect-again').onclick = connect;
  byId('login').onsubmit = async event => {
    event.preventDefault();
    const button = byId('login-submit');
    if (button.disabled) return;
    button.disabled = true; setError('login-error');
    try { loggedIn(await api('login', {method: 'POST', body: {email: byId('email').value.trim(), password: byId('password').value}})); }
    catch (error) { setError('login-error', message(error)); }
    finally { button.disabled = false; }
  };
  byId('sign-out').onclick = async () => {
    if (hasDraft() && !confirm('Log ud og kassér din åbne kladde?')) return;
    const button = byId('sign-out');
    button.disabled = true;
    try { await api('logout', {method: 'POST', body: {}}); loggedOut(); byId('email').focus(); }
    catch (error) { if (session) notify(message(error)); }
    finally { button.disabled = false; }
  };
  function nameOf(f) { return Object.hasOwn(folderNames, f.role) ? folderNames[f.role] : f.name; }
  function drawFolders() {
    const focused = document.activeElement?.closest('#folders .folder')?.dataset.id;
    byId('folders').replaceChildren(...folders.map(f => {
      const button = node('button', 'folder');
      button.type = 'button';
      button.dataset.id = f.id;
      button.title = nameOf(f);
      button.setAttribute('aria-current', String(f.id === folder?.id));
      button.setAttribute('aria-label', nameOf(f) + (f.unread ? ', ' + count.format(f.unread) + ' ulæste' : ''));
      button.append(icon(f.role), node('span', 'folder-label', nameOf(f)));
      if (f.unread > 0) button.append(node('span', 'folder-count', count.format(f.unread)));
      button.onclick = () => chooseFolder(f);
      return button;
    }));
    if (focused) Array.from(byId('folders').children).find(b => b.dataset.id === focused)?.focus({preventScroll: true});
  }
  function listState(text, retry = null) {
    byId('list-state').textContent = text;
    byId('retry-list').hidden = !retry;
    retryList = retry;
  }
  byId('retry-list').onclick = () => retryList?.();
  async function loadFolders() {
    folderRequest?.abort();
    const request = folderRequest = new AbortController();
    listState('Henter mapper …');
    try {
      const result = await api('folders', {signal: request.signal});
      if (request.signal.aborted) return;
      const rank = f => Object.hasOwn(folderNames, f.role) ? Object.keys(folderNames).indexOf(f.role) : 99;
      folders = (result.folders || []).sort((a, b) => rank(a) - rank(b));
      const current = folders.find(f => f.id === folder?.id);
      if (current) {
        folder = current; drawFolders(); return loadList();
      }
      const first = folders.find(f => f.role === 'inbox') || folders[0];
      if (!first) { drawFolders(); return listState('Postkassen har ingen mapper.', loadFolders); }
      chooseFolder(first);
    } catch (error) {
      if (!request.signal.aborted) listState(message(error), loadFolders);
    }
  }
  function chooseFolder(f) {
    clearTimeout(searchTimer);
    folder = f; byId('search').value = '';
    byId('folder-title').textContent = nameOf(f);
    byId('back-folder').textContent = 'Tilbage til ' + nameOf(f);
    document.title = nameOf(f) + ' · Veyro Mail';
    drawFolders();
    loadList();
  }
  function dateValue(value, full) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return '';
    if (full) return dateTime.format(date);
    return (date.toDateString() === new Date().toDateString() ? clock : shortDate).format(date);
  }
  function person(header) {
    const text = String(header || '').trim();
    const match = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(text);
    return match ? {name: match[1].replace(/^"|"$/g, '') || match[2], address: match[2]} : {name: text, address: text};
  }
  function messageRow(item) {
    const li = node('li');
    const b = node('button', 'message-row' + (item.unread ? ' unread' : ''));
    b.type = 'button'; b.dataset.id = item.id;
    b.setAttribute('aria-pressed', String(item.id === selected));
    b.setAttribute('aria-controls', 'paper');
    const sent = folder.role === 'sent' || folder.role === 'drafts';
    const author = person(sent ? item.to : item.from).name;
    b.append(node('span', 'row-sender', (sent ? 'Til ' : '') + (author || 'Ukendt')));
    const stamp = node('span', 'row-time');
    if (item.hasAttachments) { const clip = icon('clip'); clip.removeAttribute('aria-hidden'); clip.setAttribute('role','img'); clip.setAttribute('aria-label','Vedhæftede filer'); stamp.append(clip); }
    stamp.append(node('time', '', dateValue(item.date)));
    b.append(stamp, node('strong', 'row-title', item.subject || '(Intet emne)'));
    if (item.snippet) b.append(node('span', 'row-snippet', item.snippet));
    if (item.unread) b.append(node('span', 'visually-hidden', 'Ulæst'));
    li.append(b);
    return li;
  }
  function clearReader() {
    detailRequest?.abort();
    selected = null; byId('workspace').dataset.reader = 'false';
    const empty = node('div', 'reader-empty');
    const mark = node('img'); mark.src = '/favicon.svg'; mark.alt = '';
    empty.append(mark, node('h2', '', 'Vælg en mail'));
    byId('paper').replaceChildren(empty);
    byId('reader').scrollTop = 0;
  }
  async function loadList(more = false) {
    if (!folder || (more && !cursor)) return;
    listRequest?.abort();
    const request = listRequest = new AbortController();
    const params = new URLSearchParams({folder: folder.id});
    const query = byId('search').value.trim();
    if (query) params.set('q', query);
    if (more) params.set('cursor', cursor);
    else {
      clearReader(); cursor = null; messages = [];
      byId('messages').replaceChildren(); byId('mail-count').textContent = ''; byId('list-scroll').scrollTop = 0;
    }
    byId('older').hidden = true;
    listState(more ? 'Henter ældre mails …' : 'Henter mails …');
    try {
      const result = await api('messages?' + params, {signal: request.signal});
      if (request.signal.aborted) return;
      const seen = new Set(messages.map(item => item.id));
      const rows = [];
      for (const item of result.messages || []) {
        if (seen.has(item.id)) continue;
        seen.add(item.id); messages.push(item); rows.push(messageRow(item));
      }
      byId('messages').append(...rows);
      cursor = result.nextCursor || null;
      byId('mail-count').textContent = count.format(messages.length) + (cursor ? '+' : '') + (messages.length === 1 && !cursor ? ' mail' : ' mails');
      listState(messages.length ? '' : query ? 'Ingen mails matcher din søgning.' : 'Mappen er tom.');
      byId('older').hidden = !cursor;
    } catch (error) {
      if (!request.signal.aborted) listState(message(error), () => loadList(more));
    }
  }
  byId('older').onclick = () => loadList(true);
  byId('refresh').onclick = loadFolders;
  byId('search').oninput = () => {
    clearTimeout(searchTimer);
    listRequest?.abort();
    byId('older').hidden = true;
    searchTimer = setTimeout(() => loadList(), 240);
  };
  byId('messages').onclick = event => {
    const row = event.target.closest('button[data-id]');
    if (row) openMail(row.dataset.id);
  };
  function rowFor(id) {
    return Array.from(byId('messages').querySelectorAll('button')).find(row => row.dataset.id === String(id));
  }
  byId('back').onclick = () => {
    const before = selected;
    clearReader();
    const row = rowFor(before);
    row?.setAttribute('aria-pressed', 'false');
    (row || byId('folder-title')).focus();
  };
  function sizeText(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return count.format(bytes) + ' B';
    if (bytes < 1048576) return count.format(Math.ceil(bytes / 1024)) + ' kB';
    return new Intl.NumberFormat('da-DK', {maximumFractionDigits: 1}).format(bytes / 1048576) + ' MB';
  }
  async function downloadFile(link, name, status) {
    if (link.getAttribute('aria-busy') === 'true') return;
    const current = session;
    link.setAttribute('aria-busy', 'true');
    status.textContent = 'Henter ' + name + ' …';
    try {
      const response = await fetch(link.href, {mode: 'same-origin', credentials: 'same-origin', cache: 'no-store'});
      if (!response.ok) {
        if (response.status === 401 && session === current) return loggedOut('Din session er udløbet. Log ind igen.');
        const data = await response.json().catch(() => ({}));
        throw new ApiError(data.error || 'Filen kunne ikke hentes.', response.status);
      }
      const file = await response.blob();
      if (session !== current) return;
      const url = URL.createObjectURL(file);
      const save = node('a');
      save.href = url; save.download = name.replace(/[\\/]/g, '_');
      document.body.append(save); save.click(); save.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      status.textContent = '';
    } catch (error) { status.textContent = message(error); }
    finally { link.removeAttribute('aria-busy'); }
  }
  function renderMail(item) {
    const article = node('article', 'letter');
    const title = node('h2', '', item.subject || '(Intet emne)');
    title.tabIndex = -1;
    const sender = person(item.from);
    const area = node('div', 'sender'), detail = node('div', 'sender-detail');
    const initials = sender.name.split('@')[0].split(/[\s.]+/).filter(Boolean).slice(0,2).map(s => Array.from(s)[0]).join('').toLocaleUpperCase('da');
    const avatar = node('span', 'avatar', initials || '·'); avatar.setAttribute('aria-hidden','true');
    detail.append(node('strong', '', sender.name || 'Ukendt afsender'));
    if (sender.address && sender.address !== sender.name) detail.append(node('span', '', sender.address));
    if (item.to) detail.append(node('span', '', 'Til ' + item.to));
    if (item.cc) detail.append(node('span', '', 'Cc ' + item.cc));
    area.append(avatar, detail); article.append(title, area);
    const stamp = dateValue(item.date, true);
    if (stamp) article.append(node('time', 'letter-date', stamp));
    article.append(node('div', 'letter-body', item.text || ''));
    if (item.attachments?.length) {
      const files = node('ul', 'attachments'); files.setAttribute('aria-label', 'Vedhæftede filer');
      const status = node('p', 'download-status'); status.setAttribute('role', 'status');
      for (const file of item.attachments) {
        const link = node('a'), li = node('li');
        const size = sizeText(file.size);
        const name = file.name || 'Vedhæftet fil';
        link.href = '/api/messages/' + encodeURIComponent(item.id) + '/attachments/' + encodeURIComponent(file.id) + '?' + new URLSearchParams({folder: folder.id});
        link.onclick = event => { event.preventDefault(); downloadFile(link, name, status); };
        link.append(icon('clip'), node('span', '', name + (size ? ' (' + size + ')' : '')));
        li.append(link); files.append(li);
      }
      article.append(files, status);
    }
    const to = folder.role === 'sent' ? item.to : item.replyTo || item.from;
    if (to) {
      const button = node('button', 'secondary'); button.type = 'button';
      button.append(icon('reply'), document.createTextNode('Svar'));
      button.onclick = () => openCompose({id: item.id, folder: folder.id, to, subject: item.subject || ''});
      article.append(button);
    }
    byId('paper').replaceChildren(article);
    title.focus({preventScroll: true});
  }
  async function openMail(id) {
    detailRequest?.abort();
    const request = detailRequest = new AbortController();
    rowFor(selected)?.setAttribute('aria-pressed', 'false');
    selected = id; byId('workspace').dataset.reader = 'true';
    rowFor(id)?.setAttribute('aria-pressed', 'true');
    const waiting = node('p', '', 'Åbner mail …'); waiting.setAttribute('role', 'status');
    byId('paper').replaceChildren(waiting); byId('reader').scrollTop = 0;
    try {
      const item = await api('messages/' + encodeURIComponent(id) + '?' + new URLSearchParams({folder: folder.id}), {signal: request.signal});
      if (request.signal.aborted) return;
      const existing = messages.find(m => String(m.id) === id);
      if (existing?.unread && item.unread === false) {
        existing.unread = false; folder.unread = Math.max(0, folder.unread - 1);
        rowFor(id)?.closest('li')?.replaceWith(messageRow(existing)); drawFolders();
      }
      renderMail(item);
    } catch (error) {
      if (request.signal.aborted) return;
      const text = node('p', 'reader-error', message(error)); text.setAttribute('role', 'alert');
      const retry = node('button', 'secondary', 'Prøv igen'); retry.type = 'button'; retry.onclick = () => openMail(id);
      byId('paper').replaceChildren(text, retry);
    }
  }
  function hasDraft() {
    return Boolean(byId('recipient').value || byId('subject').value || byId('body').value);
  }
  function openCompose(target) {
    if (target && (target.id !== reply?.id || target.folder !== reply?.folder)) {
      if (hasDraft() && !confirm('Kassér den åbne kladde og begynd på dette svar?')) return;
      resetDraft(); reply = target;
      byId('recipient').value = target.to;
      byId('subject').value = /^(re|sv):/i.test(target.subject) ? target.subject : 'Re: ' + target.subject;
    }
    byId('compose-title').textContent = reply ? 'Svar på mail' : 'Ny mail';
    byId('composer').showModal(); (reply ? byId('body') : byId('recipient')).focus();
  }
  byId('compose').onclick = () => openCompose();
  byId('close-compose').onclick = () => byId('composer').close();
  byId('composer').oncancel = event => { if (sending) event.preventDefault(); };
  byId('discard').onclick = () => {
    if (hasDraft() && !confirm('Kassér denne kladde?')) return;
    resetDraft(); byId('composer').close();
  };
  byId('draft').onsubmit = async event => {
    event.preventDefault();
    if (sending) return;
    const input = {to: byId('recipient').value.trim(), subject: byId('subject').value, text: byId('body').value};
    if (reply) { input.replyToId = reply.id; input.replyToFolder = reply.folder; }
    if (!input.to || !input.text.trim()) return setError('send-error', 'Udfyld modtager og besked.');
    const payload = JSON.stringify(input);
    if (sendAttempt?.payload !== payload) sendAttempt = {payload, key: crypto.randomUUID()};
    sending = true; setError('send-error');
    const controls = Array.from(byId('draft').elements);
    controls.forEach(el => { el.disabled = true; });
    try {
      const result = await api('send', {method: 'POST', body: input, idempotencyKey: sendAttempt.key});
      if (!result.sent) throw new ApiError('Afsendelsen kunne ikke bekræftes. Kontrollér Sendt.', 502);
      resetDraft(); byId('composer').close();
      const notices = [result.warning || 'Mailen er sendt.'];
      if (result.refused?.length) notices.push('Afvist for ' + result.refused.join(', ') + '.');
      notify(notices.join(' '));
      if (folder?.role === 'sent') loadList();
    } catch (error) {
      if (session) setError('send-error', error instanceof ApiError ? message(error) : 'Forbindelsen blev afbrudt under afsendelse. Tjek Sendt, før du prøver igen.');
    } finally { sending = false; controls.forEach(el => { el.disabled = false; }); }
  };
  window.addEventListener('beforeunload', event => {
    if (session && hasDraft()) { event.preventDefault(); event.returnValue = ''; }
  });
  // A restored history entry must check that the mailbox still belongs to this browser session.
  window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
  connect();
})();
