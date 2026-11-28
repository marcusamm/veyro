'use strict';
const api = window.veyroDesktop;
const $ = (id) => document.getElementById(id);
let current, mode = 'add', editingId, previousFocus;
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
    button.title = `${account.label} · ${account.kind === 'veyro' ? 'Veyro' : 'IMAP'}`;
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
  $('status-title').textContent = state.status === 'offline' ? 'Vi mistede forbindelsen.' : state.status === 'empty' ? 'Din mail. Dit overblik.' : 'Et øjeblik…';
  $('status-copy').textContent = state.status === 'offline' ? 'Kontrollér din internetforbindelse, og prøv igen. Dine konti er stadig gemt på computeren.' : state.status === 'empty' ? 'Tilføj en Veyro-konto eller forbind din egen mailtjeneste for at komme i gang.' : 'Forbinder til din konto…';
  if (state.toast) { $('toast-text').textContent = state.toast; $('toast').hidden = false; }
  else $('toast').hidden = true;
}
function showError(error) { $('toast-text').textContent = error.message; $('toast').hidden = false; }
async function openDialog(nextMode) {
  previousFocus = document.activeElement;
  mode = nextMode;
  const account = current.accounts.find((item) => item.id === current.activeId);
  editingId = account?.id;
  $('label').value = mode === 'edit' ? account.label : '';
  $('kind-field').hidden = mode === 'edit';
  $('remove').hidden = mode !== 'edit';
  $('dialog-title').textContent = mode === 'edit' ? 'Din konto.' : 'Tilføj en konto.';
  $('dialog-copy').textContent = mode === 'edit' ? 'Et genkendeligt navn gør det nemt at finde den rigtige konto.' : 'Skift mellem dine mailkonti med et enkelt klik.';
  $('save').textContent = mode === 'edit' ? 'Gem navn' : 'Tilføj konto';
  $('form-error').textContent = '';
  await invoke('dialog', {open: true});
  if (!$('account-dialog').open) $('account-dialog').showModal();
  $('label').focus();
}
async function closeDialog() {
  $('account-dialog').close();
  await invoke('dialog', {open: false});
  previousFocus?.focus();
}
$('add').addEventListener('click', () => openDialog('add').catch(showError));
$('first-account').addEventListener('click', () => openDialog('add').catch(showError));
$('manage').addEventListener('click', () => openDialog('edit').catch(showError));
$('close-dialog').addEventListener('click', () => closeDialog().catch(showError));
$('account-dialog').addEventListener('cancel', (event) => { event.preventDefault(); void closeDialog(); });
$('account-form').addEventListener('submit', async (event) => {
  event.preventDefault(); $('save').disabled = true; $('form-error').textContent = '';
  try {
    const payload = {label: $('label').value, kind: new FormData(event.target).get('kind'), id: editingId};
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
