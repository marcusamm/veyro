import { html, raw } from 'hono/html';
import { formatDateShort, formatDateTime, formatKr } from '../lib/format';
import type { HistoryRow, SiteData, SitePage, SiteProduct, TemplateData } from '../site/content';
import { keyLabel } from '../site/content';
import { sectionSchema, type SettingDef } from '../site/engine';
import { LEAD_KIND_LABEL, LEAD_STATUS_LABEL, LEAD_STATUSES, type LeadCartLine, type LeadRow, type LeadStatus } from '../site/leads';
import { alert, csrfField, type H } from './layout';

export interface SiteFile {
  id: number;
  name: string;
  type: string;
  size: number;
  width: number | null;
  height: number | null;
  created_at: number;
}

const FLASH: Record<string, string> = {
  gemt: 'Ændringerne er gemt og vises nu på hjemmesiden.',
  nulstillet: 'Indholdet er sat tilbage til standard. Den tidligere version ligger i historikken.',
  gendannet: 'Den tidligere version er gendannet.',
  oprettet: 'Siden er oprettet.',
  slettet: 'Slettet. Det kan fortrydes under Historik.',
  uploadet: 'Billedet er uploadet. Vælg det i en sektion eller under Temaindstillinger.',
  'billede-slettet': 'Billedet er slettet.',
};

function flash(key: string | null | undefined): H | string {
  return key && FLASH[key] ? alert('ok', FLASH[key]) : '';
}

function crumbs(...items: [string, string | null][]): H {
  return html`<p class="eyebrow">${items.map(([label, href], i) => html`${i ? ' / ' : ''}${href ? html`<a href="${href}">${label}</a>` : label}`)}</p>`;
}

function pageAddress(p: SitePage): string {
  return `/pages/${p.handle}`;
}

// ---------- Oversigt ----------

export function siteOverviewPage(args: {
  site: SiteData;
  siteUrl: string;
  previewUrl: string | null;
  stats: { total: number; byDay: { day: string; views: number }[]; byPath: { path: string; views: number }[] };
  leadCounts: Record<string, number>;
  recentLeads: LeadRow[];
  history: HistoryRow[];
  flash: string | null;
}): H {
  const s = args.site;
  const open = (args.leadCounts['ny'] ?? 0) + (args.leadCounts['besvaret'] ?? 0) + (args.leadCounts['tilbud'] ?? 0);
  const max = Math.max(1, ...args.stats.byDay.map((d) => d.views));
  const textPages = s.pages.filter((p) => !p.template);
  const sectionPages = s.pages.filter((p) => p.template);
  return html`<div class="stack-lg">
  <div>${crumbs(['Admin', '/admin'])}<h1>Hjemmeside</h1>
    <p class="lead">Alt indhold på veyro.dk: sider, tekster, menuer, priser og billeder. Ændringer vises med det samme, og alle tidligere versioner kan gendannes.</p>
    <div class="row"><a class="btn btn-secondary btn-small" href="${args.previewUrl ?? args.siteUrl}" target="_blank" rel="noopener">Åbn hjemmesiden</a></div></div>
  ${flash(args.flash)}
  <div class="grid grid-3">
    <a class="card" href="/admin/forespoergsler" style="text-decoration:none"><div class="muted small">Nye forespørgsler</div><div class="price-big">${args.leadCounts['ny'] ?? 0}</div></a>
    <a class="card" href="/admin/forespoergsler" style="text-decoration:none"><div class="muted small">Åbne forespørgsler</div><div class="price-big">${open}</div></a>
    <div class="card"><div class="muted small">Sidevisninger, 30 dage</div><div class="price-big">${args.stats.total.toLocaleString('da-DK')}</div></div>
  </div>

  <section class="card stack" aria-labelledby="sider-h">
    <div class="row between"><h2 id="sider-h" style="margin:0">Sider</h2><a class="btn btn-secondary btn-small" href="/admin/hjemmeside/sider/ny">Ny side</a></div>
    <div class="table-wrap"><table class="responsive">
      <thead><tr><th scope="col">Side</th><th scope="col">Adresse</th><th scope="col">Status</th><th scope="col"><span class="visually-hidden">Handling</span></th></tr></thead>
      <tbody>
        <tr><td data-label="Side"><strong>Forside</strong></td><td data-label="Adresse">/</td><td data-label="Status"><span class="badge b-ok">Vises</span></td>
          <td data-label=""><a href="/admin/hjemmeside/sektioner/template:index">Rediger</a></td></tr>
        ${[...sectionPages, ...textPages].map(
          (p) => html`<tr><td data-label="Side"><strong>${p.title}</strong>${s.overridden.has('page:' + p.handle) || s.overridden.has('template:page.' + p.template) ? html` <span class="badge b-neutral">Ændret</span>` : ''}</td>
            <td data-label="Adresse">${pageAddress(p)}</td>
            <td data-label="Status">${p.published ? html`<span class="badge b-ok">Vises</span>` : html`<span class="badge b-warn">Skjult</span>`}</td>
            <td data-label=""><a href="/admin/hjemmeside/side/${p.handle}">Rediger</a></td></tr>`,
        )}
      </tbody></table></div>
  </section>

  <section class="card stack" aria-labelledby="faelles-h">
    <h2 id="faelles-h" style="margin:0">På alle sider</h2>
    <ul class="link-grid">
      <li><a href="/admin/hjemmeside/sektioner/group:header-group"><strong>Sidehoved</strong><span>Logo-tekst, menu og knap øverst</span></a></li>
      <li><a href="/admin/hjemmeside/sektioner/group:footer-group"><strong>Sidefod</strong><span>Menuer, kontakt og juridiske links</span></a></li>
      <li><a href="/admin/hjemmeside/menuer"><strong>Menuer</strong><span>Punkter i hovedmenu, sidefod og juridisk</span></a></li>
      <li><a href="/admin/hjemmeside/produkter"><strong>Abonnementer og priser</strong><span>Det, der kan lægges i kurven</span></a></li>
      <li><a href="/admin/hjemmeside/indstillinger"><strong>Temaindstillinger</strong><span>Firmaoplysninger, farver, cookiebanner, SEO</span></a></li>
      <li><a href="/admin/hjemmeside/billeder"><strong>Billeder</strong><span>Upload logo og billeder</span></a></li>
      <li><a href="/admin/hjemmeside/sektioner/template:cart"><strong>Kurv</strong><span>Tekster på kurvsiden</span></a></li>
      <li><a href="/admin/hjemmeside/sektioner/template:product"><strong>Abonnementssider</strong><span>Layout for /products/…</span></a></li>
      <li><a href="/admin/hjemmeside/sektioner/template:404"><strong>Siden findes ikke</strong><span>Fejlsiden (404)</span></a></li>
      <li><a href="/admin/hjemmeside/historik"><strong>Historik</strong><span>Se og gendan tidligere versioner</span></a></li>
    </ul>
  </section>

  <div class="grid grid-2">
    <section class="card stack" aria-labelledby="besog-h">
      <h2 id="besog-h" style="margin:0">Besøg</h2>
      <p class="small muted">Sidevisninger pr. dag de sidste 30 dage. Tælles uden cookies og uden IP-adresser; robotter tælles ikke med.</p>
      ${args.stats.byDay.length
        ? html`<ol class="bars" aria-label="Sidevisninger pr. dag">${args.stats.byDay.map(
            (d) => html`<li title="${d.day}: ${d.views}"><span style="height:${Math.max(2, Math.round((d.views / max) * 100))}%"></span><span class="visually-hidden">${d.day}: ${d.views}</span></li>`,
          )}</ol>`
        : html`<p class="empty">Ingen besøg endnu.</p>`}
      ${args.stats.byPath.length
        ? html`<table><thead><tr><th scope="col">Mest viste sider</th><th scope="col" class="num">Visninger</th></tr></thead><tbody>${args.stats.byPath.map(
            (p) => html`<tr><td>${p.path}</td><td class="num">${p.views}</td></tr>`,
          )}</tbody></table>`
        : ''}
    </section>
    <section class="card stack" aria-labelledby="seneste-h">
      <div class="row between"><h2 id="seneste-h" style="margin:0">Seneste forespørgsler</h2><a class="small" href="/admin/forespoergsler">Se alle</a></div>
      ${args.recentLeads.length ? leadList(args.recentLeads) : html`<p class="empty">Ingen forespørgsler endnu.</p>`}
      <div class="row between"><h2 style="margin:0">Seneste ændringer</h2><a class="small" href="/admin/hjemmeside/historik">Historik</a></div>
      ${args.history.length
        ? html`<ul class="list">${args.history.slice(0, 5).map((h) => html`<li><span>${keyLabel(h.key, s)}</span><span class="small muted">${formatDateTime(h.replaced_at)} · ${h.replaced_by ?? ''}</span></li>`)}</ul>`
        : html`<p class="empty">Ingen ændringer endnu. Siden viser standardindholdet.</p>`}
    </section>
  </div>
</div>`;
}

// ---------- Felter ud fra temaets skema ----------

interface FieldCtx {
  site: SiteData;
  files: SiteFile[];
}

function opt(value: string, label: string, selected: boolean): H {
  return html`<option value="${value}"${selected ? raw(' selected') : ''}>${label}</option>`;
}

function settingField(name: string, def: SettingDef, value: unknown, ctx: FieldCtx): H | string {
  const id = 'f-' + name.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (def.type === 'header') return html`<h4 class="h-small field-header">${def.content ?? ''}</h4>`;
  if (def.type === 'paragraph') return html`<p class="hint">${def.content ?? ''}</p>`;
  if (!def.id) return '';
  const label = def.label ?? def.id;
  const hint = def.info ? html`<p class="hint">${def.info}</p>` : '';
  const v = value == null ? '' : String(value);
  switch (def.type) {
    case 'checkbox':
      return html`<div class="field"><label class="check"><input type="checkbox" name="${name}" value="1"${value === true || value === 'true' ? raw(' checked') : ''}> ${label}</label>${hint}</div>`;
    case 'select':
    case 'radio':
      return html`<div class="field"><label for="${id}">${label}</label><select id="${id}" name="${name}">${(def.options ?? []).map((o) => opt(o.value, o.label, o.value === v))}</select>${hint}</div>`;
    case 'range':
    case 'number':
      return html`<div class="field"><label for="${id}">${label}${def.unit ? ` (${def.unit})` : ''}</label><input id="${id}" type="number" name="${name}" value="${v}"${def.min != null ? raw(` min="${def.min}"`) : ''}${def.max != null ? raw(` max="${def.max}"`) : ''}${def.step != null ? raw(` step="${def.step}"`) : ''}>${hint}</div>`;
    case 'color':
      return html`<div class="field"><label for="${id}">${label}</label><input id="${id}" type="color" name="${name}" value="${v || '#000000'}">${hint}</div>`;
    case 'textarea':
    case 'richtext':
    case 'inline_richtext':
    case 'html':
    case 'liquid': {
      const rich = def.type === 'richtext' || def.type === 'inline_richtext' || def.type === 'html';
      const rows = Math.min(14, Math.max(def.type === 'inline_richtext' ? 2 : 3, Math.ceil(v.length / 70) + 1));
      return html`<div class="field"><label for="${id}">${label}</label><textarea id="${id}" name="${name}" rows="${rows}" class="${rich ? 'code' : ''}">${v}</textarea>${hint}${rich ? html`<p class="hint">HTML er tilladt, fx &lt;p&gt;, &lt;strong&gt;, &lt;a href="…"&gt;.</p>` : ''}</div>`;
    }
    case 'product':
      return html`<div class="field"><label for="${id}">${label}</label><select id="${id}" name="${name}">${opt('', '(intet)', !v)}${ctx.site.products.map((p) => opt(p.handle, p.title, p.handle === v))}</select>${hint}</div>`;
    case 'page':
      return html`<div class="field"><label for="${id}">${label}</label><select id="${id}" name="${name}">${opt('', '(ingen)', !v)}${ctx.site.pages.map((p) => opt(p.handle, p.title, p.handle === v))}</select>${hint}</div>`;
    case 'link_list':
      return html`<div class="field"><label for="${id}">${label}</label><select id="${id}" name="${name}">${opt('', '(ingen)', !v)}${Object.entries(ctx.site.menus).map(([h, m]) => opt(h, m.title, h === v))}</select>${hint}</div>`;
    case 'image_picker':
      return html`<div class="field"><label for="${id}">${label}</label><select id="${id}" name="${name}">${opt('', '(intet billede)', !v)}${ctx.files.map((f) => opt(`file:${f.id}:${f.width ?? 1}x${f.height ?? 1}`, `${f.name} (${f.width ?? '?'}×${f.height ?? '?'})`, v.startsWith(`file:${f.id}:`)))}</select><p class="hint">Upload billeder under <a href="/admin/hjemmeside/billeder">Billeder</a>.</p>${hint}</div>`;
    case 'text':
    case 'url':
    case 'email':
    case 'video_url':
      return html`<div class="field"><label for="${id}">${label}</label><input id="${id}" type="text" name="${name}" value="${v}">${hint}</div>`;
    default:
      return '';
  }
}

/** Kort beskrivelse af en blok (første tekstfelt), så de kan kendes fra hinanden */
function blockSummary(settings: Record<string, unknown> | undefined): string {
  for (const v of Object.values(settings ?? {})) {
    if (typeof v === 'string' && v.trim() && !v.startsWith('file:')) {
      const t = v.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (t) return t.length > 60 ? t.slice(0, 57) + '…' : t;
    }
  }
  return '';
}

export function sectionsEditorPage(args: {
  csrf: string;
  key: string;
  title: string;
  back: [string, string];
  tpl: TemplateData;
  site: SiteData;
  files: SiteFile[];
  saved: boolean;
  history: HistoryRow[];
  sectionTypes: { type: string; name: string }[];
  viewUrl: string | null;
  flash: string | null;
  error?: string | null;
}): H {
  const ctx: FieldCtx = { site: args.site, files: args.files };
  const order = [...args.tpl.order, ...Object.keys(args.tpl.sections).filter((id) => !args.tpl.order.includes(id))];
  return html`<div class="stack-lg">
  <div>${crumbs(['Admin', '/admin'], ['Hjemmeside', '/admin/hjemmeside'], args.back)}<h1>${args.title}</h1>
    <p class="lead">Rediger tekster, slå sektioner til og fra, og flyt dem ved at ændre nummeret. Gem nederst.</p>
    ${args.viewUrl ? html`<div class="row"><a class="btn btn-secondary btn-small" href="${args.viewUrl}" target="_blank" rel="noopener">Se siden</a></div>` : ''}</div>
  ${flash(args.flash)}
  ${args.error ? alert('err', args.error) : ''}
  <form method="post" action="/admin/hjemmeside/sektioner/${args.key}" class="stack-lg" novalidate>
    ${csrfField(args.csrf)}
    ${order.map((sid, i) => {
      const sec = args.tpl.sections[sid];
      if (!sec) return '';
      const schema = sectionSchema(sec.type);
      const blocks = sec.block_order ?? Object.keys(sec.blocks ?? {});
      const blockDefs = schema.blocks ?? [];
      const atLimit = schema.max_blocks != null && blocks.length >= schema.max_blocks;
      return html`<fieldset class="card stack section-edit${sec.disabled ? ' is-off' : ''}" id="s-${sid}">
        <legend class="visually-hidden">${schema.name ?? sec.type}</legend>
        <div class="row between section-edit__head">
          <h2 class="h-small" style="margin:0">${schema.name ?? sec.type}${sec.disabled ? html` <span class="badge b-warn">Skjult</span>` : ''}</h2>
          <div class="row small">
            <label class="inline-num">Nr. <input type="number" name="pos|${sid}" value="${i + 1}" min="1" max="99"></label>
            <label class="check"><input type="checkbox" name="hide|${sid}" value="1"${sec.disabled ? raw(' checked') : ''}> Skjul</label>
            <label class="check"><input type="checkbox" name="del|${sid}" value="1"> Slet</label>
          </div>
        </div>
        <div class="settings-grid">${(schema.settings ?? []).map((d) => settingField(`s|${sid}|${d.id ?? ''}`, d, sec.settings?.[d.id ?? ''] ?? d.default, ctx))}</div>
        ${blockDefs.length
          ? html`<div class="stack blocks">
            <h3 class="h-small" style="margin:0">Elementer (${blocks.length})</h3>
            ${blocks.map((bid, bi) => {
              const b = sec.blocks?.[bid];
              if (!b) return '';
              const bdef = blockDefs.find((x) => x.type === b.type);
              return html`<details class="block-edit${b.disabled ? ' is-off' : ''}">
                <summary><strong>${bi + 1}. ${bdef?.name ?? b.type}</strong> <span class="muted">${blockSummary(b.settings)}</span>${b.disabled ? html` <span class="badge b-warn">Skjult</span>` : ''}</summary>
                <div class="stack">
                  <div class="row small">
                    <label class="inline-num">Nr. <input type="number" name="bpos|${sid}|${bid}" value="${bi + 1}" min="1" max="99"></label>
                    <label class="check"><input type="checkbox" name="bhide|${sid}|${bid}" value="1"${b.disabled ? raw(' checked') : ''}> Skjul</label>
                    <label class="check"><input type="checkbox" name="bdel|${sid}|${bid}" value="1"> Slet</label>
                  </div>
                  <div class="settings-grid">${(bdef?.settings ?? []).map((d) => settingField(`b|${sid}|${bid}|${d.id ?? ''}`, d, b.settings?.[d.id ?? ''] ?? d.default, ctx))}</div>
                </div>
              </details>`;
            })}
            ${atLimit
              ? html`<p class="hint">Sektionen har det største antal elementer, den kan vise.</p>`
              : html`<div class="row">${blockDefs.map(
                  (bd) => html`<button class="btn btn-secondary btn-small" type="submit" name="add_block" value="${sid}|${bd.type}">+ ${bd.name}</button>`,
                )}</div>`}
          </div>`
          : ''}
      </fieldset>`;
    })}
    <section class="card stack">
      <h2 class="h-small" style="margin:0">Tilføj sektion</h2>
      <div class="row">
        <select name="add_section" aria-label="Sektionstype" style="max-width:320px">${opt('', 'Vælg sektion…', true)}${args.sectionTypes.map((t) => opt(t.type, t.name, false))}</select>
        <button class="btn btn-secondary" type="submit" name="action" value="add_section">Tilføj nederst</button>
      </div>
    </section>
    <div class="row sticky-save">
      <button class="btn btn-primary" type="submit" name="action" value="save">Gem ændringer</button>
      ${args.saved ? html`<button class="btn btn-secondary" type="submit" name="action" value="reset">Sæt tilbage til standard</button>` : ''}
    </div>
  </form>
  ${historyCard(args.csrf, args.history, args.site, `/admin/hjemmeside/sektioner/${args.key}`)}
</div>`;
}

function historyCard(csrf: string, rows: HistoryRow[], site: SiteData, back: string): H | string {
  if (!rows.length) return '';
  return html`<section class="card stack" aria-labelledby="hist-h">
    <h2 id="hist-h" class="h-small" style="margin:0">Tidligere versioner</h2>
    <p class="small muted">Versionen, som den så ud før hver gemning. Gendan erstatter det nuværende indhold (som selv gemmes i historikken).</p>
    <ul class="list">${rows.slice(0, 10).map(
      (h) => html`<li><span>${formatDateTime(h.replaced_at)} · ${h.replaced_by ?? ''}${h.note ? html` · ${h.note}` : ''}${h.value === null ? html` <span class="badge b-neutral">Standard</span>` : ''}</span>
        <form method="post" action="/admin/hjemmeside/historik/${h.id}/gendan" class="inline">${csrfField(csrf)}<input type="hidden" name="back" value="${back}"><button class="btn btn-secondary btn-small" type="submit">Gendan</button></form></li>`,
    )}</ul>
    <p class="small"><a href="/admin/hjemmeside/historik">Al historik</a> · ${keyLabel(rows[0]!.key, site)}</p>
  </section>`;
}

// ---------- Sider ----------

export function pageEditorPage(args: {
  csrf: string;
  page: SitePage | null;
  site: SiteData;
  isDefault: boolean;
  history: HistoryRow[];
  flash: string | null;
  error?: string | null;
  form?: Partial<SitePage> & { copy_from?: string };
  viewUrl: string | null;
}): H {
  const p = args.page;
  const f = { ...(p ?? {}), ...(args.form ?? {}) } as Partial<SitePage> & { copy_from?: string };
  const isNew = !p;
  const sectionPages = args.site.pages.filter((x) => x.template);
  return html`<div class="stack-lg">
  <div>${crumbs(['Admin', '/admin'], ['Hjemmeside', '/admin/hjemmeside'], [isNew ? 'Ny side' : p!.title, null])}<h1>${isNew ? 'Ny side' : p!.title}</h1>
    ${!isNew && args.viewUrl ? html`<div class="row"><a class="btn btn-secondary btn-small" href="${args.viewUrl}" target="_blank" rel="noopener">Se siden</a>${p!.template ? html`<a class="btn btn-accent btn-small" href="/admin/hjemmeside/sektioner/template:page.${p!.template}">Rediger sidens sektioner</a>` : ''}</div>` : ''}</div>
  ${flash(args.flash)}
  ${args.error ? alert('err', args.error) : ''}
  <form method="post" action="${isNew ? '/admin/hjemmeside/sider/ny' : `/admin/hjemmeside/side/${p!.handle}`}" class="card stack" novalidate>
    ${csrfField(args.csrf)}
    <div class="grid grid-2">
      <div class="field"><label for="p-title">Titel</label><input id="p-title" type="text" name="title" value="${f.title ?? ''}" required maxlength="120"></div>
      <div class="field"><label for="p-handle">Adresse</label>${isNew
        ? html`<input id="p-handle" type="text" name="handle" value="${f.handle ?? ''}" maxlength="60" placeholder="fx priser"><p class="hint">Bliver til veyro.dk/pages/&lt;adresse&gt;. Små bogstaver, tal og bindestreg. Tom = laves ud fra titlen.</p>`
        : html`<input id="p-handle" type="text" value="/pages/${p!.handle}" readonly>`}</div>
    </div>
    <div class="field"><label for="p-desc">Beskrivelse til Google og deling (valgfri)</label><textarea id="p-desc" name="description" rows="2" maxlength="300">${f.description ?? ''}</textarea><p class="hint">Bruges i søgeresultater. Ca. 150 tegn. Tom = firmaets standardbeskrivelse.</p></div>
    <div class="field"><label class="check"><input type="checkbox" name="published" value="1"${f.published !== false ? raw(' checked') : ''}> Vis siden på hjemmesiden</label></div>
    ${isNew
      ? html`<div class="field"><label for="p-type">Sidetype</label><select id="p-type" name="copy_from">${opt('', 'Tekstside (overskrift og tekst)', !f.copy_from)}${sectionPages.map((x) => opt(x.template, `Sektionsside: kopi af layoutet fra „${x.title}“`, f.copy_from === x.template))}</select>
          <p class="hint">En sektionsside starter som en kopi, som du bagefter retter til under „Rediger sidens sektioner“.</p></div>`
      : ''}
    ${isNew || !p!.template
      ? html`<div class="field"><label for="p-body">Tekst (HTML)</label><textarea id="p-body" name="body" rows="18" class="code">${f.body ?? ''}</textarea>
          <p class="hint">Brug &lt;h2&gt; til mellemrubrikker, &lt;p&gt; til afsnit, &lt;ul&gt;&lt;li&gt; til lister og &lt;a href="…"&gt; til links.</p></div>`
      : html`<p class="hint">Siden er bygget af sektioner. Tekster og elementer redigeres under „Rediger sidens sektioner“.</p>`}
    <div class="row"><button class="btn btn-primary" type="submit">${isNew ? 'Opret side' : 'Gem ændringer'}</button></div>
  </form>
  ${!isNew
    ? html`<form method="post" action="/admin/hjemmeside/side/${p!.handle}/slet" class="card stack">
        ${csrfField(args.csrf)}
        <h2 class="h-small" style="margin:0">Slet siden</h2>
        <p class="small muted">Siden forsvinder fra hjemmesiden og menuerne viser et dødt link, indtil du retter dem. Det kan fortrydes under Historik.</p>
        <label class="check"><input type="checkbox" name="confirm" value="1" required> Ja, slet „${p!.title}“</label>
        <div><button class="btn btn-danger btn-small" type="submit">Slet side</button></div>
      </form>`
    : ''}
  ${p ? historyCard(args.csrf, args.history, args.site, `/admin/hjemmeside/side/${p.handle}`) : ''}
</div>`;
}

// ---------- Menuer ----------

export function menusPage(args: { csrf: string; site: SiteData; history: HistoryRow[]; flash: string | null; error?: string | null }): H {
  return html`<div class="stack-lg">
  <div>${crumbs(['Admin', '/admin'], ['Hjemmeside', '/admin/hjemmeside'], ['Menuer', null])}<h1>Menuer</h1>
    <p class="lead">Ret tekst og link for hvert punkt. Tøm teksten for at fjerne et punkt, og skift nummer for at flytte det.</p></div>
  ${flash(args.flash)}
  ${args.error ? alert('err', args.error) : ''}
  <form method="post" action="/admin/hjemmeside/menuer" class="stack-lg" novalidate>
    ${csrfField(args.csrf)}
    ${Object.entries(args.site.menus).map(
      ([handle, m]) => html`<fieldset class="card stack">
        <legend class="visually-hidden">${m.title}</legend>
        <h2 class="h-small" style="margin:0">${m.title}</h2>
        <div class="menu-rows">
          <div class="menu-row menu-row--head small muted"><span>Nr.</span><span>Tekst</span><span>Link</span></div>
          ${[...m.items, { title: '', url: '' }, { title: '', url: '' }].map(
            (it, i) => html`<div class="menu-row">
              <input type="number" name="m|${handle}|${i}|pos" value="${i + 1}" min="1" max="99" aria-label="Nummer">
              <input type="text" name="m|${handle}|${i}|title" value="${it.title}" maxlength="80" aria-label="Tekst" placeholder="${i >= m.items.length ? 'Nyt punkt' : ''}">
              <input type="text" name="m|${handle}|${i}|url" value="${it.url}" maxlength="300" aria-label="Link" placeholder="/pages/…">
            </div>`,
          )}
        </div>
      </fieldset>`,
    )}
    <div class="row"><button class="btn btn-primary" type="submit">Gem menuer</button></div>
  </form>
  <section class="card stack"><h2 class="h-small" style="margin:0">Sider, du kan linke til</h2>
    <ul class="list small">${args.site.pages.map((p) => html`<li><span>${p.title}</span><code>/pages/${p.handle}</code></li>`)}<li><span>Kurv</span><code>/cart</code></li></ul></section>
  ${historyCard(args.csrf, args.history, args.site, '/admin/hjemmeside/menuer')}
</div>`;
}

// ---------- Abonnementer og priser ----------

export function productsPage(args: { csrf: string; site: SiteData; flash: string | null; error?: string | null }): H {
  const row = (p: SiteProduct | null) => {
    const k = p ? p.handle : '_new';
    return html`<fieldset class="card stack">
      <legend class="visually-hidden">${p ? p.title : 'Nyt abonnement'}</legend>
      <div class="row between"><h2 class="h-small" style="margin:0">${p ? p.title : 'Nyt abonnement'}</h2>${p ? html`<a class="small" href="/products/${p.handle}" target="_blank" rel="noopener">/products/${p.handle}</a>` : ''}</div>
      <div class="grid grid-2">
        <div class="field"><label for="p-${k}-title">Navn</label><input id="p-${k}-title" type="text" name="p|${k}|title" value="${p?.title ?? ''}" maxlength="120"></div>
        ${p ? '' : html`<div class="field"><label for="p-${k}-handle">Adresse</label><input id="p-${k}-handle" type="text" name="p|${k}|handle" maxlength="60" placeholder="fx enterprise"></div>`}
        <div class="field"><label for="p-${k}-price">Pris (kr. inkl. moms)</label><input id="p-${k}-price" type="text" inputmode="decimal" name="p|${k}|price" value="${p ? String(p.price / 100).replace('.', ',') : ''}" maxlength="12"></div>
        <div class="field"><label for="p-${k}-interval">Betales</label><select id="p-${k}-interval" name="p|${k}|interval">${opt('month', 'Hver måned', !p || p.interval === 'month')}${opt('year', 'Hvert år', p?.interval === 'year')}</select></div>
        <div class="field"><label for="p-${k}-status">Status</label><select id="p-${k}-status" name="p|${k}|status">${opt('active', 'Kan lægges i kurven', !p || p.status === 'active')}${opt('draft', 'Skjult (kun „Hent tilbud“)', p?.status === 'draft')}</select></div>
        <div class="field"><label for="p-${k}-type">Produkttype</label><input id="p-${k}-type" type="text" name="p|${k}|type" value="${p?.type ?? 'Abonnement'}" maxlength="60"><p class="hint">„Abonnement“ viser abonnementsteksten i kurven.</p></div>
      </div>
      <div class="field"><label for="p-${k}-desc">Beskrivelse (HTML)</label><textarea id="p-${k}-desc" name="p|${k}|description" rows="5" class="code">${p?.description ?? ''}</textarea></div>
      ${p ? html`<label class="check small"><input type="checkbox" name="p|${k}|delete" value="1"> Slet abonnementet</label>` : ''}
    </fieldset>`;
  };
  return html`<div class="stack-lg">
  <div>${crumbs(['Admin', '/admin'], ['Hjemmeside', '/admin/hjemmeside'], ['Abonnementer og priser', null])}<h1>Abonnementer og priser</h1>
    <p class="lead">Det, kunderne kan lægge i kurven. Kurven sendes som en forespørgsel, og den endelige pris står i det tilbud, I sender. Ændrer du en pris her, ændres den også i prisoversigten på Ydelser.</p></div>
  ${flash(args.flash)}
  ${args.error ? alert('err', args.error) : ''}
  <form method="post" action="/admin/hjemmeside/produkter" class="stack-lg" novalidate>
    ${csrfField(args.csrf)}
    ${args.site.products.map((p) => row(p))}
    <details class="card"><summary><strong>Tilføj abonnement</strong></summary><div class="stack" style="margin-top:12px">${row(null)}</div></details>
    <div class="row"><button class="btn btn-primary" type="submit">Gem abonnementer</button></div>
  </form>
</div>`;
}

// ---------- Temaindstillinger ----------

export function settingsPage(args: { csrf: string; site: SiteData; files: SiteFile[]; groups: { name: string; settings?: SettingDef[] }[]; history: HistoryRow[]; flash: string | null }): H {
  const ctx: FieldCtx = { site: args.site, files: args.files };
  return html`<div class="stack-lg">
  <div>${crumbs(['Admin', '/admin'], ['Hjemmeside', '/admin/hjemmeside'], ['Temaindstillinger', null])}<h1>Temaindstillinger</h1>
    <p class="lead">Firmaoplysninger, farver, cookiebanner, Trustpilot og SEO for hele hjemmesiden.</p></div>
  ${flash(args.flash)}
  <form method="post" action="/admin/hjemmeside/indstillinger" class="stack-lg" novalidate>
    ${csrfField(args.csrf)}
    ${args.groups
      .filter((g) => (g.settings ?? []).some((d) => d.id))
      .map(
        (g, i) => html`<details class="card"${i === 0 ? raw(' open') : ''}><summary><strong>${g.name}</strong></summary>
          <div class="settings-grid" style="margin-top:12px">${(g.settings ?? []).map((d) => settingField(`g|${d.id ?? ''}`, d, d.id ? (args.site.settings[d.id] ?? d.default) : '', ctx))}</div></details>`,
      )}
    <div class="row sticky-save"><button class="btn btn-primary" type="submit">Gem indstillinger</button></div>
  </form>
  ${historyCard(args.csrf, args.history, args.site, '/admin/hjemmeside/indstillinger')}
</div>`;
}

// ---------- Billeder ----------

export function filesPage(args: { csrf: string; files: SiteFile[]; flash: string | null; error?: string | null }): H {
  return html`<div class="stack-lg">
  <div>${crumbs(['Admin', '/admin'], ['Hjemmeside', '/admin/hjemmeside'], ['Billeder', null])}<h1>Billeder</h1>
    <p class="lead">Upload logo, delingsbillede og billeder til sektioner. PNG, JPG, WebP eller GIF, højst 1,5 MB.</p></div>
  ${flash(args.flash)}
  ${args.error ? alert('err', args.error) : ''}
  <form method="post" action="/admin/hjemmeside/billeder" enctype="multipart/form-data" class="card stack">
    ${csrfField(args.csrf)}
    <div class="field"><label for="f-file">Billede</label><input id="f-file" type="file" name="file" accept="image/png,image/jpeg,image/webp,image/gif" required></div>
    <div class="row"><button class="btn btn-primary" type="submit">Upload</button></div>
  </form>
  <section class="card">
    ${args.files.length
      ? html`<ul class="file-grid">${args.files.map(
          (f) => html`<li>
            <img src="/admin/hjemmeside/billeder/${f.id}" alt="" loading="lazy">
            <div class="small"><strong>${f.name}</strong><br><span class="muted">${f.width ?? '?'}×${f.height ?? '?'} px · ${Math.round(f.size / 1024)} KB · ${formatDateShort(f.created_at)}</span></div>
            <form method="post" action="/admin/hjemmeside/billeder/${f.id}/slet" class="inline">${csrfField(args.csrf)}<button class="btn btn-secondary btn-small" type="submit">Slet</button></form>
          </li>`,
        )}</ul>`
      : html`<p class="empty">Ingen billeder endnu.</p>`}
  </section>
</div>`;
}

// ---------- Historik ----------

export function historyPage(args: { csrf: string; site: SiteData; rows: HistoryRow[]; flash: string | null }): H {
  return html`<div class="stack-lg">
  <div>${crumbs(['Admin', '/admin'], ['Hjemmeside', '/admin/hjemmeside'], ['Historik', null])}<h1>Historik</h1>
    <p class="lead">Hver gang noget gemmes, gemmes den tidligere version her. Gendan for at rulle en ændring tilbage.</p></div>
  ${flash(args.flash)}
  <section class="card">
    ${args.rows.length
      ? html`<div class="table-wrap"><table class="responsive"><thead><tr><th scope="col">Indhold</th><th scope="col">Ændret</th><th scope="col">Af</th><th scope="col"><span class="visually-hidden">Gendan</span></th></tr></thead><tbody>
        ${args.rows.map(
          (h) => html`<tr><td data-label="Indhold">${keyLabel(h.key, args.site)}${h.note ? html`<br><span class="small muted">${h.note}</span>` : ''}</td><td data-label="Ændret">${formatDateTime(h.replaced_at)}</td><td data-label="Af">${h.replaced_by ?? ''}</td>
            <td data-label=""><form method="post" action="/admin/hjemmeside/historik/${h.id}/gendan" class="inline">${csrfField(args.csrf)}<input type="hidden" name="back" value="/admin/hjemmeside/historik"><button class="btn btn-secondary btn-small" type="submit">Gendan versionen før</button></form></td></tr>`,
        )}</tbody></table></div>`
      : html`<p class="empty">Ingen ændringer endnu.</p>`}
  </section>
</div>`;
}

// ---------- Forespørgsler ----------

function leadBadge(s: LeadStatus): H {
  const tone = s === 'ny' ? 'b-accent' : s === 'kunde' ? 'b-ok' : s === 'spam' || s === 'lukket' ? 'b-neutral' : 'b-warn';
  return html`<span class="badge ${tone}">${LEAD_STATUS_LABEL[s]}</span>`;
}

function leadSummary(l: LeadRow): string {
  if (l.kind === 'kurv' && l.cart) {
    try {
      return (JSON.parse(l.cart) as LeadCartLine[]).map((x) => `${x.quantity > 1 ? `${x.quantity} × ` : ''}${x.title}`).join(', ');
    } catch {
      /* falder igennem */
    }
  }
  const t = l.service || l.message || l.website || '';
  return t.length > 80 ? t.slice(0, 77) + '…' : t;
}

function leadList(rows: LeadRow[]): H {
  return html`<div class="table-wrap"><table class="responsive">
    <thead><tr><th scope="col">Fra</th><th scope="col">Hvad</th><th scope="col">Status</th><th scope="col">Modtaget</th></tr></thead>
    <tbody>${rows.map(
      (l) => html`<tr${l.status === 'ny' ? raw(' class="row-new"') : ''}>
        <td data-label="Fra"><a href="/admin/forespoergsler/${l.id}"><strong>${l.name || l.email}</strong></a>${l.company ? html`<br><span class="small">${l.company}</span>` : ''}</td>
        <td data-label="Hvad"><span class="small muted">${LEAD_KIND_LABEL[l.kind]}</span><br>${leadSummary(l)}</td>
        <td data-label="Status">${leadBadge(l.status)}</td>
        <td data-label="Modtaget">${formatDateShort(l.created_at)}</td></tr>`,
    )}</tbody></table></div>`;
}

export function leadsPage(args: { rows: LeadRow[]; filter: string; counts: Record<string, number> }): H {
  const tabs: [string, string][] = [
    ['aabne', 'Åbne'],
    ['ny', 'Nye'],
    ['alle', 'Alle'],
    ['kunde', 'Blev kunder'],
    ['lukket', 'Lukkede'],
    ['spam', 'Spam'],
  ];
  return html`<div class="stack-lg">
  <div>${crumbs(['Admin', '/admin'])}<h1>Forespørgsler</h1>
    <p class="lead">Alt, der sendes fra hjemmesiden: kontaktformularen, gratis vurdering og kurven. Du får også en mail ved hver ny.</p></div>
  <nav class="row tabs" aria-label="Filter">${tabs.map(
    ([k, label]) => html`<a class="btn btn-small ${args.filter === k ? 'btn-primary' : 'btn-secondary'}" href="/admin/forespoergsler?status=${k}"${args.filter === k ? raw(' aria-current="page"') : ''}>${label}${k !== 'alle' && k !== 'aabne' && args.counts[k] ? ` (${args.counts[k]})` : ''}</a>`,
  )}</nav>
  <section class="card">${args.rows.length ? leadList(args.rows) : html`<p class="empty">Ingen forespørgsler her.</p>`}</section>
</div>`;
}

const FIELD_SKIP = new Set(['name', 'email', 'body', 'Formular', 'Kurv', 'Samtykke']);

export function leadDetailPage(args: { csrf: string; lead: LeadRow; flash: string | null; offerUrl: string | null; prospects?: { id: number; name: string; signals: string[]; linked: boolean }[] }): H {
  const l = args.lead;
  let fields: Record<string, string> = {};
  let cart: LeadCartLine[] = [];
  try {
    fields = JSON.parse(l.fields);
  } catch {
    /* tom */
  }
  try {
    cart = l.cart ? JSON.parse(l.cart) : [];
  } catch {
    /* tom */
  }
  const extra = Object.entries(fields).filter(([k, v]) => !FIELD_SKIP.has(k) && v);
  const total = cart.reduce((s, x) => s + x.price * x.quantity, 0);
  return html`<div class="stack-lg">
  <div>${crumbs(['Admin', '/admin'], ['Forespørgsler', '/admin/forespoergsler'], [`#${l.id}`, null])}<h1>${l.name || l.email}</h1>
    <p class="lead">${LEAD_KIND_LABEL[l.kind]}${l.form_name ? ` · ${l.form_name}` : ''} · ${formatDateTime(l.created_at)} ${leadBadge(l.status)}</p></div>
  ${args.flash === 'gemt' ? alert('ok', 'Gemt.') : ''}
  <div class="row">
    ${l.offer_id
      ? html`<a class="btn btn-secondary" href="/admin/tilbud/${l.offer_id}">Se tilbuddet</a>`
      : html`<a class="btn btn-accent" href="/admin/tilbud?forespoergsel=${l.id}">Opret tilbud med betalingslink</a>`}
    <a class="btn btn-secondary" href="mailto:${l.email}?subject=${encodeURIComponent('Din forespørgsel hos Veyro')}">Svar på mail</a>
  </div>
  <div class="grid grid-2">
    <section class="card stack">
      <h2 class="h-small" style="margin:0">Kontakt</h2>
      <dl class="facts">
        <div><dt>Navn</dt><dd>${l.name || '–'}</dd></div>
        <div><dt>E-mail</dt><dd><a href="mailto:${l.email}">${l.email}</a></dd></div>
        ${l.phone ? html`<div><dt>Telefon</dt><dd><a href="tel:${l.phone.replace(/\s+/g, '')}">${l.phone}</a></dd></div>` : ''}
        ${l.company ? html`<div><dt>Virksomhed</dt><dd>${l.company}</dd></div>` : ''}
        ${l.website ? html`<div><dt>Hjemmeside</dt><dd>${l.website}</dd></div>` : ''}
        ${l.service ? html`<div><dt>Ydelse</dt><dd>${l.service}</dd></div>` : ''}
        ${extra.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}
        <div><dt>Sendt fra</dt><dd>${l.page ?? '–'}</dd></div>
        <div><dt>Mail til jer</dt><dd>${l.notified_at ? `Sendt ${formatDateTime(l.notified_at)}` : 'Ikke sendt'}</dd></div>
      </dl>
    </section>
    <section class="card stack">
      ${cart.length
        ? html`<h2 class="h-small" style="margin:0">Kurv</h2>
          <table><tbody>${cart.map((x) => html`<tr><td>${x.quantity} × ${x.title}</td><td class="num">${formatKr(x.price * x.quantity)} ${x.interval === 'year' ? '/år' : '/md.'}</td></tr>`)}
          <tr><th scope="row">I alt (listepris inkl. moms)</th><td class="num"><strong>${formatKr(total)}</strong></td></tr></tbody></table>`
        : ''}
      <h2 class="h-small" style="margin:0">Besked</h2>
      <p class="prewrap">${l.message || '–'}</p>
    </section>
  </div>
  ${args.prospects?.length
    ? html`<section class="card stack" aria-labelledby="lp-h"><h2 id="lp-h" class="h-small" style="margin:0">Kendt som kundeemne?</h2>
        <p class="small" style="margin:0">Forespørgslen ligner et kundeemne, I allerede har. Knyt den til kundeemnet, så historikken samles. Intet knyttes automatisk.</p>
        <ul class="list">${args.prospects.map(
          (p) => html`<li class="row between"><span><a href="/admin/kundeemner/${p.id}">${p.name}</a> <span class="meta">${p.signals.join(', ')}</span></span>
            ${p.linked
              ? html`<span class="badge b-ok">Knyttet</span>`
              : html`<form method="post" action="/admin/kundeemner/${p.id}/forespoergsel" class="inline">${csrfField(args.csrf)}<input type="hidden" name="lead" value="${l.id}"><button class="btn btn-secondary btn-small" type="submit">Knyt til kundeemnet</button></form>`}</li>`,
        )}</ul></section>`
    : ''}
  <form method="post" action="/admin/forespoergsler/${l.id}" class="card stack">
    ${csrfField(args.csrf)}
    <h2 class="h-small" style="margin:0">Opfølgning</h2>
    <div class="grid grid-2">
      <div class="field"><label for="l-status">Status</label><select id="l-status" name="status">${LEAD_STATUSES.map((s) => opt(s, LEAD_STATUS_LABEL[s], s === l.status))}</select></div>
    </div>
    <div class="field"><label for="l-note">Intern note</label><textarea id="l-note" name="note" rows="3" maxlength="2000">${l.note ?? ''}</textarea></div>
    <div class="row"><button class="btn btn-primary" type="submit">Gem</button></div>
  </form>
  <form method="post" action="/admin/forespoergsler/${l.id}/slet" class="card stack">
    ${csrfField(args.csrf)}
    <h2 class="h-small" style="margin:0">Slet forespørgslen</h2>
    <p class="small muted">Sletter alle oplysninger permanent, fx hvis personen beder om det. Kan ikke fortrydes.</p>
    <label class="check"><input type="checkbox" name="confirm" value="1" required> Ja, slet permanent</label>
    <div><button class="btn btn-danger btn-small" type="submit">Slet</button></div>
  </form>
</div>`;
}
