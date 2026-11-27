// All message content is untrusted. The reader builds its own DOM from allowed values.
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
    replyAll: '<path d="m8 6-6 6 6 6m6-12-6 6 6 6m-6-6h6q6 0 8 6"/>',
    forward: '<path d="m14 5 7 7-7 7m7-7h-9q-7 0-9 7"/>',
    more: '<circle cx="4" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="20" cy="12" r="1.5"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    tag: '<path d="M3 4h10l8 8-9 9-9-9z"/><circle cx="8" cy="9" r="1"/>',
    external: '<path d="M13 3h8v8m0-8L10 14m0-9H4v15h15v-6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
    check: '<path d="m4 12 5 5L20 6"/>',
    next: '<path d="m9 5 7 7-7 7"/>',
    plus: '<path d="M12 4v16M4 12h16"/>',
    clip: '<path d="m9 13 6-6a2 2 0 0 1 3 3l-8 8a4 4 0 1 1-6-6l9-9"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
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
  let readerItem = null, senderFilter = '', availableLabels = [];
  let pendingLink = new URLSearchParams(location.hash.slice(1));

  class ApiError extends Error {
    constructor(message, status, loginRequired = false) {
      super(message);
      this.status = status;
      this.loginRequired = loginRequired;
    }
  }
  function message(error) {
    return error instanceof ApiError ? error.message : 'Forbindelsen blev afbrudt. Kontrollér din forbindelse.';
  }
  async function api(path, options = {}) {
    const {body, signal, idempotencyKey, method = 'GET'} = options;
    const anonymous = path === 'recovery/request';
    const current = anonymous ? null : session;
    const headers = {Accept: 'application/json'};
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && current) headers['X-CSRF-Token'] = current.csrfToken;
    // Send the site's Origin on writes even when the login page suppresses referrers.
    const response = await fetch('/api/' + path, {method, headers, signal, mode: 'same-origin',
      referrerPolicy: method === 'POST' ? 'strict-origin' : undefined, redirect: 'error',
      credentials: anonymous ? 'omit' : 'same-origin', cache: 'no-store', body: body === undefined ? undefined : JSON.stringify(body)});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && current && session === current && path !== 'login') loggedOut('Din session er udløbet. Log ind igen.');
      throw new ApiError(typeof data.error === 'string' ? data.error : 'Postkassen kunne ikke behandle anmodningen.',
        response.status, data.loginRequired === true);
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
    byId('forward-files').hidden = true;
    byId('body').required = true;
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
    closeMenu(false);
    if (byId('label-dialog').open) byId('label-dialog').close();
    if (byId('snooze-dialog').open) byId('snooze-dialog').close();
    labelTarget = snoozeTarget = null;
    readerItem = null; senderFilter = ''; availableLabels = [];
    byId('account').open = false;
    if (recoveryDialog.open) recoveryDialog.close();
    recoveryForm.reset();
    if (byId('password-dialog').open) byId('password-dialog').close();
    byId('password-form').reset();
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
    byId('remember-me').checked = false;
    revealPassword(false);
    document.title = 'Log ind · Veyro Mail';
    setError('login-error', reason);
    setError('login-status');
    if (matchMedia('(min-width: 46.01rem)').matches && document.activeElement === document.body) byId('email').focus({preventScroll: true});
  }
  function loggedIn(data) {
    if (!data.email || !data.csrfToken) throw new ApiError('Postkassen returnerede en ugyldig session.', 502);
    session = {email: data.email, csrfToken: data.csrfToken};
    byId('open-recovery-settings').hidden = data.canManageRecovery === false;
    byId('open-administration').hidden = data.canManageOrganizations !== true;
    if (forgotDialog.open) forgotDialog.close();
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
    button.disabled = true; setError('login-error'); setError('login-status');
    try { loggedIn(await api('login', {method: 'POST', body: {email: byId('email').value.trim(), password: byId('password').value, rememberMe: byId('remember-me').checked}})); }
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
  const account = byId('account');
  const passwordDialog = byId('password-dialog');
  const passwordForm = byId('password-form');
  const forgotDialog = byId('forgot-dialog');
  const forgotForm = byId('forgot-form');
  const recoveryDialog = byId('recovery-dialog');
  const recoveryForm = byId('recovery-form');
  const recoveryEmail = byId('recovery-email');
  const recoveryCode = byId('recovery-code');
  let forgotRequest, enrollmentRequest;
  document.addEventListener('click', event => {
    if (account.open && !account.contains(event.target)) account.open = false;
  });
  account.onkeydown = event => {
    if (account.open && event.key === 'Escape') {
      account.open = false; byId('account-toggle').focus();
    }
  };
  account.onfocusout = event => {
    if (event.relatedTarget && !account.contains(event.relatedTarget)) account.open = false;
  };
  byId('forgot-password').onclick = () => {
    forgotForm.reset(); setError('forgot-error');
    forgotForm.hidden = false;
    byId('forgot-result').hidden = true;
    byId('forgot-hint').hidden = false;
    byId('forgot-email').value = byId('email').value.trim();
    forgotDialog.showModal(); byId('forgot-email').focus();
  };
  byId('cancel-forgot').onclick = byId('back-to-login').onclick = () => forgotDialog.close();
  forgotDialog.onclose = () => {
    forgotRequest?.abort(); forgotRequest = null;
    forgotForm.reset(); byId('send-reset').disabled = false;
    if (!session) byId('forgot-password').focus();
  };
  forgotForm.onsubmit = async event => {
    event.preventDefault();
    if (forgotRequest) return;
    const request = forgotRequest = new AbortController();
    byId('send-reset').disabled = true; setError('forgot-error');
    try {
      await api('recovery/request', {method: 'POST', signal: request.signal, body: {email: byId('forgot-email').value.trim()}});
      if (!forgotDialog.open || request.signal.aborted) return;
      forgotForm.hidden = byId('forgot-hint').hidden = true;
      byId('forgot-result').hidden = false; byId('back-to-login').focus();
    } catch (error) {
      if (forgotDialog.open && !request.signal.aborted) setError('forgot-error', message(error));
    } finally {
      if (forgotRequest === request) { forgotRequest = null; byId('send-reset').disabled = false; }
    }
  };
  function enrollmentStep(verify) {
    byId('recovery-verification').hidden = !verify;
    recoveryEmail.readOnly = verify;
    recoveryCode.required = verify;
    recoveryCode.disabled = !verify;
    recoveryCode.value = '';
    byId('recovery-instruction').textContent = verify ? 'Vi har sendt en kode til ' + recoveryEmail.value + '. Den er gyldig i 10 minutter.' : '';
    byId('save-recovery').textContent = verify ? 'Bekræft adresse' : 'Send kode';
  }
  byId('open-recovery-settings').onclick = () => {
    account.open = false; recoveryForm.reset();
    byId('recovery-account').value = session.email;
    enrollmentStep(false); setError('recovery-error');
    recoveryDialog.showModal(); recoveryEmail.focus();
  };
  byId('restart-enrollment').onclick = () => {
    if (!enrollmentRequest) { enrollmentStep(false); setError('recovery-error'); recoveryEmail.focus(); }
  };
  byId('cancel-recovery').onclick = () => recoveryDialog.close();
  recoveryDialog.onclose = () => {
    enrollmentRequest?.abort(); enrollmentRequest = null;
    recoveryForm.reset(); enrollmentStep(false);
    byId('save-recovery').disabled = false;
    if (session) byId('account-toggle').focus();
  };
  recoveryForm.onsubmit = async event => {
    event.preventDefault();
    const current = session;
    if (!current || enrollmentRequest) return;
    const request = enrollmentRequest = new AbortController();
    const verifying = !byId('recovery-verification').hidden;
    const body = {email: recoveryEmail.value.trim(), currentPassword: byId('recovery-password').value};
    if (verifying) body.code = recoveryCode.value.trim();
    recoveryEmail.readOnly = true;
    byId('save-recovery').disabled = true; setError('recovery-error');
    try {
      await api('recovery/enroll/' + (verifying ? 'confirm' : 'start'), {method: 'POST', body, signal: request.signal});
      if (request.signal.aborted || session !== current || !recoveryDialog.open) return;
      if (verifying) {
        recoveryDialog.close();
        notify('Gendannelsesmailen er bekræftet og gemt.');
      } else {
        enrollmentStep(true); recoveryCode.focus();
      }
    } catch (error) {
      if (!request.signal.aborted && session === current && recoveryDialog.open) setError('recovery-error', message(error));
    } finally {
      if (enrollmentRequest === request) {
        enrollmentRequest = null;
        recoveryEmail.readOnly = !byId('recovery-verification').hidden;
        byId('save-recovery').disabled = false;
      }
    }
  };
  byId('open-password').onclick = () => {
    account.open = false;
    passwordForm.reset(); setError('change-error');
    byId('password-account').value = session.email;
    byId('password-draft-note').hidden = !hasDraft();
    byId('repeat-password').removeAttribute('aria-invalid');
    passwordDialog.showModal(); byId('current-password').focus();
  };
  byId('cancel-password').onclick = () => passwordDialog.close();
  passwordDialog.oncancel = event => { if (byId('save-password').disabled) event.preventDefault(); };
  passwordDialog.onclose = () => {
    passwordForm.reset(); setError('change-error');
    if (session) byId('account-toggle').focus();
  };
  passwordForm.oninput = () => {
    byId('repeat-password').removeAttribute('aria-invalid');
    setError('change-error');
  };
  function returnToPasswordLogin(current, statusText) {
    if (session && session !== current) return;
    loggedOut();
    byId('email').value = current.email;
    setError('login-status', statusText);
    byId('password').focus();
  }
  passwordForm.onsubmit = async event => {
    event.preventDefault();
    const current = session;
    const repeat = byId('repeat-password');
    if (!current || byId('save-password').disabled) return;
    if (byId('new-password').value !== repeat.value) {
      setError('change-error', 'De nye adgangskoder er forskellige. Skriv den samme adgangskode i begge felter.');
      repeat.setAttribute('aria-invalid', 'true'); repeat.focus(); return;
    }
    if (hasDraft() && !confirm('Skift adgangskoden, og kassér din usendte kladde?')) return;
    const controls = Array.from(passwordForm.elements);
    controls.forEach(el => { el.disabled = true; });
    setError('change-error');
    try {
      const result = await api('password', {method: 'POST', body: {
        currentPassword: byId('current-password').value,
        newPassword: byId('new-password').value,
      }});
      if (!result.ok) throw new ApiError('Adgangskodeskiftet kunne ikke bekræftes.', 502);
      returnToPasswordLogin(current, 'Din adgangskode er ændret. Log ind med din nye adgangskode.');
    } catch (error) {
      if (error.status === 503 && error.loginRequired) {
        returnToPasswordLogin(current, error.message);
      } else if (session === current) {
        setError('change-error', error instanceof ApiError ? message(error) :
          'Forbindelsen blev afbrudt. Hvis du allerede er blevet logget ud, kan du prøve at logge ind med din nye adgangskode.');
      }
    } finally { controls.forEach(el => { el.disabled = false; }); }
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
  async function loadFolders(countsOnly = false) {
    folderRequest?.abort();
    const request = folderRequest = new AbortController();
    if (!countsOnly) listState('Henter mapper …');
    try {
      const result = await api('folders', {signal: request.signal});
      if (request.signal.aborted) return;
      const rank = f => Object.hasOwn(folderNames, f.role) ? Object.keys(folderNames).indexOf(f.role) : 99;
      folders = (result.folders || []).sort((a, b) => rank(a) - rank(b));
      const linkedFolder = pendingLink.get('folder'), linkedMessage = pendingLink.get('mail');
      if (linkedFolder && linkedMessage) {
        const linkedOwner = pendingLink.get('account');
        pendingLink = new URLSearchParams();
        const target = linkedOwner === session.email && folders.find(f => f.id === linkedFolder);
        if (target) {
          chooseFolder(target);
          openMail(linkedMessage);
          return;
        }
        notify('Mailen i linket tilhører en anden eller utilgængelig postkasse.');
      }
      const current = folders.find(f => f.id === folder?.id);
      if (current) {
        folder = current; drawFolders();
        if (!countsOnly) return loadList();
        return;
      }
      const first = folders.find(f => f.role === 'inbox') || folders[0];
      if (!first) { drawFolders(); return listState('Postkassen har ingen mapper.', loadFolders); }
      chooseFolder(first);
    } catch (error) {
      if (!request.signal.aborted && !countsOnly) listState(message(error), loadFolders);
    }
  }
  function chooseFolder(f) {
    clearTimeout(searchTimer);
    senderFilter = ''; availableLabels = [];
    folder = f; byId('search').value = ''; byId('folder-view').value = '';
    byId('label-filter').replaceChildren(); drawFilters();
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
  const categories = {primary: 'Primær', updates: 'Opdateringer', social: 'Sociale medier', promotions: 'Promoveringer'};
  function drawFilters(label = '') {
    const select = byId('label-filter');
    const values = [...new Set([...availableLabels, ...(label ? [label] : [])])];
    select.replaceChildren(new Option('Alle etiketter', ''), ...values.map(value => new Option(value, value)));
    select.value = label;
    byId('label-filter-wrap').hidden = !values.length;
    const inbox = folder?.role === 'inbox';
    byId('category-filters').disabled = byId('category-filters').hidden = !inbox;
    byId('snoozed-option').disabled = byId('snoozed-option').hidden = !inbox;
    const chip = byId('sender-filter');
    chip.hidden = !senderFilter;
    chip.textContent = 'Fra ' + senderFilter + ' ×';
    chip.setAttribute('aria-label', 'Fjern afsenderfilter for ' + senderFilter);
  }
  byId('label-filter').onchange = byId('folder-view').onchange = () => loadList();
  byId('sender-filter').onclick = () => {
    senderFilter = ''; drawFilters(byId('label-filter').value); loadList();
    byId('search').focus();
  };
  function labelChips(labels) {
    const group = node('span', 'mail-labels');
    for (const value of labels) group.append(node('span', 'mail-label', value));
    return group;
  }
  function messageRow(item) {
    const li = node('li');
    li.dataset.mail = item.id;
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
    if (item.labels?.length) b.append(labelChips(item.labels));
    if (item.unread) b.append(node('span', 'visually-hidden', 'Ulæst'));
    li.append(b, menuTrigger(item));
    return li;
  }
  function clearReader() {
    detailRequest?.abort();
    closeMenu(false); readerItem = null;
    selected = null; byId('workspace').dataset.reader = 'false';
    const empty = node('div', 'reader-empty');
    const mark = node('img'); mark.src = '/favicon.svg'; mark.alt = '';
    empty.append(mark, node('h2', '', 'Vælg en mail'));
    byId('paper').replaceChildren(empty);
    byId('reader').scrollTop = 0;
  }
  async function loadList(more = false, quietly = false) {
    if (!folder || (more && !cursor)) return;
    listRequest?.abort();
    const request = listRequest = new AbortController();
    const params = new URLSearchParams({folder: folder.id});
    const query = byId('search').value.trim();
    if (query) params.set('q', query);
    if (senderFilter) params.set('sender', senderFilter);
    const label = byId('label-filter').value;
    if (label) params.set('label', label);
    const view = byId('folder-view').value;
    if (view) params.set(Object.hasOwn(categories, view) ? 'category' : 'view', view);
    if (more) params.set('cursor', cursor);
    else if (!quietly) {
      listExtended = false;
      clearReader(); cursor = null; messages = [];
      byId('messages').replaceChildren(); byId('mail-count').textContent = ''; byId('list-scroll').scrollTop = 0;
    }
    if (!quietly) {
      byId('older').hidden = true;
      listState(more ? 'Henter ældre mails …' : 'Henter mails …');
    }
    try {
      const result = await api('messages?' + params, {signal: request.signal});
      if (request.signal.aborted) return;
      if (more) listExtended = true;
      availableLabels = result.availableLabels || [];
      drawFilters(label);
      if (quietly) { messages = []; byId('messages').replaceChildren(); }
      const seen = new Set(messages.map(item => item.id));
      const rows = [];
      for (const item of result.messages || []) {
        if (seen.has(item.id)) continue;
        seen.add(item.id); messages.push(item); rows.push(messageRow(item));
      }
      byId('messages').append(...rows);
      cursor = result.nextCursor || null;
      byId('mail-count').textContent = count.format(messages.length) + (cursor ? '+' : '') + (messages.length === 1 && !cursor ? ' mail' : ' mails');
      listState(messages.length ? '' : query || senderFilter || label || view ? 'Ingen mails matcher dit filter.' : 'Mappen er tom.');
      byId('older').hidden = !cursor;
    } catch (error) {
      if (!request.signal.aborted && !quietly) listState(message(error), () => loadList(more));
    } finally { if (listRequest === request) listRequest = null; }
  }
  byId('older').onclick = () => loadList(true);
  byId('refresh').onclick = () => loadFolders();
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
    return Array.from(byId('messages').querySelectorAll('.message-row')).find(row => row.dataset.id === String(id));
  }
  const menu = byId('mail-menu');
  let menuTarget = null, menuAnchor = null, menuPoint = null, submenu = false;
  let labelTarget, snoozeTarget, listExtended = false;
  function menuTrigger(item) {
    const button = node('button', 'icon-button more-actions');
    button.type = 'button';
    button.title = 'Flere handlinger';
    button.setAttribute('aria-label', 'Flere handlinger for ' + (item.subject || 'mail uden emne'));
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-controls', 'mail-menu');
    button.setAttribute('aria-expanded', 'false');
    button.append(icon('more'));
    button.onclick = () => openMenu(item, button);
    return button;
  }
  function closeMenu(restore = true) {
    if (menu.hidden) return;
    const original = menuAnchor;
    menu.hidden = true; menu.replaceChildren();
    original?.setAttribute('aria-expanded', 'false');
    menuTarget = menuAnchor = menuPoint = null;
    if (restore && original?.isConnected) original.focus({preventScroll: true});
  }
  function positionMenu() {
    if (menu.hidden || matchMedia('(max-width: 46rem)').matches) return;
    const rect = menuAnchor.getBoundingClientRect();
    const x = menuPoint?.x ?? rect.right - menu.offsetWidth;
    const y = menuPoint?.y ?? rect.bottom + 4;
    menu.style.left = Math.max(6, Math.min(x, document.documentElement.clientWidth - menu.offsetWidth - 6)) + 'px';
    menu.style.top = Math.max(6, Math.min(y, window.innerHeight - menu.offsetHeight - 6)) + 'px';
  }
  function openMenu(item, button, point = null) {
    closeMenu(false);
    if (!folder || !session) return;
    menuTarget = {item, source: folder, owner: session};
    menuAnchor = button; menuPoint = point;
    button.setAttribute('aria-expanded', 'true');
    menu.hidden = false; mainMenu();
  }
  function option(title, glyph, action, more = false) {
    const button = node('button', 'menu-option');
    button.type = 'button'; button.tabIndex = -1; button.setAttribute('role', 'menuitem');
    button.append(icon(glyph), node('span', '', title));
    if (more) {
      button.dataset.submenu = 'true';
      button.setAttribute('aria-haspopup', 'menu');
      button.append(icon('next'));
    }
    button.onclick = () => {
      const target = menuTarget;
      if (!more) closeMenu();
      try {
        Promise.resolve(action(target)).catch(error => { if (session === target.owner) notify(message(error)); });
      } catch (error) { if (session === target.owner) notify(message(error)); }
    };
    menu.append(button);
  }
  function section() {
    const line = node('hr'); line.setAttribute('role', 'separator'); menu.append(line);
  }
  function choices(title, fill) {
    submenu = true; menu.replaceChildren();
    option('Tilbage', 'back', mainMenu, true);
    menu.append(node('span', 'menu-heading', title));
    fill(); finishMenu();
  }
  function finishMenu() {
    menu.scrollTop = 0; positionMenu();
    menu.querySelector('button')?.focus({preventScroll: true});
  }
  function mainMenu() {
    submenu = false; menu.replaceChildren();
    const {item, source} = menuTarget;
    if (source.role === 'drafts') option('Rediger som ny mail', 'write', target => composeAction(target, 'copy'));
    option('Svar', 'reply', target => composeAction(target, 'reply'));
    option('Svar alle', 'replyAll', target => composeAction(target, 'replyAll'));
    option('Videresend', 'forward', target => composeAction(target, 'forward'));
    option('Videresend som vedhæftet fil', 'clip', target => composeAction(target, 'attachment'));
    section();
    if (source.role !== 'archive' && folders.some(f => f.role === 'archive'))
      option('Arkivér', 'archive', target => changeMail(target, {action: 'archive'}, 'Mailen er arkiveret.'));
    if (source.role !== 'trash' && folders.some(f => f.role === 'trash'))
      option('Slet', 'trash', target => changeMail(target, {action: 'trash'}, 'Mailen er flyttet til papirkurven.'));
    option(item.unread ? 'Markér som læst' : 'Markér som ulæst', 'mail', target => changeMail(target,
      {action: item.unread ? 'read' : 'unread'}, item.unread ? 'Markeret som læst.' : 'Markeret som ulæst.'));
    if (source.role === 'inbox') {
      if (byId('folder-view').value === 'snoozed' || item.snoozedUntil) option('Flyt tilbage til indbakken nu', 'inbox',
        target => updateMessage(target, 'snooze', {until: null}, 'Mailen er tilbage i indbakken.'));
      else option('Udsæt', 'clock', openSnooze);
    }
    option(item.task ? 'Fjern fra huskeliste' : 'Føj til huskeliste', 'check', target => changeMail(target,
      {action: item.task ? 'untask' : 'task'}, item.task ? 'Fjernet fra huskelisten.' : 'Føjet til huskelisten.'));
    section();
    if (folders.some(f => f.id !== source.id)) option('Flyt til mappe', 'other', () => choices('Flyt til mappe', () => {
      for (const dest of folders.filter(f => f.id !== source.id))
        option(nameOf(dest), dest.role, target => changeMail(target, {action: 'move', target: dest.id}, 'Flyttet til ' + nameOf(dest) + '.'));
    }), true);
    if (source.role === 'inbox') option('Flyt til fane', 'inbox', () => choices('Flyt til fane', () => {
      for (const [category, name] of Object.entries(categories))
        option(name, (item.category || 'primary') === category ? 'check' : 'inbox', target => changeMail(target, {action: 'category', category}, 'Flyttet til ' + name + '.'));
    }), true);
    option('Etiketter', 'tag', () => choices('Etiketter', () => {
      option('Ny etiket', 'plus', openLabel);
      for (const label of new Set([...availableLabels, ...(item.labels || [])])) {
        const present = item.labels?.includes(label);
        option((present ? 'Fjern ' : 'Tilføj ') + label, present ? 'check' : 'tag', target => changeMail(target,
          {action: present ? 'unlabel' : 'label', label}, present ? 'Etiketten er fjernet.' : 'Etiketten er tilføjet.'));
      }
    }), true);
    if (source.role === 'inbox' || item.muted)
      option(item.muted ? 'Vis mail i indbakken igen' : 'Skjul mail i indbakken', 'mail', target => changeMail(target,
        {action: item.muted ? 'unmute' : 'mute'}, item.muted ? 'Mailen vises igen.' : 'Mailen er skjult i indbakken.'));
    section();
    const sender = item.senderAddress || person(item.from).address;
    if (sender) option('Find mails fra ' + sender, 'search', () => {
      senderFilter = sender; byId('search').value = ''; byId('folder-view').value = '';
      drawFilters(); loadList(); byId('search').focus();
    });
    option('Åbn i et nyt vindue', 'external', () => {
      const url = new URL('/', location.origin);
      url.hash = new URLSearchParams({account: session.email, folder: source.id, mail: item.id}).toString();
      window.open(url.href, '_blank', 'noopener,noreferrer');
    });
    finishMenu();
  }
  menu.onkeydown = event => {
    const items = [...menu.querySelectorAll('button')], pos = items.indexOf(document.activeElement);
    if (event.key === 'Escape' || event.key === 'ArrowLeft') {
      event.preventDefault(); if (submenu) mainMenu(); else closeMenu();
    } else if (event.key === 'Tab') closeMenu();
    else if (event.key === 'ArrowRight' && document.activeElement?.dataset.submenu) {
      event.preventDefault(); document.activeElement.click();
    } else {
      const next = {ArrowDown: (pos + 1) % items.length, ArrowUp: (pos + items.length - 1) % items.length, Home: 0, End: items.length - 1};
      if (Object.hasOwn(next, event.key)) { event.preventDefault(); items[next[event.key]].focus(); }
    }
  };
  function contextMenu(event) {
    const row = event.target.closest('li[data-mail]');
    const article = event.target.closest('#reader')?.querySelector('.letter');
    if (!row && !article || event.target.closest('a,input,textarea') || window.getSelection()?.toString()) return;
    const item = row ? messages.find(m => String(m.id) === row.dataset.mail) : readerItem;
    if (!item) return;
    event.preventDefault();
    const point = event.type === 'contextmenu' && (event.clientX || event.clientY) ? {x: event.clientX, y: event.clientY} : null;
    openMenu(item, (row || article).querySelector('.more-actions'), point);
  }
  byId('workspace').oncontextmenu = contextMenu;
  byId('workspace').addEventListener('keydown', event => {
    if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') contextMenu(event);
  });
  document.addEventListener('pointerdown', event => {
    if (!menu.hidden && !menu.contains(event.target) && !menuAnchor?.contains(event.target)) closeMenu(false);
  });
  document.addEventListener('focusin', event => {
    if (!menu.hidden && !menu.contains(event.target) && event.target !== menuAnchor) closeMenu(false);
  });
  window.addEventListener('resize', positionMenu);
  function changeMail(target, body, notice) { return updateMessage(target, 'action', body, notice); }
  function reflectChange(item, body, endpoint) {
    const {action, label} = body;
    const view = byId('folder-view').value;
    const stored = messages.find(m => m.id === item.id) || item;
    const changes = {};
    if (action === 'read' || action === 'unread') changes.unread = action === 'unread';
    if (action === 'task' || action === 'untask') changes.task = action === 'task';
    if (action === 'mute' || action === 'unmute') changes.muted = action === 'mute';
    if (action === 'category') changes.category = body.category;
    if (action === 'label' || action === 'unlabel') {
      const labels = new Set(stored.labels);
      if (action === 'label') { labels.add(label); availableLabels = [...new Set([...availableLabels, label])]; }
      else labels.delete(label);
      changes.labels = [...labels]; drawFilters(byId('label-filter').value);
    }
    Object.assign(stored, changes);
    const remove = endpoint === 'snooze' || ['archive', 'trash', 'move'].includes(action) ||
      action === 'category' && Object.hasOwn(categories, view) && body.category !== view ||
      action === 'untask' && view === 'tasks' || action === 'unmute' && view === 'muted' ||
      action === 'mute' && (!view || Object.hasOwn(categories, view)) && folder.role === 'inbox' ||
      action === 'unlabel' && byId('label-filter').value === label;
    const row = rowFor(item.id)?.closest('li');
    const focusInRow = row?.contains(document.activeElement);
    if (selected === item.id) {
      if (remove || action === 'unread') clearReader();
      else if (readerItem) { Object.assign(readerItem, changes); renderMail(readerItem, false); }
    }
    if (remove) {
      const next = row?.nextElementSibling || row?.previousElementSibling;
      messages = messages.filter(m => m.id !== item.id);
      row?.remove();
      if (focusInRow) (next?.querySelector('.message-row') || byId('folder-title')).focus({preventScroll: true});
      if (!messages.length && cursor) { loadList(true); return; }
      if (!messages.length) listState('Ingen mails i denne visning.');
      byId('mail-count').textContent = count.format(messages.length) + (cursor ? '+' : '') + (messages.length === 1 && !cursor ? ' mail' : ' mails');
    } else if (row) {
      const updated = messageRow(stored); row.replaceWith(updated);
      if (focusInRow) updated.querySelector('.more-actions').focus({preventScroll: true});
    }
  }
  const changing = new Set();
  async function updateMessage(target, endpoint, body, notice) {
    const {source, item, owner} = target;
    const key = JSON.stringify([owner.csrfToken, source.id, item.id]);
    if (session !== owner || changing.has(key)) return;
    changing.add(key);
    try {
      await api('messages/' + encodeURIComponent(item.id) + '/' + endpoint + '?' + new URLSearchParams({folder: source.id}), {method: 'POST', body});
      if (session !== owner) return;
      notify(notice);
      if (folder?.id === source.id) {
        reflectChange(item, body, endpoint);
        if (['read', 'unread', 'archive', 'trash', 'move'].includes(body.action)) loadFolders(true);
      }
    } finally { changing.delete(key); }
  }
  function openLabel(target) {
    labelTarget = target; byId('label-form').reset(); setError('label-error');
    byId('label-dialog').showModal(); byId('new-label').focus();
  }
  function openSnooze(target) {
    snoozeTarget = target; setError('snooze-error');
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
    const local = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60000);
    byId('snooze-until').value = local.toISOString().slice(0, 16);
    byId('snooze-dialog').showModal(); byId('snooze-until').focus();
  }
  function setupActionForm(name, run) {
    const dialog = byId(name + '-dialog'), submit = byId('save-' + name);
    byId('cancel-' + name).onclick = () => dialog.close();
    byId(name + '-form').onsubmit = async event => {
      event.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true; setError(name + '-error');
      try { await run(); if (dialog.open) dialog.close(); }
      catch (error) { if (dialog.open) setError(name + '-error', message(error)); }
      finally { submit.disabled = false; }
    };
  }
  setupActionForm('label', () => {
    const label = byId('new-label').value.trim();
    if (!label) throw new ApiError('Skriv et navn på etiketten.', 400);
    return changeMail(labelTarget, {action: 'label', label}, 'Etiketten er tilføjet.');
  });
  setupActionForm('snooze', () => {
    const until = new Date(byId('snooze-until').value);
    if (!(until.getTime() > Date.now())) throw new ApiError('Vælg et tidspunkt i fremtiden.', 400);
    return updateMessage(snoozeTarget, 'snooze', {until: until.toISOString()}, 'Udsat til ' + dateTime.format(until) + '.');
  });
  function refreshInbox() {
    if (document.hidden || !session || folder?.role !== 'inbox' || listExtended || listRequest || !menu.hidden ||
        document.querySelector('dialog[open]') || byId('messages').contains(document.activeElement)) return;
    loadList(false, true);
  }
  window.addEventListener('focus', refreshInbox);
  window.setInterval(refreshInbox, 60000);
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
  const scanLabels = {
    unknown: 'Ingen scanningsstatus for denne mail',
    clean: 'Scannet · Ingen kendte tegn på svindel',
    suspicious: 'Mulig svindel',
    dangerous: 'Advarsel · Farlig mail',
  };
  let activeMailFrame = null;
  window.addEventListener('message', event => {
    const current = activeMailFrame;
    if (!current || !current.frame.isConnected || event.source !== current.frame.contentWindow ||
        event.data?.token !== current.token) return;
    if (event.data.type === 'veyro-mail-contextmenu') {
      const anchor = current.frame.closest('.letter')?.querySelector('.more-actions');
      if (!readerItem || !anchor) return;
      const {x, y} = event.data;
      let point = null;
      if (x !== null || y !== null) {
        if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) ||
            x < 0 || y < 0 || x > current.frame.clientWidth || y > current.frame.clientHeight) return;
        const rect = current.frame.getBoundingClientRect();
        point = {x: rect.left + x, y: rect.top + y};
      }
      openMenu(readerItem, anchor, point);
      return;
    }
    if (event.data.type !== 'veyro-mail-size') return;
    const height = event.data.height;
    if (typeof height !== 'number' || !Number.isFinite(height)) return;
    // Very long messages retain their own scroll area instead of making the app unusable.
    current.frame.style.height = Math.max(80, Math.min(16000, Math.ceil(height))) + 'px';
    current.frame.removeAttribute('aria-busy');
  });

  function mailLinkUrl(value) {
    if (!value || value.length > 8192 || /[\s\\\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)) return null;
    try {
      const url = new URL(value);
      if (/^https?:\/\/[^/\\]/i.test(value) && url.hostname && !url.username && !url.password) return url;
      if (url.protocol === 'mailto:' && /^[^@/?#%\\,;:\s]+@[^@/?#%\\,;:\s]+$/u.test(url.pathname) &&
          !url.hash && !/%(?:00|0a|0d)/i.test(value) && [...url.searchParams.keys()].every(key => /^(?:subject|body)$/i.test(key))) return url;
    } catch { /* An incomplete or unsupported address stays readable as text. */ }
    return null;
  }

  function appendMailLink(parent, value, label, status) {
    const url = mailLinkUrl(value);
    if (!url) { parent.append(label); return; }
    const destination = url.host || url.pathname;
    const caption = label || destination;
    if (status === 'dangerous') {
      parent.append(caption);
    } else {
      const anchor = node('a', 'body-link', caption);
      anchor.href = url.href;
      if (url.protocol !== 'mailto:') anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.referrerPolicy = 'no-referrer';
      parent.append(anchor);
    }
    // Show where a labelled link leads, even when its text resembles another site's address.
    const displayed = mailLinkUrl(caption);
    if ((displayed?.href !== url.href && caption !== destination) || status === 'suspicious' ||
        status === 'dangerous' || url.hostname.includes('xn--')) {
      parent.append(node('span', 'link-destination', ' (' + destination + ')'));
    }
  }

  function trimMailUrl(value) {
    let end = value.length;
    while (end && '.,!?:;'.includes(value[end - 1])) end--;
    const pairs = {')': '(', ']': '[', '}': '{'};
    const balance = {')': 0, ']': 0, '}': 0};
    for (const char of value.slice(0, end)) {
      if (Object.hasOwn(pairs, char)) balance[char]++;
      else if (char === '(') balance[')']--;
      else if (char === '[') balance[']']--;
      else if (char === '{') balance['}']--;
    }
    while (end && balance[value[end - 1]] > 0) {
      balance[value[end - 1]]--;
      end--;
    }
    return value.slice(0, end);
  }

  function appendMailText(parent, text, status) {
    const links = /(^|[\s([{<"'«“])((?:https?:\/\/|mailto:)[^\s<>"'»”]+)/giu;
    let offset = 0;
    for (const match of text.matchAll(links)) {
      const start = match.index + match[1].length;
      const value = trimMailUrl(match[2]);
      parent.append(text.slice(offset, start));
      appendMailLink(parent, value, value, status);
      offset = start + value.length;
    }
    parent.append(text.slice(offset));
  }

  function messageBody(item, status) {
    const body = node('div', 'letter-body');
    activeMailFrame = null;
    if (typeof item.html === 'string' && item.html && status !== 'dangerous') {
      body.classList.add('letter-rich');
      const tools = node('div', 'mail-view-tools');
      const remote = item.has_external_images === true || /data-veyro-src\s*=|<img\b[^>]*\bsrc\s*=\s*["']?https?:/i.test(item.html);
      const imageNote = node('span', 'mail-image-note', 'Eksterne billeder er skjult.');
      const showImages = node('button', 'secondary', 'Vis billeder'); showImages.type = 'button';
      const toggle = node('button', 'text-button', 'Vis som tekst'); toggle.type = 'button';
      let images = false, textOnly = false;
      const content = node('div', 'mail-view-content');
      function showFrame() {
        const frame = node('iframe', 'mail-frame');
        const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
        frame.title = 'Mailens indhold';
        frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
        frame.referrerPolicy = 'no-referrer';
        frame.setAttribute('aria-busy', 'true');
        frame.src = '/message-frame' + (images ? '?images=1' : '');
        frame.addEventListener('load', () => {
          if (activeMailFrame?.frame !== frame || !frame.isConnected) return;
          // The sandbox intentionally has an opaque origin. Only this frame receives the content.
          frame.contentWindow.postMessage({type:'veyro-mail-init', token, html:item.html, images}, '*');
        }, {once:true});
        activeMailFrame = {frame, token};
        content.replaceChildren(frame);
      }
      if (remote) {
        tools.append(imageNote, showImages);
        showImages.onclick = () => {
          images = true;
          imageNote.textContent = 'Billeder vises i denne mail.';
          showImages.remove();
          if (!textOnly) showFrame();
        };
      }
      toggle.onclick = () => {
        textOnly = !textOnly; toggle.textContent = textOnly ? 'Vis original opsætning' : 'Vis som tekst';
        if (textOnly) {
          activeMailFrame = null;
          const plain = node('div', 'mail-plain');
          appendMailText(plain, item.text || '', status); content.replaceChildren(plain);
        } else showFrame();
      };
      tools.append(toggle); body.append(tools, content); showFrame();
      return body;
    }
    appendMailText(body, typeof item.text === 'string' ? item.text : '', status);
    return body;
  }

  function scanNotice(security, status) {
    const notice = node('div', 'mail-scan ' + status);
    notice.append(node('strong', '', scanLabels[status]));
    if (status !== 'clean' && Array.isArray(security?.reasons)) {
      const reasons = security.reasons.filter(reason => typeof reason === 'string' && reason.trim());
      if (reasons.length) notice.append(node('p', '', reasons.join(' ')));
    }
    if (status === 'dangerous') notice.append(node('p', '', 'Links i denne mail vises som tekst.'));
    return notice;
  }

  function renderMail(item, focus = true) {
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
    const head = node('div', 'letter-head');
    head.append(title, menuTrigger(item));
    area.append(avatar, detail); article.append(head, area);
    if (item.labels?.length) article.append(labelChips(item.labels));
    const stamp = dateValue(item.date, true);
    if (stamp) article.append(node('time', 'letter-date', stamp));
    const scanStatus = Object.hasOwn(scanLabels, item.security?.status) ? item.security.status : 'unknown';
    article.append(scanNotice(item.security, scanStatus), messageBody(item, scanStatus));
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
    const actions = node('div', 'letter-actions');
    const target = {item, source: folder, owner: session};
    const quick = folder.role === 'drafts' ? [['copy', 'write', 'Rediger som ny mail']] :
      [['reply', 'reply', 'Svar'], ['forward', 'forward', 'Videresend']];
    for (const [kind, glyph, text] of quick) {
      const button = node('button', 'secondary');
      button.type = 'button'; button.append(icon(glyph), document.createTextNode(text));
      button.onclick = () => composeAction(target, kind).catch(error => { if (session === target.owner) notify(message(error)); });
      actions.append(button);
    }
    article.append(actions);
    byId('paper').replaceChildren(article);
    if (focus) title.focus({preventScroll: true});
  }
  async function openMail(id) {
    detailRequest?.abort();
    const request = detailRequest = new AbortController();
    readerItem = null;
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
      readerItem = item; renderMail(item);
    } catch (error) {
      if (request.signal.aborted) return;
      const text = node('p', 'reader-error', message(error)); text.setAttribute('role', 'alert');
      const retry = node('button', 'secondary', 'Prøv igen'); retry.type = 'button'; retry.onclick = () => openMail(id);
      byId('paper').replaceChildren(text, retry);
    }
  }
  function hasDraft() {
    return Boolean(reply || byId('recipient').value || byId('cc').value || byId('subject').value || byId('body').value);
  }
  async function composeAction(target, kind) {
    const {source, owner} = target;
    let {item} = target;
    if (kind === 'forward' || kind === 'copy') {
      if (typeof item.text !== 'string') {
        await openMail(item.id);
        if (session !== owner || folder?.id !== source.id || readerItem?.id !== item.id) return;
        item = readerItem;
      }
    }
    const replyTo = item.replyAddresses?.join(', ') || (source.role === 'sent' ? item.to : item.replyTo || item.from) || '';
    const subject = item.subject || '';
    const draft = {kind, id: item.id, folder: source.id, to: '', cc: '', subject, text: '', files: false};
    if (kind === 'copy') {
      draft.to = item.to || ''; draft.cc = item.cc || ''; draft.text = item.text || '';
      draft.files = Boolean(item.attachments?.length);
    } else if (kind === 'reply' || kind === 'replyAll') {
      draft.to = kind === 'replyAll' ? item.replyAllTo?.join(', ') || replyTo : replyTo;
      if (kind === 'replyAll') draft.cc = item.replyAllCc?.join(', ') || '';
      if (!/^(re|sv):/i.test(subject)) draft.subject = 'Re: ' + subject;
    } else {
      if (!/^(fw|fwd|vs):/i.test(subject)) draft.subject = 'Fwd: ' + subject;
      if (kind === 'forward') {
        draft.text = ['', '', '---------- Videresendt mail ----------', 'Fra: ' + (item.from || ''),
          'Dato: ' + dateValue(item.date, true), 'Emne: ' + subject, 'Til: ' + (item.to || ''),
          ...(item.cc ? ['Cc: ' + item.cc] : []), '', item.text || ''].join('\n');
        draft.files = Boolean(item.attachments?.length);
      }
    }
    openCompose(draft);
  }
  function openCompose(target) {
    if (target && (target.id !== reply?.id || target.folder !== reply?.folder || target.kind !== reply?.kind)) {
      if (hasDraft() && !confirm('Kassér den åbne kladde og begynd på denne mail?')) return;
      resetDraft(); reply = target;
      byId('recipient').value = target.to;
      byId('cc').value = target.cc;
      byId('subject').value = target.subject;
      byId('body').value = target.text;
      byId('body').required = target.kind !== 'attachment';
      const note = byId('forward-files');
      note.hidden = target.kind !== 'attachment' && !target.files;
      note.textContent = target.kind === 'attachment' ? 'Vedhæftet: Original mail (.eml)' : 'De oprindelige vedhæftede filer følger med.';
    }
    const titles = {reply: 'Svar på mail', replyAll: 'Svar alle', forward: 'Videresend mail', attachment: 'Videresend som vedhæftet fil', copy: 'Rediger som ny mail'};
    byId('compose-title').textContent = reply ? titles[reply.kind] : 'Ny mail';
    byId('composer').showModal();
    (byId('recipient').value ? byId('body') : byId('recipient')).focus();
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
    const cc = byId('cc').value.trim();
    if (cc) input.cc = cc;
    if (reply?.kind === 'reply' || reply?.kind === 'replyAll') { input.replyToId = reply.id; input.replyToFolder = reply.folder; }
    if (reply?.kind === 'attachment') input.forwardAttachment = {id: reply.id, folder: reply.folder};
    if (reply?.files) input.forwardFiles = {id: reply.id, folder: reply.folder};
    if (!input.to || !input.text.trim() && !input.forwardAttachment) return setError('send-error', 'Udfyld modtager og besked.');
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
