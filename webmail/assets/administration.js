'use strict';

const byId = id => document.getElementById(id);
const editor = byId('editor');
const form = byId('edit-form');
const fields = form.elements;
let csrf = '';
let organizations = [];
let selected = null;
let mailboxes = [];
let listRequest = 0;
let editing = null;
let saving = false;

async function request(path, data) {
  const options = {cache: 'no-store', credentials: 'same-origin'};
  if (data !== undefined) {
    options.method = 'POST';
    options.headers = {'Content-Type': 'application/json', 'X-CSRF-Token': csrf};
    options.body = JSON.stringify(data);
  }
  const response = await fetch('/api/' + path, options);
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(json.error || 'Vi kunne ikke hente et svar fra mailserveren.');
    err.status = response.status;
    err.challenge = json.dnsChallenge;
    throw err;
  }
  return json;
}

function node(tag, text, cssClass) {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (cssClass) element.className = cssClass;
  return element;
}

function clearDirectory() {
  ++listRequest;
  csrf = '';
  selected = null;
  organizations = [];
  mailboxes = [];
  byId('workspace').hidden = true;
  byId('org-list').replaceChildren();
  byId('mailboxes').replaceChildren();
  byId('records').replaceChildren();
  if (editor.open) editor.close();
  form.reset();
}

function reportAccessError(err) {
  clearDirectory();
  byId('reload').hidden = err.status === 401 || err.status === 403;
  byId('page-status').textContent = err.status === 401 ? 'Din session er udløbet. Log ind igen i Veyro Mail.' : err.message;
}

function displayOrganizations() {
  const rows = organizations.map(org => {
    const li = node('li');
    const choice = node('button', org.name || org.domain);
    choice.type = 'button';
    if (org.domain === selected?.domain) choice.setAttribute('aria-current', 'true');
    choice.append(node('small', org.domain + (org.active ? '' : ' · Inaktiv')));
    choice.onclick = () => chooseOrganization(org);
    li.append(choice);
    return li;
  });
  byId('org-list').replaceChildren(...rows);
}

function row(mailbox) {
  const li = node('li');
  const identity = node('div', '', 'mail-id');
  identity.append(node('span', mailbox.email));
  if (mailbox.name && mailbox.name !== mailbox.email) identity.append(node('small', mailbox.name));
  const badge = node('span', mailbox.active ? 'Aktiv' : 'Inaktiv', 'badge' + (mailbox.active ? ' on' : ''));
  li.append(identity, badge);
  if (mailbox.protected) {
    li.append(node('span', 'Beskyttet', 'protected'));
  } else if (selected.active) {
    const action = node('button', mailbox.active ? 'Deaktivér' : 'Aktivér', 'row-action');
    action.type = 'button';
    action.setAttribute('aria-label', action.textContent + ' ' + mailbox.email);
    action.onclick = () => openEditor('status', mailbox);
    li.append(action);
  }
  return li;
}

function displayMailboxes() {
  const query = byId('search').value.trim().toLocaleLowerCase('da');
  const filter = byId('filter').value;
  const visible = mailboxes.filter(mailbox =>
    (filter === 'all' || mailbox.active === (filter === 'active')) &&
    (!query || [mailbox.email, mailbox.name].some(s => s?.toLocaleLowerCase('da').includes(query))));
  byId('mailboxes').replaceChildren(...visible.map(row));
  byId('list-status').textContent = visible.length ? '' : mailboxes.length ? 'Ingen postkasser matcher din søgning.' : 'Organisationen har ingen postkasser endnu.';
}

function dnsRecord(title, record, priority) {
  const section = node('div', '', 'dns-record');
  const entries = [['Navn', record.name], ['Værdi', record.value]];
  if (priority !== undefined) entries.push(['Prioritet', String(priority)]);
  const list = node('dl');
  for (const [label, value] of entries) {
    const data = node('dd');
    data.append(node('code', value));
    list.append(node('dt', label), data);
  }
  const copy = node('button', 'Kopiér værdi');
  copy.type = 'button';
  copy.setAttribute('aria-label', 'Kopiér værdi for ' + title);
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(record.value); copy.textContent = 'Kopieret'; }
    catch { byId('dns-status').textContent = 'Markér værdien og kopiér den manuelt.'; }
  };
  section.append(node('h4', title), list, copy);
  return section;
}

async function showDelivery() {
  if (!selected || !byId('delivery').open) return;
  const id = listRequest;
  const domain = selected.domain;
  byId('records').replaceChildren();
  byId('retry-dns').hidden = true;
  byId('dns-status').textContent = 'Henter DNS-poster …';
  try {
    const {dns} = await request('admin/dns?domain=' + encodeURIComponent(domain));
    if (id !== listRequest) return;
    const mx = dnsRecord('MX', dns.mx, dns.mx.priority);
    const dkim = dns.dkim ? dnsRecord('TXT · DKIM', dns.dkim) : node('p', 'DKIM-nøglen er endnu ikke tilgængelig.');
    byId('records').replaceChildren(mx, dkim);
    byId('dns-status').textContent = '';
  } catch (err) {
    if (id !== listRequest) return;
    byId('dns-status').textContent = err.message;
    byId('retry-dns').hidden = false;
  }
}

async function chooseOrganization(org) {
  const id = ++listRequest;
  selected = org;
  mailboxes = [];
  byId('search').value = '';
  byId('filter').value = 'all';
  byId('search').disabled = byId('filter').disabled = true;
  byId('mailboxes').replaceChildren();
  byId('retry-mailboxes').hidden = true;
  byId('delivery').open = false;
  byId('delivery').hidden = !org;
  byId('records').replaceChildren();
  byId('dns-status').textContent = '';
  displayOrganizations();
  byId('org-name').textContent = org ? org.name || org.domain : 'Tilføj den første organisation';
  byId('org-domain').textContent = org ? org.domain + (org.active ? '' : ' · Inaktiv organisation') : '';
  byId('open-mailbox').hidden = !org?.active;
  byId('directory').hidden = !org;
  if (!org) return;
  byId('list-status').textContent = 'Henter postkasser …';
  try {
    const result = await request('admin/mailboxes?domain=' + encodeURIComponent(org.domain));
    if (id !== listRequest) return;
    mailboxes = result.mailboxes;
    byId('search').disabled = byId('filter').disabled = false;
    displayMailboxes();
  } catch (err) {
    if (id !== listRequest) return;
    if (err.status === 401 || err.status === 403) return reportAccessError(err);
    byId('list-status').textContent = err.message;
    byId('retry-mailboxes').hidden = false;
  }
}

async function loadOrganizations(preferred = selected?.domain) {
  try {
    const result = await request('admin/organizations');
    organizations = result.organizations.filter(org => !org.domain.endsWith('.test'));
    byId('reload').hidden = true;
    byId('workspace').hidden = false;
    await chooseOrganization(organizations.find(org => org.domain === preferred) || organizations[0]);
  } catch (err) {
    reportAccessError(err);
  }
}

async function start() {
  clearDirectory();
  byId('page-status').textContent = 'Henter organisationer …';
  byId('reload').hidden = true;
  try {
    const session = await request('session');
    if (session.canManageOrganizations !== true || !session.csrfToken) {
      byId('page-status').textContent = 'Din konto har ikke adgang til mailadministrationen.';
      return;
    }
    csrf = session.csrfToken;
    byId('page-status').textContent = '';
    await loadOrganizations();
  } catch (err) {
    reportAccessError(err);
  }
}

function openEditor(kind, mailbox) {
  form.reset();
  editing = {kind, mailbox, domain: selected?.domain};
  byId('organization-fields').hidden = byId('organization-fields').disabled = kind !== 'organization';
  byId('mailbox-fields').hidden = byId('mailbox-fields').disabled = kind !== 'mailbox';
  byId('form-error').hidden = byId('challenge').hidden = true;
  const action = kind === 'organization' ? 'Tilføj organisation' : kind === 'mailbox' ? 'Opret postkasse' : mailbox.active ? 'Deaktivér postkasse' : 'Aktivér postkasse';
  byId('editor-title').textContent = byId('save').textContent = action;
  const context = kind === 'organization' ? 'Brug virksomhedens eget maildomæne.'
    : kind === 'mailbox' ? selected.name + ' · ' + selected.domain
    : mailbox.active ? 'Adgang til ' + mailbox.email + ' bliver deaktiveret. Postkassens indhold bevares.'
    : 'Adgang til ' + mailbox.email + ' bliver aktiveret igen.';
  byId('form-context').textContent = context;
  byId('domain-suffix').textContent = selected ? '@' + selected.domain : '';
  editor.showModal();
  form.querySelector('fieldset:not([disabled]) input, label.confirm-password input').focus();
}

editor.addEventListener('close', () => {
  form.reset();
  editing = null;
  byId('dns-name').textContent = byId('dns-value').textContent = '';
});
editor.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
byId('cancel').onclick = () => editor.close();
fields.domain.oninput = () => {
  byId('challenge').hidden = byId('form-error').hidden = true;
  byId('save').textContent = 'Tilføj organisation';
};

form.onsubmit = async event => {
  event.preventDefault();
  if (!editing || saving) return;
  const {kind, domain, mailbox} = editing;
  const data = {currentPassword: fields.currentPassword.value};
  let target = 'admin/organizations';
  if (kind === 'organization') Object.assign(data, {name: fields.orgName.value.trim(), domain: fields.domain.value.trim().toLowerCase()});
  if (kind === 'mailbox') {
    target = 'admin/mailboxes';
    Object.assign(data, {domain, localPart: fields.localPart.value.trim(), name: fields.mailboxName.value.trim(), password: fields.initialPassword.value});
  }
  if (kind === 'status') {
    target = 'admin/mailboxes/status';
    Object.assign(data, {domain, email: mailbox.email, active: !mailbox.active});
  }
  saving = byId('save').disabled = byId('cancel').disabled = true;
  byId('form-error').hidden = true;
  try {
    await request(target, data);
    editor.close();
    byId('page-status').textContent = kind === 'organization' ? 'Organisationen er oprettet.'
      : kind === 'mailbox' ? 'Postkassen er oprettet.' : mailbox.email + (mailbox.active ? ' er deaktiveret.' : ' er aktiveret.');
    if (kind === 'organization') await loadOrganizations(data.domain);
    else await chooseOrganization(selected);
  } catch (err) {
    fields.currentPassword.value = '';
    if (err.status === 409 && kind === 'organization' && err.challenge?.type === 'TXT' && err.challenge.name && err.challenge.value) {
      byId('dns-name').textContent = err.challenge.name;
      byId('dns-value').textContent = err.challenge.value;
      byId('challenge').hidden = false;
      byId('save').textContent = 'Kontrollér DNS';
    }
    byId('form-error').textContent = err.message;
    byId('form-error').hidden = false;
    fields.currentPassword.focus();
  } finally {
    saving = byId('save').disabled = byId('cancel').disabled = false;
  }
};

byId('open-organization').onclick = () => openEditor('organization');
byId('open-mailbox').onclick = () => openEditor('mailbox');
byId('search').oninput = byId('filter').onchange = displayMailboxes;
byId('reload').onclick = start;
byId('retry-mailboxes').onclick = () => chooseOrganization(selected);
byId('delivery').ontoggle = showDelivery;
byId('retry-dns').onclick = showDelivery;
window.addEventListener('pagehide', clearDirectory);
window.addEventListener('pageshow', event => { if (event.persisted) start(); });
start();
