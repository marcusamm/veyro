import {escape as e} from './charts.mjs';

import {formatInputValue} from './input-format.mjs';
const numberText=value=>formatInputValue(value??'');
const field=(key,label,hint,value='',unit='dage')=>`<label class="field"><span>${label}</span><span class="input-wrap"><input data-capital-field="${key}" type="text" inputmode="decimal" value="${e(numberText(value))}" autocomplete="off" required><span class="unit">${unit}</span></span><small>${hint}</small></label>`;
const choice=(key,label,options,value='',hint='')=>`<label class="field"><span>${label}</span><select data-capital-field="${key}" required>${[['','Vælg…'],...options].map(([v,t])=>`<option value="${e(v)}"${v===value?' selected':''}>${e(t)}</option>`).join('')}</select><small>${hint}</small></label>`;

export function capitalActivation(){
  return `<section class="capital-activation" aria-labelledby="capital-heading"><div><span class="eyebrow">Valgfrit · løbende vareindkøb</span><h3 id="capital-heading">Kapitalbinding og betaling</h3><p>Sammenlign også, hvor længe dine penge er bundet. En gennemsnitsmodel for stabilt vareflow, med 365 kalenderdage pr. år.</p></div><label class="capital-toggle"><input id="capital-enabled" type="checkbox" aria-controls="capital-common"><span>Medtag kapitalbinding og betalingsvilkår</span></label><div id="capital-common" hidden>${field('annualRatePercent','Fælles årlig kapitalrente','Din egen finansierings- eller kalkulationsrente. Fx 10 for 10 %. Ingen markedsrente er forudfyldt.','','%')}<p class="callout">Er kapitalrente allerede med i en lageromkostning? Udskil rentekomponenten nedenfor, eller vælg at undlade det nye tillæg. Sikkerhedslager, der allerede er afspejlet i den gennemsnitlige lagertid, skal ikke med igen.</p></div><button type="button" class="text-button" id="capital-example">Prøv et eksempel med betalingsvilkår ↙</button></section>`;
}

export function capitalAlternative(a){
  const c=a.capital??{};
  const rows=(a.costs??[]).map((row,i)=>[String(row.id??i),row.label||`Post ${i+1}`]);
  return `<fieldset class="capital-alternative" data-capital-controls hidden><legend>Kapitalbinding og betaling</legend><div class="field-grid">${choice('purchaseCostId','Hvilken post er varens indkøbspris?',rows.filter((_,i)=>a.costs[i].frequency==='unit'),c.purchaseCostId,'Vælg den rene indkøbspris pr. enhed fra posterne ovenfor. Fragt og øvrige omkostninger indgår ikke i kapitalgrundlaget.')}${field('leadDays','Leveringstid / lead time','Kalenderdage fra bestilling til modtagelse.',c.leadDays)}${choice('paymentStart','Betalingsfristens start',[['order','Ved bestilling'],['receipt','Ved modtagelse'],['other','Andet tidspunkt']],c.paymentStart,'Hvornår begynder leverandørens betalingsfrist?')}<div data-capital-other hidden>${field('paymentStartDays','Andet starttidspunkt','Antal dage efter bestilling, fx fakturering eller afsendelse.',c.paymentStartDays)}</div>${field('supplierCreditDays','Leverandørens kredittid','Dage fra fristens start til betaling. Forudbetaling ved bestilling: vælg bestilling og 0 dage.',c.supplierCreditDays)}${field('inventoryDays','Gennemsnitlig lagertid','Dage fra modtagelse til salg, inklusive produktion. Brug gennemsnittet, ikke tiden til sidste vare er solgt.',c.inventoryDays)}${field('customerCreditDays','Kundernes kredittid','Dage fra salg til kundens betaling. Skriv 0 ved betaling med det samme.',c.customerCreditDays)}</div><div class="capital-interest">${choice('interestMode','Sådan håndteres kapitalomkostningen',[['add','Tilføj — ingen kapitalrente i de øvrige poster'],['replace','Udskil eksisterende rente og erstat med estimatet'],['skip','Vis estimatet, men undlad det nye tillæg']],c.interestMode,'Vælg aktivt, så den samme rente ikke tælles to gange.')}<div class="field-grid" data-capital-replace hidden>${choice('existingInterestCostId','Post med eksisterende kapitalrente',rows,c.existingInterestCostId,'Den eksisterende post bliver bevaret. Kun rentekomponenten nedenfor trækkes fra i sammenligningen.')}${field('existingInterestAnnual','Eksisterende rentekomponent pr. år','Angiv kun rentedelen, der allerede indgår i den valgte post, omregnet til ét år.',c.existingInterestAnnual,'kr./år')}</div></div></fieldset>`;
}

export function syncCapital(form){
  const enabled=form.querySelector('#capital-enabled').checked;
  form.querySelector('#capital-common').hidden=!enabled;
  const common=form.querySelector('[data-capital-field="annualRatePercent"]');
  common.disabled=!enabled;
  common.id='capital-rate';common.closest('label').htmlFor=common.id;
  const hint=common.closest('label').querySelector('small');hint.id='capital-rate-hint';common.setAttribute('aria-describedby',hint.id);
  form.querySelectorAll('[data-alternative]').forEach((alt,index)=>{
    const block=alt.querySelector('[data-capital-controls]');block.hidden=!enabled;
    const get=key=>alt.querySelector(`[data-capital-field="${key}"]`);
    const costs=[...alt.querySelectorAll('[data-cost]')].map((row,i)=>({id:row.dataset.costId,label:row.querySelector('.cost-label').value||`Post ${i+1}`,frequency:row.querySelector('.cost-frequency').value}));
    for(const key of ['purchaseCostId','existingInterestCostId']){
      const select=get(key),value=select.value;
      select.innerHTML='<option value="">Vælg en omkostningspost…</option>'+costs.filter(row=>key!=='purchaseCostId'||row.frequency==='unit').map(row=>`<option value="${e(row.id)}">${e(row.label)}</option>`).join('');
      select.value=costs.some(row=>row.id===value&&(key!=='purchaseCostId'||row.frequency==='unit'))?value:'';
    }
    alt.querySelector('[data-capital-other]').hidden=get('paymentStart').value!=='other';
    alt.querySelector('[data-capital-replace]').hidden=get('interestMode').value!=='replace';
    block.querySelectorAll('[data-capital-field]').forEach(field=>{
      field.disabled=!!field.closest('[hidden]');field.id=`capital-${index}-${field.dataset.capitalField}`;
      const label=field.closest('label'),hint=label.querySelector('small');label.htmlFor=field.id;
      hint.id=`${field.id}-hint`;field.setAttribute('aria-describedby',hint.id);
    });
  });
}

export function readCapital(alt){
  return Object.fromEntries([...alt.querySelectorAll('[data-capital-field]')].filter(field=>!field.disabled).map(field=>[field.dataset.capitalField,field.value]));
}

export function loadCapital(form,data){
  form.querySelector('#capital-enabled').checked=!!data.capital;
  form.querySelector('[data-capital-field="annualRatePercent"]').value=numberText(data.capital?.annualRatePercent);
}

const fmt=value=>new Intl.NumberFormat('da-DK',{maximumFractionDigits:2}).format(value);
const money=value=>`${fmt(value)} kr.`;
export function capitalResult(alt){
  const c=alt.capital;if(!c)return '';
  const metric=(label,value)=>`<div><dt>${label}</dt><dd>${value}</dd></div>`;
  const names={order:'Bestilling',receipt:'Modtagelse',supplier:'Leverandørbetaling',customer:'Forventet kundebetaling'};
  return `<div class="capital-results"><h4>Kapital og betalingsforløb</h4><dl class="result-metrics">${metric('TCO før kapitalomkostning',money(c.totalBeforeCapital))}${metric('Årligt varekøb',money(c.annualPurchase))}${metric('Nettokapitalbindingsdage',`${fmt(c.netDays)} dage`)}${metric('Gennemsnitlig nettokapitalbinding',money(c.averageCapital))}${metric('Estimeret kapitalomkostning pr. år',money(c.annualCost))}${metric('Estimeret kapitalomkostning i perioden',money(c.periodCost))}</dl>${c.removedInterest>0?`<p class="fine">Eksisterende TCO: ${money(alt.totalCost)} Herfra udskilles ${money(c.removedInterest)} i eksisterende rente for hele perioden, før det nye tillæg medregnes.</p>`:''}${c.interestMode==='skip'?'<p class="callout">Det nye tillæg er fravalgt. Estimatet vises til orientering og indgår ikke i samlet TCO.</p>':''}${c.netDays<0?'<p class="capital-benefit">En fordel ved betalingsvilkårene: kunderne betaler i gennemsnit før leverandøren. Kapitalomkostningen er 0 kr.; modellen beregner ingen renteindtægt.</p>':''}<ol class="payment-timeline" aria-label="Betalingsforløb i kronologisk rækkefølge">${c.timeline.map(event=>`<li class="event-${event.kind}"><span class="timeline-dot" aria-hidden="true"></span><strong>Dag ${fmt(event.day)}</strong><span>${names[event.kind]}</span></li>`).join('')}</ol><p class="fine">Bestilling er dag 0. Tidspunkterne vises i rækkefølge; afstanden på linjen er ikke målfast. Kundebetalingen er et gennemsnit.</p><div class="capital-total"><span>Samlet TCO inklusive valgt kapitaltillæg</span><strong>${money(alt.comparisonTotalCost)}</strong></div></div>`;
}

export const capitalMethod=`<details class="capital-method" open><summary>Kapitalbinding og betaling · sådan beregner vi</summary><div class="prose"><p>Valgfri gennemsnitsmodel for stabile, løbende vareindkøb. Alle tidspunkter regnes i kalenderdage fra bestilling på dag 0.</p><dl><dt>Leverandørbetaling</dt><dd>Betalingsfristens startdag + leverandørens kredittid. Startdagen er 0 ved bestilling, leveringstiden ved modtagelse eller dit eget antal dage.</dd><dt>Forventet kundebetaling</dt><dd>Leveringstid + gennemsnitlig lagertid + kundernes kredittid.</dd><dt>Nettokapitalbindingsdage</dt><dd>Forventet kundebetaling − leverandørbetaling.</dd><dt>Gennemsnitlig nettokapitalbinding</dt><dd>Årlig mængde × valgt indkøbspris pr. enhed × nettokapitalbindingsdage / 365.</dd><dt>Kapitalomkostning</dt><dd>Positiv gennemsnitlig nettokapitalbinding × årlig kapitalrente / 100. Årsbeløbet ganges med antal år og lægges til TCO, medmindre tillægget er fravalgt. Ved udskillelse fratrækkes først den eksisterende rentekomponent for perioden.</dd></dl><p>Selve den bundne kapital lægges aldrig til TCO. Negative kapitalbindingsdage er en betalingsfordel; kapitalomkostningen sættes til 0 uden beregnet renteindtægt. Sikkerhedslager, der allerede er med i lagertiden, lægges ikke til igen.</p><p>Modellen estimerer kun finansieringen af varekøbet. Den viser ikke virksomhedens fulde arbejdskapital, maksimale lånebehov eller en præcis likviditetsprognose. TCO er fortsat udiskonteret med et særskilt kapitaltillæg; der beregnes ikke nutidsværdi.</p></div></details>`;
