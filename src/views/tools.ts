import { escapeHtml as e } from '../lib/email';
import { calculatePlanning, createPlanningData, createPlanningRow, planningTemplate, PLANNING_TEMPLATES, type PlanningData, type PlanningTemplateId } from '../lib/planning';
import type { ToolProject, ToolProjectSummary } from '../lib/tools-store';
import { toolsCopy, type ToolsLanguage } from './tools-copy';

export interface ToolsPageArgs {
  lang: ToolsLanguage; csrf: string; email: string | null; projects: ToolProjectSummary[];
  view: 'home' | 'workspace' | 'verify' | 'sent'; project?: ToolProject;
  error?: string; notice?: string; token?: string; devLink?: string; name?: string;
}
const query = (lang: ToolsLanguage) => `?lang=${lang}`;
const hidden = (name: string, value: unknown) => `<input type="hidden" name="${name}" value="${e(String(value ?? ''))}">`;
const arrow = '<span aria-hidden="true">↗</span>';
function icon(id: string) {
  const paths: Record<string, string> = {
    stock: '<path d="m12 3 9 5v8l-9 5-9-5V8zM3 8l9 5 9-5M12 13v8M7.5 5.5l9 5"/>',
    suppliers: '<path d="M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4"/>',
    eoq: '<path d="M4 19V5m0 14h16M6 16c3-10 8-10 12 0M6 7l12 10"/>',
    budget: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 7h8M8 11h3m3 0h2M8 15h3m3 0h2"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[id] ?? paths.stock}</svg>`;
}
const moneyFields = new Set(['lowestTotal','landedTotal','landedUnitCost','goodsCost','lineTotal','annualHoldingPerUnit','annualOrderingCost','annualHoldingCost','annualRelevantCost','goodsTotal','freightTotal','plannedTotal','budget','remaining','netUnitPrice']);
function format(value: unknown, key: string, lang: ToolsLanguage, currency: string): string {
  const t = toolsCopy(lang);
  if (value === null || value === undefined) return '—';
  if (key === 'status') return t.statuses[String(value)] ?? String(value);
  if (typeof value !== 'number') return e(String(value));
  const precision = ['annualHoldingPerUnit','landedUnitCost','netUnitPrice'].includes(key) ? 8 : moneyFields.has(key) ? 2 : ['daysCover','theoreticalEoq','ordersPerYear','utilizationPercent'].includes(key) ? 3 : 8;
  const n = new Intl.NumberFormat(lang === 'en' ? 'en-GB' : lang === 'sv' ? 'sv-SE' : 'da-DK', { maximumFractionDigits: precision }).format(value);
  return `${n}${moneyFields.has(key) ? ` <small>${currency}</small>` : key === 'utilizationPercent' ? '%' : ''}`;
}

export function planningResults(id: PlanningTemplateId, data: PlanningData, lang: ToolsLanguage, currency: string): string {
  const t = toolsCopy(lang);
  try {
    const result = calculatePlanning(id, data);
    const descriptor = planningTemplate(id);
    const primary: Record<PlanningTemplateId, string> = { stock:'orderQuantity', suppliers:'landedTotal', eoq:'orderQuantity', budget:'lineTotal' };
    const summaryKeys = descriptor.summaryFields.filter(k => k !== 'status' && k !== 'lowestSupplier');
    return `<div class="result-overview"><span class="eyebrow">${t.overview}</span><div class="metric-grid">${summaryKeys.map(k=>`<div class="metric"><span>${e(t.resultLabels[k] ?? k)}</span><strong>${format(result.summary[k],k,lang,currency)}</strong></div>`).join('')}</div></div>
      <div class="result-rows">${result.rows.map((row,i)=>`<details class="result-row" ${i === 0 ? 'open' : ''}><summary><span><small>${String(i+1).padStart(2,'0')} · ${e(String(row.unit ?? data.settings.unit ?? ''))}</small><b>${e(String(row.item ?? row.supplier ?? `${t.row} ${i+1}`))}</b>${row.status ? `<em class="status ${['safety','reorder','over_budget','missing_holding_cost'].includes(String(row.status))?'attention':''}">${e(t.statuses[String(row.status)] ?? String(row.status))}</em>` : ''}</span><span class="row-result"><small>${e(t.resultLabels[primary[id]] ?? primary[id])}</small><strong>${format(row[primary[id]],primary[id],lang,currency)}</strong></span></summary><dl>${descriptor.resultFields.filter(k=>k !== primary[id] && k !== 'status').map(k=>`<div><dt>${e(t.resultLabels[k] ?? k)}</dt><dd>${format(row[k],k,lang,currency)}</dd></div>`).join('')}</dl></details>`).join('')}</div>`;
  } catch {
    return `<div class="result-empty"><span class="result-empty-icon">${icon(id)}</span><p>${t.noResults}</p><small>${t.errors.invalidInput}</small></div>`;
  }
}

function signIn(a: ToolsPageArgs) {
  const t = toolsCopy(a.lang);
  return `<section class="join-panel" id="account"><div><span class="eyebrow">${t.account}</span><h2>${t.signInTitle}</h2><p>${t.signInDescription}</p><div class="join-detail"><span aria-hidden="true">✓</span>${t.freeNote}</div><div class="join-detail"><span aria-hidden="true">✓</span>${t.noPassword}</div></div><form action="/tools/sign-in" method="post" class="join-form">${hidden('_csrf',a.csrf)}${hidden('lang',a.lang)}<label>${t.yourName}<input name="name" autocomplete="name" maxlength="100" value="${e(a.name ?? '')}" required></label><label>${t.email}<input name="email" type="email" autocomplete="email" maxlength="254" required></label><button class="button primary" type="submit">${t.sendLink}${arrow}</button><p class="fine">${t.noPayment} <a href="https://veyro.dk/${a.lang === 'da' ? '' : a.lang+'/'}pages/privatlivspolitik">${t.privacyPolicy}</a>.</p></form></section>`;
}

function library(a: ToolsPageArgs) {
  const t = toolsCopy(a.lang);
  return `<section class="library" id="templates"><div class="section-heading"><div><span class="eyebrow">01 / ${t.library}</span><h2>${t.chooseTemplate}</h2></div><p>${t.freeNote}</p></div><div class="template-list">${PLANNING_TEMPLATES.map((d,i)=>{const c=t.templates[d.id];return `<article class="template-item"><span class="template-icon">${icon(d.id)}</span><div class="template-title"><span class="eyebrow">${String(i+1).padStart(2,'0')} / ${e(c.category)}</span><h3>${e(c.title)}</h3></div><p>${e(c.description)}</p>${a.email ? `<form action="/tools/projects" method="post">${hidden('_csrf',a.csrf)}${hidden('lang',a.lang)}${hidden('templateId',d.id)}${hidden('name',c.title)}<button class="template-action" type="submit" aria-label="${e(t.useTemplate+': '+c.title)}">${t.useTemplate}${arrow}</button></form>` : `<a class="template-action" href="#account">${t.useTemplate}${arrow}</a>`}</article>`;}).join('')}</div></section>`;
}

function projects(a: ToolsPageArgs) {
  const t = toolsCopy(a.lang);
  const renderList = (list: ToolProjectSummary[], archived: boolean) => list.map(p=>`<article class="project-item"><span class="project-icon">${icon(p.templateId)}</span><a class="project-name" href="/tools/projects/${p.id}${query(a.lang)}"><strong>${e(p.name)}</strong><span>${e(t.templates[p.templateId].title)} · ${t.updated} ${new Intl.DateTimeFormat(a.lang,{dateStyle:'medium'}).format(new Date(p.updatedAt*1000))}</span></a><a class="text-link" href="/tools/projects/${p.id}${query(a.lang)}">${t.open}${arrow}</a><form method="post" action="/tools/projects/${p.id}/${archived?'restore':'archive'}">${hidden('_csrf',a.csrf)}${hidden('lang',a.lang)}${hidden('version',p.version)}<button class="quiet-button">${archived?t.restore:t.archive}</button></form></article>`).join('');
  const active = a.projects.filter(p=>!p.archivedAt), archived = a.projects.filter(p=>p.archivedAt);
  return `<section id="plans" class="plans"><div class="section-heading"><div><span class="eyebrow">${t.privateLabel}</span><h1>${t.savedPlans}<span class="count">${active.length}</span></h1></div><a class="button primary" href="#templates">${t.newPlan}<span aria-hidden="true">+</span></a></div>${active.length?`<div class="project-list">${renderList(active,false)}</div>`:`<div class="empty-plans"><span>${icon('stock')}</span><div><h2>${t.noProjects}</h2><p>${t.noProjectsDescription}</p></div></div>`}<details class="archived"><summary>${t.archivedPlans} <span>${archived.length}</span></summary>${archived.length?renderList(archived,true):`<p>${t.noArchived}</p>`}</details><p class="fine">${t.capacityNote}</p></section>`;
}

function home(a: ToolsPageArgs) {
  const t = toolsCopy(a.lang);
  const sample = calculatePlanning('stock',createPlanningData('stock')).rows[0]!;
  const hero = `<section class="tools-hero"><div class="hero-copy"><span class="eyebrow"><i></i>${t.heroEyebrow}</span><h1>${t.heroTitle}<br><em>${t.heroAccent}</em></h1><p>${t.heroDescription}</p><div class="hero-actions"><a class="button primary" href="#account">${t.createAccount}${arrow}</a><a class="text-link" href="#templates">${t.browseTemplates}<span aria-hidden="true">↓</span></a></div><span class="fine">${t.freeNote}</span></div><div class="hero-sheet" aria-label="${e(t.sampleData)}"><div class="sheet-top"><span><i></i>${t.templates.stock.title}</span><span>V.</span></div><div class="sheet-heading"><span class="eyebrow">${t.sampleData}</span><h2>${t.templates.stock.benefit}</h2></div><div class="sheet-grid"><div><span>${t.fields.onHand}</span><strong>${sample.onHand}</strong></div><div><span>${t.resultLabels.reorderPoint ?? 'Reorder point'}</span><strong>${sample.reorderPoint}</strong></div><div><span>${t.fields.packSize}</span><strong>${sample.packSize}</strong></div></div><div class="sheet-graph" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><b></b></div><div class="sheet-answer"><span>${t.resultLabels.orderQuantity ?? 'Suggested order'}</span><strong>${sample.orderQuantity}<small>${t.units}</small></strong><span class="round-arrow">↗</span></div><div class="sheet-foot">${t.howCalculated}<span>ƒ(x)</span></div></div></section>`;
  return `${a.email?projects(a):hero}${library(a)}${a.email?`<div class="workspace-note"><span>${icon('stock')}</span><p>${t.privacyDescription}<br>${t.savingDescription}</p></div>`:`<section class="how-it-works">${[[t.stepOneTitle,t.stepOneDescription],[t.stepTwoTitle,t.stepTwoDescription],[t.stepThreeTitle,t.stepThreeDescription]].map(([title,desc],i)=>`<div><span>0${i+1}</span><h3>${title}</h3><p>${desc}</p></div>`).join('')}</section>${signIn(a)}`}`;
}

function workspace(a: ToolsPageArgs) {
  const p=a.project!, t=toolsCopy(a.lang), d=planningTemplate(p.templateId), c=t.templates[p.templateId];
  function field(f: typeof d.fields[number], value: unknown, area: 'row'|'setting', suffix: string) {
    const label=t.fields[f.key] ?? f.key;
    return `<label for="${suffix}-${f.key}">${e(label)}<input id="${suffix}-${f.key}" data-${area}-field="${f.key}" type="${f.type==='number'?'number':'text'}" ${f.type==='number'?`step="${f.step??'any'}" min="${f.min??0}" max="${f.max??1000000000}" inputmode="decimal"`:'maxlength="100"'} value="${e(String(value??''))}" required></label>`;
  }
  function row(data: Record<string,string|number>, i: number, blank=false) {
    return `<details class="input-row" data-input-row ${i===0?'open':''}><summary><span class="row-index">${String(i+1).padStart(2,'0')}</span><span data-row-title>${e(String(data.item??data.supplier??`${t.row} ${i+1}`))}</span><span class="row-toggle" aria-hidden="true">+</span></summary><div class="input-row-body"><div class="fields-grid">${d.fields.map(f=>field(f,data[f.key],'row',blank?'new':`row-${i}`)).join('')}</div><button type="button" class="remove-row" data-remove-row>${t.removeRow}<span aria-hidden="true">−</span></button></div></details>`;
  }
  return `<div class="workspace-top"><a class="text-link" href="/tools${query(a.lang)}">← ${t.back}</a><span>${t.privateLabel}</span></div><div class="workspace-title"><span class="template-icon">${icon(p.templateId)}</span><div><span class="eyebrow">${c.category}</span><h1>${e(p.name)}</h1><p>${e(c.description)}</p></div></div>
  ${p.archivedAt?`<div class="notice">${t.archivedReadOnly}<form method="post" action="/tools/projects/${p.id}/restore">${hidden('_csrf',a.csrf)}${hidden('lang',a.lang)}${hidden('version',p.version)}<button class="button small">${t.restore}</button></form></div>`:''}
  <form method="post" action="/tools/projects/${p.id}/save" data-editor data-dirty="${a.error?'1':'0'}" data-max-rows="${d.maxRows}" data-unsaved="${e(t.unsaved)}" data-invalid="${e(t.errors.invalidInput)}" data-connection="${e(t.errors.saveFailed)}" data-row-label="${e(t.row)}" data-new-supplier="${e(t.fields.supplier!)}" data-new-item="${e(t.fields.item!)}" data-disabled="${p.archivedAt?'1':'0'}">
    ${hidden('_csrf',a.csrf)}${hidden('lang',a.lang)}${hidden('templateId',p.templateId)}${hidden('version',p.version)}${hidden('data',JSON.stringify(p.data))}
    <div class="editor-toolbar"><label>${t.workspaceName}<input name="name" value="${e(p.name)}" maxlength="100" required ${p.archivedAt?'disabled':''}></label><label class="currency-select">${t.currency}<select name="currency" ${p.archivedAt?'disabled':''}>${['DKK','EUR','SEK'].map(cur=>`<option value="${cur}" ${p.currency===cur?'selected':''}>${cur}</option>`).join('')}</select></label><div class="save-area"><span data-save-state role="status">${a.error?t.unsaved:t.saved} · v${p.version}</span><button class="button primary" type="submit" ${p.archivedAt?'disabled':''}>${t.save}<span aria-hidden="true">↑</span></button></div></div>
    <p class="fine currency-hint">${t.currencyHint}</p><noscript><p class="error">${t.jsRequired}</p><style>.editor-fields,.save-area button{display:none}</style></noscript>
    <div class="editor-grid"><section class="editor-fields" aria-label="${t.inputs}"><div class="panel-heading"><h2>${t.inputs}</h2><span>${t.templates[p.templateId].category}</span></div><p class="fine">${t.unitsHint}</p><fieldset ${p.archivedAt?'disabled':''}>
    ${d.settingsFields.length?`<div class="settings-fields"><h3>${t.settings}</h3><div class="fields-grid">${d.settingsFields.map(f=>field(f,p.data.settings[f.key],'setting','setting')).join('')}</div></div>`:''}
    <div data-input-rows>${p.data.rows.map((r,i)=>row(r,i)).join('')}</div><button type="button" class="add-row" data-add-row ${p.archivedAt?'disabled':''}>+ ${t.addRow}</button></fieldset><template data-row-template>${row(createPlanningRow(p.templateId),0,true)}</template><p class="fine">${t.capacityNote}</p></section>
    <aside class="results-panel"><div class="panel-heading"><h2>${t.results}</h2><span class="live-dot" aria-hidden="true"></span></div><div data-preview-status role="status"></div><div data-results>${planningResults(p.templateId,p.data,a.lang,p.currency)}</div></aside></div>
    <div class="editor-bottom"><span>${t.updated} ${new Intl.DateTimeFormat(a.lang,{dateStyle:'medium',timeStyle:'short'}).format(new Date(p.updatedAt*1000))}</span>${!p.archivedAt?`<button class="text-link" type="submit" formaction="/tools/projects/${p.id}/duplicate">${t.saveCopy}${arrow}</button>`:''}<a class="text-link" href="/tools/projects/${p.id}${query(a.lang)}">${t.reloadLatest} ↻</a></div>
  </form><section class="calculation-guide"><div><span class="eyebrow">ƒ(x)</span><h2>${t.howCalculated}</h2></div><div><p>${e(c.guide)}</p><details><summary>${t.assumptions}</summary><p>${e(c.assumptions)}</p></details></div></section>`;
}

export function toolsPage(a: ToolsPageArgs): string {
  const t=toolsCopy(a.lang), base=`/tools${query(a.lang)}`;
  const current=a.view==='workspace'&&a.project?`/tools/projects/${a.project.id}`:'/tools';
  let body='';
  if(a.view==='home') body=home(a);
  if(a.view==='workspace'&&a.project) body=workspace(a);
  if(a.view==='verify') body=`<section class="auth-panel"><span class="auth-icon">↗</span><span class="eyebrow">${t.brand}</span><h1>${t.verifyTitle}</h1><p>${t.verifyDescription}</p><form method="post" action="/tools/verify">${hidden('_csrf',a.csrf)}${hidden('lang',a.lang)}${hidden('token',a.token)}<button class="button primary">${t.verify}${arrow}</button></form><a class="text-link" href="${base}#account">${t.backToSignIn}</a></section>`;
  if(a.view==='sent') body=`<section class="auth-panel"><span class="auth-icon">↗</span><span class="eyebrow">${t.brand}</span><h1>${t.checkEmail}</h1><p>${t.checkEmailDescription}</p>${a.devLink?`<a class="button primary" href="${e(a.devLink)}">DEV: ${t.verify}</a>`:''}<a class="text-link" href="${base}#account">${t.backToSignIn} →</a></section>`;
  return `<!doctype html><html lang="${a.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#f4f2ec"><title>${e(a.project?.name??t.brand)} · Veyro</title><meta name="description" content="${e(t.heroDescription)}"><link rel="icon" href="/favicon.svg"><link rel="preload" href="/static/inter-tight.woff2" as="font" type="font/woff2" crossorigin><link rel="stylesheet" href="/static/tools.css?v=1"><script src="/static/tools.js?v=1" defer></script></head><body><a class="skip-link" href="#main">${t.skipContent}</a><header class="tools-header"><a class="tools-brand" href="${base}" aria-label="Veyro Tools"><span class="brand-mark">V<span>.</span></span><span>Veyro<small>Tools</small></span></a><nav aria-label="${t.library}"><a href="${base}#templates">${t.library}</a>${a.email?`<a href="${base}#plans">${t.myWorkspace}</a>`:''}</nav><div class="header-actions"><div class="language-switch" aria-label="${t.language}">${(['da','en','sv'] as const).map(l=>`<a href="${current}${query(l)}" lang="${l}" aria-label="${l==='da'?'Dansk':l==='sv'?'Svenska':'English'}" ${a.lang===l?'aria-current="true"':''}>${l.toUpperCase()}</a>`).join('')}</div>${a.email?`<form action="/tools/logout" method="post">${hidden('_csrf',a.csrf)}${hidden('lang',a.lang)}<button class="quiet-button">${t.logout} ↗</button></form>`:`<a class="button small" href="${base}#account">${t.signIn} ↗</a>`}</div></header><main id="main" class="tools-main ${a.view==='workspace'?'workspace':''}">${a.error?`<div class="error" role="alert">${e(a.error)}</div>`:''}${a.notice?`<div class="notice" role="status">${e(a.notice)}</div>`:''}${body}</main><footer class="tools-footer"><a class="footer-brand" href="https://veyro.dk/${a.lang==='da'?'':a.lang+'/'}">Veyro<span>.</span></a><p>${a.email?e(a.email):t.freeNote}</p><nav><a href="https://veyro.dk/${a.lang==='da'?'':a.lang+'/'}pages/privatlivspolitik">${t.privacyPolicy}</a><a href="mailto:kontakt@veyro.dk">${t.contact} ↗</a></nav></footer></body></html>`;
}
