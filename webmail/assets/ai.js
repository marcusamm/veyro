'use strict';
const byId = id => document.getElementById(id);
const consentMode = location.pathname === '/ai/authorize';
const params = Object.fromEntries(new URLSearchParams(location.search));
let csrf = '';

async function api(path, data) {
  const response = await fetch(path, data === undefined ? {cache:'no-store'} : {
    method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},
    body:JSON.stringify(data), cache:'no-store',
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(value.error || 'Forbindelsen mislykkedes. Prøv igen.');
    error.status = response.status;
    throw error;
  }
  return value;
}

async function load() {
  for (const id of ['links','login','consent']) byId(id).hidden = true;
  byId('notice').textContent = '';
  if (consentMode) document.title = byId('title').textContent = 'Giv adgang til Veyro Mail';
  try {
    const session = await api('/api/session');
    csrf = session.csrfToken;
    byId('status').textContent = session.email;
    if (consentMode) {
      const info = await api('/api/ai/authorize', {action:'review',params});
      byId('requester').textContent = info.provider + ' anmoder om adgang til ' + info.email + '.';
      byId('callback').textContent = 'Efter dit valg vender du tilbage til ' + info.callback;
      byId('read-row').hidden = !info.scopes.includes('mail.read');
      byId('draft-row').hidden = !info.scopes.includes('mail.draft');
      byId('mail-read').checked = info.scopes.includes('mail.read');
      byId('mail-draft').checked = false;
      byId('consent').hidden = false;
      return;
    }
    const {connections} = await api('/api/ai/connections');
    const list = byId('connections');
    list.replaceChildren();
    if (!connections.length) list.textContent = 'Du har ingen aktive forbindelser.';
    for (const connection of connections) {
      const item = document.createElement('div');
      item.className = 'connected';
      const meta = document.createElement('span');
      const name = document.createElement('b');
      name.textContent = connection.provider;
      const desc = document.createElement('small');
      const permissions = connection.scopes.map(s => s === 'mail.draft' ? 'gem kladder' : 'læs indbakken');
      const until = new Date(connection.expires * 1000).toLocaleString('da-DK',{hour:'2-digit',minute:'2-digit',day:'numeric',month:'short'});
      desc.textContent = permissions.join(' · ') + ' · udløber ' + until;
      const button = document.createElement('button');
      button.textContent = 'Afbryd';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try { await api('/api/ai/revoke', {id:connection.id}); await load(); }
        catch (err) { byId('notice').textContent = err.message; button.disabled = false; }
      });
      meta.append(name,desc); item.append(meta,button); list.append(item);
    }
    byId('links').hidden = false;
  } catch (err) {
    if (err.status === 401) {
      byId('status').textContent = 'Log ind for at fortsætte.';
      byId('login').hidden = false;
    } else {
      byId('status').textContent = consentMode ? 'Forbindelsen kunne ikke godkendes. Start igen fra din AI-tjeneste.' : err.message;
    }
  }
}

async function decide(action) {
  const scopes = [];
  if (byId('mail-read').checked) scopes.push('mail.read');
  if (byId('mail-draft').checked) scopes.push('mail.draft');
  if (action === 'allow' && !scopes.length) {
    byId('notice').textContent = 'Vælg mindst én tilladelse eller tryk Afvis.';
    return;
  }
  byId('allow').disabled = byId('deny').disabled = true;
  try {
    const {redirect} = await api('/api/ai/authorize', {action,params,scopes});
    location.replace(redirect);
  } catch (err) {
    byId('notice').textContent = err.message;
    byId('allow').disabled = byId('deny').disabled = false;
  }
}
byId('retry').addEventListener('click', load);
byId('allow').addEventListener('click', () => decide('allow'));
byId('deny').addEventListener('click', () => decide('deny'));
byId('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText('https://mail.veyro.dk/mcp'); byId('notice').textContent = 'Serveradressen er kopieret.'; }
  catch { byId('notice').textContent = 'Markér serveradressen ovenfor og kopiér den.'; }
});
load();
