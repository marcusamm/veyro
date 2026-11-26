'use strict';

const byId = id => document.getElementById(id);
const editor = byId('editor');
const form = byId('edit-form');
const fields = form.elements;
let csrf = '';
let platform = false;
let ownDomain = '';
let signedInEmail = '';
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
  platform = false;
  ownDomain = signedInEmail = '';
  selected = null;
  organizations = [];
  mailboxes = [];
  byId('workspace').hidden = true;
  byId('org-list').replaceChildren();
  byId('mailboxes').replaceChildren();
  byId('records').replaceChildren();
  byId('org-name').textContent = byId('org-domain').textContent = byId('search').value = '';
  if (editor.open) editor.close();
  form.reset();
}

function reportAccessError(err) {
  clearDirectory();
  byId('reload').hidden = err.status === 401 || err.status === 403;
  byId('page-status').textContent = err.status === 401 ? 'Din session er udløbet. Log ind igen i Veyro Mail.' : err.message;
}

function sessionRole(session) {
  if (session.canManageOrganizations !== true || !session.csrfToken) return 'none';
  if (session.administrationRole) return session.administrationRole;
  return session.email === 'marcus@veyro.dk' ? 'platform' : 'none';
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
  if (mailbox.organizationAdmin) identity.append(node('small', 'Organisationsadministrator', 'role'));
  const badge = node('span', mailbox.active ? 'Aktiv' : 'Inaktiv', 'badge' + (mailbox.active ? ' on' : ''));
  li.append(identity, badge);
  if (mailbox.protected || mailbox.email === signedInEmail || (!platform && mailbox.organizationAdmin)) {
    li.append(node('span', 'Beskyttet', 'protected'));
    return li;
  }
  if (!selected.active || (!mailbox.active && !platform)) return li;
  const actions = node('div', '', 'mail-actions');
  const action = (kind, label, preposition = '') => {
    const button = node('button', label, 'row-action');
    button.type = 'button';
    button.setAttribute('aria-label', [label, preposition, mailbox.email].filter(Boolean).join(' '));
    button.onclick = () => openEditor(kind, mailbox);
    return button;
  };
  actions.append(action('status', mailbox.active ? 'Deaktivér' : 'Aktivér'));
  li.append(actions);
  const extra = node('div', '', 'extra-actions');
  extra.id = 'actions-' + mailbox.email;
  extra.hidden = true;
  if (mailbox.active) extra.append(action('password', 'Nulstil adgangskode', 'for'));
  if (platform && (mailbox.active || mailbox.organizationAdmin)) {
    extra.append(mailbox.organizationAdmin ? action('role', 'Fjern administratoradgang', 'for') : action('role', 'Giv administratoradgang', 'til'));
  }
  if (!extra.childElementCount) return li;
  const more = node('button', '···', 'row-action more');
  more.type = 'button';
  more.title = 'Flere handlinger';
  more.setAttribute('aria-label', 'Flere handlinger for ' + mailbox.email);
  more.setAttribute('aria-expanded', 'false');
  more.setAttribute('aria-controls', extra.id);
  more.onclick = () => {
    extra.hidden = !extra.hidden;
    more.setAttribute('aria-expanded', String(!extra.hidden));
  };
  actions.append(more);
  li.append(extra);
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
  if (!platform || !selected || !byId('delivery').open) return;
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
  byId('delivery').hidden = !org || !platform;
  byId('records').replaceChildren();
  byId('dns-status').textContent = '';
  displayOrganizations();
  byId('org-name').textContent = org ? org.name || org.domain : platform ? 'Tilføj den første organisation' : 'Ingen tilgængelig organisation';
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
    organizations = result.organizations.filter(org => !org.domain.endsWith('.test') && (platform || org.domain === ownDomain));
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
    signedInEmail = session.email;
    const role = sessionRole(session);
    platform = role === 'platform';
    ownDomain = role === 'organization' ? session.administrationDomain : '';
    if (!platform && !ownDomain) {
      byId('page-status').textContent = 'Din konto har ikke adgang til mailadministrationen.';
      return;
    }
    csrf = session.csrfToken;
    byId('open-organization').hidden = !platform;
    byId('org-heading').closest('nav').hidden = !platform;
    byId('workspace').classList.toggle('single-organization', !platform);
    byId('page-status').textContent = '';
    await loadOrganizations();
  } catch (err) {
    reportAccessError(err);
  }
}

function editorCopy(kind, mailbox) {
  switch (kind) {
    case 'organization': return ['Tilføj organisation', 'Brug virksomhedens eget maildomæne.'];
    case 'mailbox': return ['Opret postkasse', selected.name + ' · ' + selected.domain];
    case 'password': return ['Nulstil adgangskode', 'Vælg en ny adgangskode til ' + mailbox.email + '. Giv den til medarbejderen via en sikker kanal.'];
    case 'role':
      return mailbox.organizationAdmin
        ? ['Fjern administratoradgang', mailbox.email + ' mister retten til at administrere postkasser på ' + selected.domain + '.']
        : ['Giv administratoradgang', mailbox.email + ' får adgang til at administrere medarbejdernes postkasser og nulstille deres adgangskoder på ' + selected.domain + '.'];
    case 'status': return mailbox.active
      ? ['Deaktivér postkasse', 'Adgang til ' + mailbox.email + ' bliver deaktiveret. Postkassens indhold bevares.']
      : ['Aktivér postkasse', 'Adgang til ' + mailbox.email + ' bliver aktiveret igen.'];
  }
}

function openEditor(kind, mailbox) {
  form.reset();
  editing = {kind, mailbox, domain: selected?.domain};
  byId('organization-fields').hidden = byId('organization-fields').disabled = kind !== 'organization';
  byId('mailbox-fields').hidden = byId('mailbox-fields').disabled = kind !== 'mailbox';
  byId('reset-fields').hidden = byId('reset-fields').disabled = kind !== 'password';
  byId('form-error').hidden = byId('challenge').hidden = true;
  const [action, context] = editorCopy(kind, mailbox);
  byId('editor-title').textContent = byId('save').textContent = action;
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
  if (kind === 'password') {
    if (fields.newPassword.value !== fields.repeatPassword.value) {
      byId('form-error').textContent = 'De to nye adgangskoder skal være ens.';
      byId('form-error').hidden = false;
      fields.repeatPassword.focus();
      return;
    }
    target = 'admin/mailboxes/password';
    Object.assign(data, {domain, email: mailbox.email, newPassword: fields.newPassword.value});
  }
  if (kind === 'role') {
    target = 'admin/mailboxes/role';
    Object.assign(data, {domain, email: mailbox.email, admin: !mailbox.organizationAdmin});
  }
  saving = byId('save').disabled = byId('cancel').disabled = true;
  byId('form-error').hidden = true;
  try {
    await request(target, data);
    editor.close();
    const notices = {organization:'Organisationen er oprettet.', mailbox:'Postkassen er oprettet.'};
    if (kind === 'status') notices.status = mailbox.email + (mailbox.active ? ' er deaktiveret.' : ' er aktiveret.');
    if (kind === 'password') notices.password = 'Adgangskoden er ændret for ' + mailbox.email + '.';
    if (kind === 'role') notices.role = 'Administratoradgangen er ' + (data.admin ? 'tildelt ' : 'fjernet for ') + mailbox.email + '.';
    byId('page-status').textContent = notices[kind];
    if (kind === 'organization') await loadOrganizations(data.domain);
    else await chooseOrganization(selected);
  } catch (err) {
    fields.currentPassword.value = '';
    if (err.status === 401) return reportAccessError(err);
    if (err.status === 403) {
      try {
        const latest = await request('session');
        if (latest.email !== signedInEmail || sessionRole(latest) !== (platform ? 'platform' : 'organization') ||
            (!platform && latest.administrationDomain !== ownDomain)) {
          return reportAccessError({status:403, message:'Din administratoradgang er ændret. Åbn mailadministrationen igen fra din kontomenu.'});
        }
      } catch (sessionError) { return reportAccessError(sessionError); }
    }
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
