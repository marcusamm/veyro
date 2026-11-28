'use strict';
(() => {
  function make(tag, text, className) {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    if (className) el.className = className;
    return el;
  }
  const states = {
    sending:'Afsendelse i gang', failed:'Afsendelsen mislykkedes',
    'access-changed':'Kontoens adgang er ændret. Mailen blev ikke sendt.',
    unknown:'Afsendelsen kunne ikke bekræftes. Kontrollér Sendt, før du sender igen.',
    partial:'Afsendt til nogle modtagere. Andre modtagere blev afvist.',
    'no-copy':'Afsendt. Kopien kunne ikke gemmes i Sendt.'
  };
  async function render(kind, options) {
    const {api, list, notice, signal} = options;
    if (signal.aborted) return;
    list.replaceChildren(make('li','Henter …','organizer-info'));
    if (kind === 'scheduled') {
      const {items} = await api('scheduled',{signal});
      if (signal.aborted) return;
      list.replaceChildren();
      for (const item of items) {
        const row = make('li',null,'organizer-row');
        const when = new Date(item.at*1000).toLocaleString('da-DK',{dateStyle:'medium',timeStyle:'short'});
        row.append(make('strong',item.subject || '(Uden emne)'),make('span',item.to),make('small',when));
        if (item.status === 'pending') {
          const cancel = make('button','Annuller afsendelse','secondary');
          cancel.type = 'button';
          cancel.onclick = async () => {
            if (!confirm('Annullér den planlagte afsendelse af “'+(item.subject || '(Uden emne)')+'”?')) return;
            cancel.disabled = true;
            try {
              await api('scheduled/'+encodeURIComponent(item.id)+'/cancel',{method:'POST',body:{},signal});
              if (signal.aborted) return;
              notice('Afsendelsen er annulleret.');
              await render(kind,options);
            } catch (error) { if (!signal.aborted) {cancel.disabled = false; notice(error.message);} }
          };
          row.append(cancel);
        } else row.append(make('span',states[item.status] || 'Kontrollér afsendelsen i Sendt.'));
        list.append(row);
      }
      if (!items.length) list.append(make('li','Ingen planlagte mails. Vælg Planlæg, når du skriver en mail.','organizer-info'));
      return;
    }
    const known = new Set();
    const rows = document.createDocumentFragment();
    let cursor, more;
    async function load() {
      const data = await api('subscriptions'+(cursor?'?'+new URLSearchParams({cursor}):''),{signal});
      if (signal.aborted) return;
      if (!cursor) list.replaceChildren();
      more?.remove();
      for (const item of data.items) {
        if (known.has(item.id)) continue;
        known.add(item.id);
        const row = make('li',null,'organizer-row');
        row.append(make('strong',item.name || item.sender),make('span',item.sender));
        if (item.list) row.append(make('small',item.list));
        const target = item.target;
        if (target.kind === 'web') {
          try {
            const url = new URL(target.value);
            if (url.protocol === 'https:' && !url.username && !url.password) {
              const link = make('a','Afmeld hos '+url.hostname+' ↗','organizer-link');
              link.href = url.href; link.rel = 'noopener noreferrer'; link.target = '_blank';
              row.append(link);
            }
          } catch { /* A sender-supplied destination may be malformed. */ }
        } else if (target.kind === 'mail') {
          const button = make('button','Skriv afmelding','secondary');
          button.type = 'button';
          button.onclick = () => document.dispatchEvent(new CustomEvent('veyro:unsubscribe-draft',{detail:{...target,id:item.id}}));
          row.append(button);
        }
        rows.append(row);
      }
      list.append(rows);
      cursor = data.next;
      if (cursor) {
        more = make('li',null,'organizer-info');
        const button = make('button','Hent flere fra indbakken','secondary');
        button.type = 'button';
        button.onclick = async () => {
          button.disabled = true;
          try { await load(); } catch (error) { if (!signal.aborted) { button.disabled = false; notice(error.message); } }
        };
        more.append(button);list.append(more);
      } else if (!known.size) list.append(make('li','Ingen mails i indbakken har angivet en afmeldingsmulighed.','organizer-info'));
    }
    await load();
  }
  window.VeyroMailOrganizer = Object.freeze({render});
})();
