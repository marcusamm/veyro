'use strict';
const api = window.veyroDesktop;
const $ = (id) => document.getElementById(id);
let current, mode = 'add', editingId, previousFocus, googlePending = false, loginAttempt = 0;
async function invoke(action, payload) {
  try { return await api.invoke(action, payload); }
  catch (error) { throw new Error(error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')); }
}
function render(state) {
  current = state;
  $('accounts').replaceChildren(...state.accounts.map((account) => {
    const button = document.createElement('button');
    button.className = 'account-button';
    button.dataset.kind = account.kind;
    button.title = `${account.label} · ${account.kind === 'veyro' ? 'Veyro-firmakonto' : 'Mailkonto'}`;
    button.setAttribute('aria-label', `Skift til ${account.label}`);
    button.setAttribute('aria-current', String(account.id === state.activeId));
    button.textContent = account.label.split(/\s+/).map((word) => Array.from(word)[0]).slice(0, 2).join('').toUpperCase();
    const dot = document.createElement('span'); dot.className = 'type-dot'; dot.setAttribute('aria-hidden', 'true'); button.append(dot);
    button.addEventListener('click', () => invoke('switch', {id: account.id}).catch(showError));
    return button;
  }));
  for (const button of document.querySelectorAll('[data-section]')) {
    button.setAttribute('aria-current', button.dataset.section === state.section ? 'page' : 'false');
    button.disabled = !state.activeId;
  }
  $('manage').disabled = !state.activeId;
  $('status').hidden = state.status === 'ready';
  $('retry').hidden = state.status !== 'offline';
  $('first-account').hidden = state.status !== 'empty';
  $('welcome-google').hidden = state.status !== 'empty';
  $('welcome-google').disabled = !state.oauth?.google?.available || googlePending || state.googleConnecting;
  $('status-title').textContent = state.status === 'offline' ? 'Vi mistede forbindelsen.' : state.status === 'empty' ? 'Din mail. Dit overblik.' : 'Et øjeblik…';
  $('status-copy').textContent = state.status === 'offline' ? 'Kontrollér din internetforbindelse, og prøv igen. Dine konti er stadig gemt på computeren.' : state.status === 'empty' ? (state.oauth?.google?.available ? 'Log ind med Google, og brug din Gmail i Veyro Mail. Dit navn og din mailadresse bliver udfyldt automatisk.' : 'Tilføj din mailkonto for at komme i gang. Google-login er ikke tilgængeligt i denne udgave.') : 'Forbinder til din konto…';
  renderGoogle();
  if (state.toast) { $('toast-text').textContent = state.toast; $('toast').hidden = false; }
  else $('toast').hidden = true;
}
function showError(error) { $('toast-text').textContent = error.message; $('toast').hidden = false; }
function renderGoogle() {
  const busy = googlePending || current?.googleConnecting;
  const available = current?.oauth?.google?.available === true;
  $('google-login').disabled = busy || !available;
  $('google-label').textContent = busy ? 'Venter på Google…' : 'Log ind med Google';
  $('google-copy').textContent = busy ? 'Fortsæt i browseren. Kontoen bliver tilføjet, når du har godkendt forbindelsen.' : available ? 'Vælg din konto hos Google, og godkend forbindelsen. Så er din konto klar her.' : 'Google-login er ikke tilgængeligt i denne udgave. Du kan stadig tilføje en anden mailkonto.';
  $('google-cancel').hidden = !busy;
  $('other-services').disabled = !!busy;
  $('save').disabled = !!busy;
}
function revealOtherServices() {
  $('manual-account').hidden = false;
  $('dialog-actions').hidden = false;
  $('other-services').setAttribute('aria-expanded', 'true');
  $('kind-field').querySelector('input:checked').focus();
}
async function openDialog(nextMode) {
  previousFocus = document.activeElement;
  mode = nextMode;
  const account = current.accounts.find((item) => item.id === current.activeId);
  editingId = account?.id;
  $('label').value = mode === 'edit' ? account.label : '';
  $('label').required = mode === 'edit';
  $('label-optional').hidden = mode === 'edit';
  $('manual-account').hidden = mode !== 'edit';
  $('dialog-actions').hidden = mode !== 'edit';
  $('google-setup').hidden = mode === 'edit';
  $('other-services').setAttribute('aria-expanded', 'false');
  $('kind-field').hidden = mode === 'edit';
  $('remove').hidden = mode !== 'edit';
  $('dialog-title').textContent = mode === 'edit' ? 'Din konto.' : 'Tilføj en konto.';
  $('dialog-copy').textContent = mode === 'edit' ? 'Et genkendeligt navn gør det nemt at finde den rigtige konto.' : 'Brug din Gmail i Veyro Mail. Vi henter dit navn og din mailadresse, når du logger ind.';
  $('save').textContent = mode === 'edit' ? 'Gem navn' : 'Fortsæt';
  $('form-error').textContent = '';
  renderGoogle();
  await invoke('dialog', {open: true});
  if (!$('account-dialog').open) $('account-dialog').showModal();
  (mode === 'edit' ? $('label') : $('google-login').disabled ? $('other-services') : $('google-login')).focus();
}
async function closeDialog() {
  if (googlePending || current?.googleConnecting) {
    loginAttempt++;
    await invoke('cancelGoogle');
    googlePending = false;
  }
  $('account-dialog').close();
  await invoke('dialog', {open: false});
  previousFocus?.focus();
}
async function loginWithGoogle() {
  if (googlePending || current?.googleConnecting || !current?.oauth?.google?.available) return;
  if (!$('account-dialog').open) await openDialog('add');
  if (googlePending || current?.googleConnecting || !current?.oauth?.google?.available) return;
  const attempt = ++loginAttempt;
  googlePending = true; $('form-error').textContent = ''; renderGoogle();
  try {
    const state = await invoke('addGoogle');
    if (attempt !== loginAttempt) return;
    googlePending = false; render(state);
    await closeDialog();
  } catch (error) {
    if (attempt === loginAttempt && $('account-dialog').open) $('form-error').textContent = error.message;
  } finally {
    if (attempt === loginAttempt) { googlePending = false; renderGoogle(); }
  }
}
$('add').addEventListener('click', () => openDialog('add').catch(showError));
$('first-account').addEventListener('click', () => openDialog('add').then(revealOtherServices).catch(showError));
$('welcome-google').addEventListener('click', () => loginWithGoogle().catch(showError));
$('google-login').addEventListener('click', () => loginWithGoogle().catch(showError));
$('other-services').addEventListener('click', revealOtherServices);
$('google-cancel').addEventListener('click', async () => {
  loginAttempt++;
  try { const state = await invoke('cancelGoogle'); googlePending = false; render(state); $('google-login').focus(); }
  catch (error) { $('form-error').textContent = error.message; }
});
$('manage').addEventListener('click', () => openDialog('edit').catch(showError));
$('close-dialog').addEventListener('click', () => closeDialog().catch(showError));
$('account-dialog').addEventListener('cancel', (event) => { event.preventDefault(); void closeDialog(); });
$('account-form').addEventListener('submit', async (event) => {
  event.preventDefault(); $('save').disabled = true; $('form-error').textContent = '';
  try {
    if (googlePending || current?.googleConnecting) return;
    if (mode === 'add' && $('manual-account').hidden) { await loginWithGoogle(); return; }
    const kind = new FormData(event.target).get('kind');
    const payload = {label: $('label').value.trim() || (kind === 'veyro' ? 'Min Veyro' : 'Min mail'), kind, id: editingId};
    await invoke(mode === 'edit' ? 'rename' : 'add', payload);
    await closeDialog();
  } catch (error) { $('form-error').textContent = error.message; }
  finally { $('save').disabled = false; }
});
$('remove').addEventListener('click', async () => {
  $('remove').disabled = true;
  try { const state = await invoke('remove', {id: editingId}); if (!state.accounts.some((item) => item.id === editingId)) await closeDialog(); }
  catch (error) { $('form-error').textContent = error.message; }
  finally { $('remove').disabled = false; }
});
for (const button of document.querySelectorAll('[data-section]')) button.addEventListener('click', () => invoke('section', {section: button.dataset.section}).catch(showError));
$('retry').addEventListener('click', () => invoke('retry').catch(showError));
$('dismiss-toast').addEventListener('click', () => { $('toast').hidden = true; void invoke('dismiss'); });
api.onState(render);
api.onAdd(() => void openDialog('add'));
void invoke('state').then(render).catch(showError);
