import {initTransportCalculator} from './transport-ui.mjs';
import {TRANSPORT_IDS} from './transport-contract.mjs';
import {syncCapital,readCapital,loadCapital,capitalResult} from './tco-capital-ui.mjs';
import {eoq,rop,tco,abc,SAMPLES,MAX_ABC_ROWS,MAX_TCO_COSTS,TCO_CAPITAL_SAMPLE,CalculationError} from './calculations.mjs';
import {previewImport,exportABC} from './import.mjs';
import {searchTools} from './search.mjs';
import {escape as e,lineChart,ropChart,paretoChart} from './charts.mjs';
import {alternative,costRow,abcRow,formatInputValue as inputValue} from './forms.mjs';
import {sitePath} from './paths.mjs';
import {connectCalculator} from './account.mjs';

const $=(selector,root=document)=>root.querySelector(selector);
const $$=(selector,root=document)=>[...root.querySelectorAll(selector)];
export function formatNumber(value,digits=2){
  if(value===null||value===undefined||!Number.isFinite(value))return '—';
  const magnitude=Math.abs(value);
  // A small valid quantity or unit cost must never appear as zero.
  if(magnitude>0&&magnitude<1e-12)return new Intl.NumberFormat('da-DK',{notation:'scientific',maximumFractionDigits:4}).format(value);
  const precision=magnitude>0&&magnitude<10**-digits?Math.min(12,Math.ceil(-Math.log10(magnitude))+2):digits;
  return new Intl.NumberFormat('da-DK',{maximumFractionDigits:precision}).format(value);
}
const fmt=formatNumber;
const money=(value,digits=2)=>`${fmt(value,digits)} kr.`;

// Search stays entirely on the device. Links remain normal links for mouse/touch.
const search=typeof document==='undefined'?null:$('#tool-search');
if(search){
  const list=$('#search-results');let matches=[],active=-1;
  const close=()=>{list.hidden=true;search.setAttribute('aria-expanded','false');search.removeAttribute('aria-activedescendant');active=-1;};
  const activate=index=>{active=index;$$('[role=option]',list).forEach((a,i)=>a.setAttribute('aria-selected',String(i===index)));if(index>=0)search.setAttribute('aria-activedescendant',`suggestion-${index}`);else search.removeAttribute('aria-activedescendant');};
  const update=()=>{
    const query=search.value.trim();matches=searchTools(query);active=-1;
    if(!query){close();$('#search-status').textContent='';return;}
    list.innerHTML=matches.length?matches.map(({tool,reason},i)=>`<a id="suggestion-${i}" role="option" aria-selected="false" href="${sitePath(tool.path)}"><span class="search-type">Beregner + Excel-skabelon · ${e(tool.category)}</span><strong>${e(tool.title)} ↗</strong><small>${e(tool.description)}</small><small>${e(reason)}</small></a>`).join(''):`<div class="no-results">Ingen sikre match. Prøv <strong>lager, bestilling, omkostninger eller ABC</strong> — eller <a href="${sitePath('/vaerktoejer/')}">se alle værktøjer</a>.</div>`;
    list.hidden=false;search.setAttribute('aria-expanded','true');search.removeAttribute('aria-activedescendant');$('#search-status').textContent=`${matches.length} relevante værktøjer.`;
  };
  search.addEventListener('input',update);search.addEventListener('focus',()=>{if(search.value.trim())update();});
  search.addEventListener('keydown',event=>{
    if(event.key==='Escape'){close();return;}
    if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();if(list.hidden)update();if(matches.length)activate(event.key==='ArrowDown'?(active+1)%matches.length:active<0?matches.length-1:(active-1+matches.length)%matches.length);}
    if(event.key==='Enter'&&matches.length){event.preventDefault();location.assign(sitePath(matches[Math.max(0,active)].tool.path));}
  });
  document.addEventListener('pointerdown',event=>{if(!$('#search').contains(event.target))close();});
  $('#search').addEventListener('focusout',event=>{if(!$('#search').contains(event.relatedTarget))close();});
  $$('[data-query]').forEach(button=>{button.disabled=false;button.addEventListener('click',()=>{search.value=button.dataset.query;search.focus();update();});});
  search.disabled=false;
}

const form=typeof document==='undefined'?null:$('#calculator');
if(form){if(TRANSPORT_IDS.includes(form.dataset.tool))initTransportCalculator(form.dataset.tool);else initCalculator(form.dataset.tool);}

function initCalculator(id){
  const resultBox=$('#results'),panel=$('#result-panel'),status=$('#result-status'),errors=$('#input-errors');
  const blankResult=resultBox.innerHTML;
  let currentResult=null,isExample=false,preview=null,abcSort={key:'annualValue',direction:-1};
  let importGeneration=0;
  const blankAlternative=()=>({id:crypto.randomUUID(),name:'',ordersPerYear:'',residualValue:0,costs:[{id:crypto.randomUUID(),label:'Indkøbspris',amount:'',frequency:'unit'}]});
  const setValues=data=>Object.entries(data).forEach(([name,value])=>{const field=form.elements.namedItem(name);if(field&&!Array.isArray(value)&&typeof value!=='object')field.value=inputValue(value);});
  const renderAlternatives=list=>{$('[data-alternatives]').innerHTML=list.map(alternative).join('');updateLimits();};
  const renderItems=items=>{$('[data-items]').innerHTML=items.map(abcRow).join('');updateLimits();};
  function updateLimits(){
    if(id==='tco'){
      $('#add-alternative').disabled=$$('[data-alternative]').length>=3;
      $$('[data-alternative]').forEach((alt,index)=>{
        $('legend',alt).textContent=`Alternativ ${index+1}`;
        // Reindex the remaining rows before another row is appended. Otherwise
        // removing the first alternative creates duplicate IDs/label targets.
        for(const [selector,prefix] of [['.alt-orders','orders'],['.alt-residual','residual']]){
          const field=$(selector,alt),label=field.closest('label'),hint=$('small',label),key=`${prefix}-${index}`;
          field.id=key;field.name=key;label.htmlFor=key;
          if(hint){hint.id=`${key}-hint`;field.setAttribute('aria-describedby',hint.id);}
        }
        $('.remove-alternative',alt).disabled=$$('[data-alternative]').length<=1;$('.add-cost',alt).disabled=$$('[data-cost]',alt).length>=MAX_TCO_COSTS;$$('.remove-cost',alt).forEach(b=>b.disabled=$$('[data-cost]',alt).length<=1);
      });
      syncCapital(form);
    }
    if(id==='abc'){
      const items=$$('[data-item]');$('#add-item').disabled=items.length>=MAX_ABC_ROWS;
      items.forEach((row,index)=>{
        const labels=['Varenummer eller navn','Årligt forbrug','Indkøbspris'];
        $$('label .sr-only',row).forEach((label,fieldIndex)=>label.textContent=`${labels[fieldIndex]}, række ${index+1}`);
        const remove=$('.remove-item',row);remove.disabled=items.length<=1;remove.setAttribute('aria-label',`Fjern vare ${index+1}`);
      });
    }
  }
  function updateModes(){
    if(id==='tco'){syncCapital(form);return;}
    if(id!=='genbestilling')return;
    $$('[data-mode]').forEach(block=>block.hidden=block.dataset.mode!==$('#mode').value);
    $$('[data-safety]').forEach(block=>block.hidden=block.dataset.safety!==$('#safetyMode').value);
    $$('[data-mode] input,[data-mode] select').forEach(field=>field.disabled=Boolean(field.closest('[hidden]')));
  }
  function invalidate(){
    form.dispatchEvent(new Event('calculatorchange'));
    if(currentResult){panel.classList.add('stale');status.textContent='Dine input er ændret. Tryk Beregn for at opdatere resultatet.';$('#print-result').hidden=true;$$('button',resultBox).forEach(b=>b.disabled=true);}
    isExample=false;$('#data-note').textContent='Dine egne input. Tal skrives dansk, fx 1.234,56. Beregningen foregår i browseren. Kun et tryk på Gem gemmer på din konto.';
  }
  const resetErrors=()=>{errors.hidden=true;errors.textContent='';$$('[aria-invalid]',form).forEach(el=>el.removeAttribute('aria-invalid'));};
  function showError(problem){
    errors.hidden=false;errors.textContent=problem instanceof CalculationError?problem.message:'Oplysningerne kunne ikke beregnes. Kontrollér dine input.';
    let target=form.elements.namedItem(problem.path);
    const parts=(problem.path||'').split('.');
    if(parts[0]==='capital')target=form.querySelector('[data-capital-field="annualRatePercent"]');
    if(parts[0]==='alternatives'){
      const alt=$$('[data-alternative]')[Number(parts[1])];
      if(alt){if(parts[2]==='capital')target=alt.querySelector(`[data-capital-field="${parts[3]}"]`);else if(parts[2]==='costs'){const row=$$('[data-cost]',alt)[Number(parts[3])];target=row&&$({label:'.cost-label',amount:'.cost-amount',frequency:'.cost-frequency'}[parts[4]]||'input',row);}else target=$({name:'.alt-name',ordersPerYear:'.alt-orders',residualValue:'.alt-residual'}[parts[2]]||'input',alt);}
    }
    if(parts[0]==='items'){const row=$$('[data-item]')[Number(parts[1])];if(row)target=$({name:'.item-name',annualQuantity:'.item-quantity',unitCost:'.item-cost'}[parts[2]]||'input',row);}
    if(target&&!target.disabled){target.setAttribute('aria-invalid','true');target.focus();}else{errors.tabIndex=-1;errors.focus();}
  }
  function readData(){
    const data=Object.fromEntries(new FormData(form));
    if(id==='tco'){
      const enabled=$('#capital-enabled').checked;
      if(enabled)data.capital={annualRatePercent:$('[data-capital-field="annualRatePercent"]').value};
      data.alternatives=$$('[data-alternative]').map(alt=>({id:alt.dataset.id,name:$('.alt-name',alt).value,ordersPerYear:$('.alt-orders',alt).value,residualValue:$('.alt-residual',alt).value,costs:$$('[data-cost]',alt).map(row=>({id:row.dataset.costId,label:$('.cost-label',row).value,amount:$('.cost-amount',row).value,frequency:$('.cost-frequency',row).value})),...(enabled?{capital:readCapital(alt)}:{})}));
    }
    if(id==='abc')data.items=$$('[data-item]').map(row=>({name:$('.item-name',row).value,annualQuantity:$('.item-quantity',row).value,unitCost:$('.item-cost',row).value}));
    return data;
  }
  function calculate(){
    resetErrors();
    try{
      const data=readData();currentResult=({eoq,genbestilling:rop,tco,abc})[id](data);panel.classList.remove('stale');
      resultBox.innerHTML=({eoq:renderEOQ,genbestilling:renderROP,tco:renderTCO,abc:renderABC})[id](currentResult,data)+renderWarnings(currentResult.warnings,currentResult);
      if(id==='abc'){abcSort={key:'annualValue',direction:-1};renderABCTable();}
      status.textContent=isExample?'Beregnet med fiktive eksempeldata. Udskift dem med dine egne tal.':'Beregnet med dine input. Kontrollér forudsætningerne nedenfor.';
      $('#print-result').hidden=false;
    }catch(problem){currentResult=null;panel.classList.remove('stale');resultBox.innerHTML=blankResult;status.textContent='Intet gyldigt resultat endnu.';$('#print-result').hidden=true;showError(problem);}
  }
  function initialize(){
    if(id==='tco'){loadCapital(form,{});renderAlternatives([blankAlternative(),blankAlternative()]);}
    if(id==='abc')renderItems([{name:'',annualQuantity:'',unitCost:''}]);
    updateModes();
  }
  initialize();
  form.addEventListener('submit',event=>{event.preventDefault();calculate();if(id==='tco'&&currentResult){panel.tabIndex=-1;panel.scrollIntoView({block:'start',behavior:'instant'});panel.focus({preventScroll:true});}});
  form.addEventListener('input',event=>{if(!event.target.closest('.import-box'))invalidate();});
  form.addEventListener('change',event=>{if(!event.target.closest('.import-box')){updateModes();invalidate();}});
  $('#example').addEventListener('click',()=>{
    form.dispatchEvent(new Event('calculatorchange'));
    const sample=structuredClone(SAMPLES[id==='genbestilling'?'rop':id]);setValues(sample);
    if(id==='tco'){loadCapital(form,sample);renderAlternatives(sample.alternatives);}
    if(id==='abc'){renderItems(sample.items);clearPreview();}
    updateModes();isExample=true;$('#data-note').textContent='Fiktive eksempeldata · Brug dem til at lære metoden. De er ikke virksomhedsdata.';calculate();
  });
  $('#clear').addEventListener('click',()=>{
    form.dispatchEvent(new Event('calculatorchange'));
    form.reset();initialize();resetErrors();currentResult=null;isExample=false;panel.classList.remove('stale');resultBox.innerHTML=blankResult;status.textContent='Felterne er nulstillet.';$('#print-result').hidden=true;$('#data-note').textContent='Indtast dine tal, eller begynd med et fiktivt eksempel. Tal skrives dansk, fx 1.234,56.';
    if(id==='abc')clearPreview();
    $('input:not([type=file])',form)?.focus();
  });
  $('#print-result').addEventListener('click',()=>window.print());

  if(id==='tco'){
    $('#capital-example').addEventListener('click',()=>{form.dispatchEvent(new Event('calculatorchange'));const sample=structuredClone(TCO_CAPITAL_SAMPLE);setValues(sample);loadCapital(form,sample);renderAlternatives(sample.alternatives);isExample=true;$('#data-note').textContent='Fiktivt eksempel · 365.000 kr. i årligt varekøb og en valgt rente på 10 %. Renten er ikke en aktuel markedsrente.';calculate();});
    $('#add-alternative').addEventListener('click',()=>{if($$('[data-alternative]').length>=3)return;$('[data-alternatives]').insertAdjacentHTML('beforeend',alternative(blankAlternative(),$$('[data-alternative]').length));invalidate();updateLimits();$$('.alt-name').at(-1).focus();});
    form.addEventListener('click',event=>{
      const button=event.target.closest('button');if(!button)return;
      const alt=button.closest('[data-alternative]');if(!alt)return;
      if(button.matches('.add-cost')){if($$('[data-cost]',alt).length>=MAX_TCO_COSTS)return;$('[data-costs]',alt).insertAdjacentHTML('beforeend',costRow({id:crypto.randomUUID(),label:'',amount:'',frequency:'year'},0,0));invalidate();updateLimits();$$('.cost-label',alt).at(-1).focus();}
      if(button.matches('.remove-cost')){if($$('[data-cost]',alt).length<=1)return;button.closest('[data-cost]').remove();invalidate();updateLimits();$('.add-cost',alt).focus();}
      if(button.matches('.remove-alternative')){if($$('[data-alternative]').length<=1)return;alt.remove();$$('[data-alternative]').forEach((el,i)=>$('legend',el).textContent=`Alternativ ${i+1}`);invalidate();updateLimits();$('#add-alternative').focus();}
    });
  }
  if(id==='abc'){
    $('#add-item').addEventListener('click',()=>{if($$('[data-item]').length>=MAX_ABC_ROWS)return;$('[data-items]').insertAdjacentHTML('beforeend',abcRow({name:'',annualQuantity:'',unitCost:''},$$('[data-item]').length));invalidate();updateLimits();$$('.item-name').at(-1).focus();});
    form.addEventListener('click',event=>{const button=event.target.closest('.remove-item');if(!button||$$('[data-item]').length<=1)return;button.closest('[data-item]').remove();invalidate();updateLimits();$('#add-item').focus();});
    const box=$('.import-box');
    // File reads finish asynchronously. A newer file, text edit, reset or sample
    // selection invalidates an earlier read before it can replace the preview.
    const importEdited=event=>{if(event.target.id!=='import-file')clearPreview();};
    box.addEventListener('input',importEdited);box.addEventListener('change',importEdited);
    $('#import-file').addEventListener('change',async event=>{
      clearPreview();const generation=importGeneration;
      const file=event.target.files[0];if(!file)return;
      $('#import-text').value='';
      if(file.size>2*1024*1024){$('#import-preview').textContent='Filen må højst være 2 MB.';return;}
      $('#import-preview').textContent='Filen læses lokalt…';
      try{const text=await file.text();if(generation!==importGeneration)return;$('#import-text').value=text;$('#import-preview').textContent='Filen er indlæst lokalt. Vælg talformat, og kontrollér importen.';}catch{if(generation===importGeneration)$('#import-preview').textContent='Filen kunne ikke læses. Prøv at kopiere cellerne fra Excel.';}
    });
    $('#preview-import').addEventListener('click',()=>{
      preview=previewImport($('#import-text').value,{format:$('#import-format').value,delimiter:$('#import-delimiter').value==='tab'?'\t':$('#import-delimiter').value});
      const out=$('#import-preview');out.innerHTML=`<p class="fine">${preview.header?'Overskriftsrækken er genkendt. ':''}Aflæst med ${preview.format==='da'?'dansk':'engelsk'} talformat. ${preview.items.length} gyldige varer.</p>${preview.errors.map(err=>`<p class="error">${err.line?`Linje ${err.line}: `:''}${e(err.message)}</p>`).join('')}${preview.warnings.map(w=>`<p class="result-warning">${e(w)}</p>`).join('')}${preview.rows.length?`<div class="table-scroll" tabindex="0" role="region" aria-label="Forhåndsvisning af import"><table class="comparison-table"><thead><tr><th>Original række</th><th>Aflæst antal</th><th>Aflæst pris · kr.</th></tr></thead><tbody>${preview.rows.slice(0,10).map(row=>`<tr><td>${e(row.raw.join(' | '))}</td><td>${row.item?fmt(row.item.annualQuantity,8):'Fejl'}</td><td>${row.item?fmt(row.item.unitCost,8):'Fejl'}</td></tr>`).join('')}</tbody></table></div><p class="fine">Viser ${Math.min(10,preview.rows.length)} af ${preview.rows.length} rækker. Alle rækker er kontrolleret.</p>`:''}`;
      $('#apply-import').disabled=!preview.canImport;
    });
    $('#apply-import').addEventListener('click',()=>{if(!preview?.canImport)return;renderItems(preview.items);invalidate();$('#import-preview').innerHTML=`<p>${preview.items.length} varer er overført. Kontrollér listen, og tryk Beregn.</p>`;$('#apply-import').disabled=true;preview=null;$('.item-name').focus();});
    resultBox.addEventListener('click',event=>{
      const sort=event.target.closest('[data-sort]');if(sort&&currentResult&&!panel.classList.contains('stale')){abcSort.direction=abcSort.key===sort.dataset.sort?-abcSort.direction:1;abcSort.key=sort.dataset.sort;renderABCTable();$(`[data-sort="${abcSort.key}"]`).focus();}
      if(event.target.closest('#download-result')&&currentResult&&!panel.classList.contains('stale')){const url=URL.createObjectURL(new Blob([exportABC(currentResult)],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='abc-analyse.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
    });
  }
  $$('[data-await-js]',form).forEach(button=>{button.disabled=false;button.removeAttribute('data-await-js');});
  updateLimits();
  connectCalculator({id,read:readData,showError,load(data){
    setValues(data);
    if(id==='tco'){loadCapital(form,data);renderAlternatives(data.alternatives);}
    if(id==='abc'){renderItems(data.items);clearPreview();}
    updateModes();isExample=false;calculate();
    $('#data-note').textContent='Dine indlæste tal. Ændringer gemmes først, når du selv vælger Gem.';
  }});
  function clearPreview(){++importGeneration;preview=null;$('#apply-import').disabled=true;$('#import-preview').textContent='';}
  function renderABCTable(){
    const sorted=[...currentResult.items].sort((a,b)=>{const av=a[abcSort.key],bv=b[abcSort.key];return (typeof av==='number'?av-bv:String(av).localeCompare(String(bv),'da'))*abcSort.direction||a.originalIndex-b.originalIndex;});
    const headings=[['name','Vare'],['annualQuantity','Årligt antal'],['unitCost','Pris · kr.'],['annualValue','Årlig værdi · kr.'],['sharePercent','Andel · %'],['cumulativePercent','Kumuleret · %'],['class','Klasse']];
    $('#abc-result-table').innerHTML=`<table class="results-table"><caption class="sr-only">ABC-resultat. Klik på en kolonneoverskrift for at sortere. Klasser og kumulerede andele følger værdirækkefølgen.</caption><thead><tr>${headings.map(([key,label])=>`<th scope="col" aria-sort="${abcSort.key===key?(abcSort.direction===1?'ascending':'descending'):'none'}"><button type="button" data-sort="${key}">${label} ${abcSort.key===key?(abcSort.direction===1?'↑':'↓'):'↕'}</button></th>`).join('')}</tr></thead><tbody>${sorted.map(row=>`<tr><td>${e(row.name)}</td><td>${fmt(row.annualQuantity,8)}</td><td>${fmt(row.unitCost,8)}</td><td>${fmt(row.annualValue)}</td><td>${fmt(row.sharePercent)}</td><td>${fmt(row.cumulativePercent)}</td><td><span class="class-tag class-${row.class}">${row.class}</span></td></tr>`).join('')}</tbody></table>`;
  }
}

const metric=(label,value)=>`<div><dt>${e(label)}</dt><dd>${value}</dd></div>`;
export function renderEOQ(r){
  return `<div class="primary-result"><span>Praktisk ordrestørrelse · rundet op til hele enheder</span><strong>${fmt(r.roundedQuantity,0)} <small>enheder</small></strong><p>Matematisk EOQ: <strong>${fmt(r.mathematicalQuantity,4)} enheder</strong>. Tilpas også til pakningsstørrelser og leverandørens mindstekøb.</p></div><dl class="result-metrics">${metric('Bestillinger pr. år',fmt(r.practical.ordersPerYear))}${metric('Mellem bestillinger',`${fmt(r.practical.intervalDays)} dage`)}${metric('Gennemsnitligt cykluslager',`${fmt(r.practical.averageStock,8)} enheder`)}${metric('Lageromkostning · H',`${money(r.holdingCostPerUnit,8)} / enhed / år`)}</dl><div class="table-scroll" tabindex="0" role="region" aria-label="Omkostninger ved matematisk og praktisk EOQ"><table class="comparison-table"><thead><tr><th>Årlig omkostning</th><th>Matematisk EOQ</th><th>Rundet op</th></tr></thead><tbody>${[['Bestilling','orderingCost'],['Cykluslager','holdingCost'],['I alt','totalCost']].map(([label,key])=>`<tr><th scope="row">${label}</th><td>${money(r.mathematical[key])}</td><td>${money(r.practical[key])}</td></tr>`).join('')}</tbody></table></div>${lineChart(r.chartPoints,[{key:'totalCost',label:'Bestilling + cykluslager'},{key:'orderingCost',label:'Bestilling'},{key:'holdingCost',label:'Cykluslager'}],{marker:r.mathematicalQuantity})}<p class="fine">Viser bestilling og cykluslager pr. år. Vareindkøb, sikkerhedslager og mængderabatter er ikke med i omkostningskurven. Antal ordrer og interval er gennemsnit.</p>`;
}
export function renderROP(r,data){
  return `<div class="primary-result"><span>Genbestillingspunkt · rundet op til hele enheder</span><strong>${fmt(r.roundedReorderPoint,0)} <small>enheder</small></strong><p>Den beregnede værdi før afrunding er ${fmt(r.reorderPoint,4)} enheder.</p></div><dl class="result-metrics">${metric('Forbrug i leveringstiden',`${fmt(r.expectedDemand,8)} enheder`)}${metric('Sikkerhedslager',`${fmt(r.safetyStock,8)} enheder`)}${r.zScore!==null?metric('z-værdi',fmt(r.zScore,4))+metric('Valgt cyklusservicegrad',`${e(data.serviceLevelPercent)} %`):''}</dl>${ropChart(r)}<p class="callout">Vurder genbestilling ud fra lagerpositionen: beholdning + bekræftede varer på vej − restordrer. Bestil, når lagerpositionen når genbestillingspunktet. Sikkerhedslageret er allerede med og skal ikke lægges til igen.</p><p class="fine">Brug samme daggrundlag for efterspørgsel og leveringstid. ${r.zScore!==null?'Den valgte servicegrad bygger på modellens antagelser; den er ikke en leveringsgaranti.':'Bufferen er dit eget valg og angiver ikke en beregnet servicegrad.'}</p>`;
}
export function renderTCO(r){
  const kroner=value=>new Intl.NumberFormat('da-DK',{maximumFractionDigits:2}).format(value);
  const money=value=>`${kroner(value)} kr.`;
  return `<div class="primary-result"><span>Laveste beregnede TCO${r.capitalEnabled?' inklusive valgt kapitaltillæg':''} i den valgte periode</span><strong>${kroner(r.lowestCost)} <small>kr.</small></strong><p>Fælles mængde i hele perioden: ${fmt(r.periodQuantity,8)} enheder. Alle beløb er ekskl. moms.</p></div>${r.alternatives.map(a=>`<article class="tco-result ${r.lowestIds.includes(a.id)?'lowest':''}">${r.lowestIds.includes(a.id)?'<span class="badge">Laveste beregnede TCO</span>':''}<h3>${e(a.name)}</h3><strong>${money(a.comparisonTotalCost??a.totalCost)}</strong><p class="fine">${a.differenceFromLowest?`${money(a.differenceFromLowest)} mere end det laveste alternativ.`:'Samme beløb som det laveste alternativ.'}${a.costPerUnit!==null?` ${money(a.costPerUnit)} pr. enhed.`:''}</p><details open><summary>Se omkostningsfordeling</summary><table><caption class="sr-only">Omkostninger for ${e(a.name)}</caption><tbody>${a.breakdown.map(c=>`<tr><td>${e(c.label)}<small>${kroner(c.amount)} kr. × ${fmt(c.multiplier,8)}</small></td><td>${money(c.total)}</td></tr>`).join('')}<tr><td>Samlet før restværdi</td><td>${money(a.grossCost)}</td></tr><tr><td>Fradrag · restværdi én gang</td><td>−${money(a.residualValue)}</td></tr></tbody></table></details>${capitalResult(a)}</article>`).join('')}<p class="fine">Laveste TCO afgør ikke alene valget. Kvalitet, leveringssikkerhed og risiko kan også have betydning. Sammenlign kun alternativer, der opfylder samme behov.</p>`;
}
export function renderABC(r){
  return `<div class="primary-result"><span>Samlet årlig forbrugsværdi</span><strong>${fmt(r.totalValue)} <small>kr.</small></strong><p>${r.totalItems} varer rangeret efter årligt forbrug × indkøbspris.</p></div><div class="abc-summary">${['A','B','C'].map(c=>`<div><b>${c}</b><span>${r.summary[c].count} varer</span><strong>${fmt(r.summary[c].sharePercent)} %</strong><span>${money(r.summary[c].value)}</span></div>`).join('')}</div>${paretoChart(r)}<div class="result-actions"><button type="button" class="button secondary" id="download-result">Hent resultat som CSV ↓</button></div><div class="table-scroll" id="abc-result-table" tabindex="0" role="region" aria-label="Sorterbart ABC-resultat"></div><p class="fine">Kumulerede andele og klasser følger faldende forbrugsværdi, også når tabellen sorteres på en anden kolonne. En grænsekrydsende vare bliver i den foregående klasse. ABC fortæller ikke alene, om en vare er kritisk eller pladskrævende.</p>`;
}
function renderWarnings(codes,result){
  const messages={zero_demand:'Efterspørgslen er nul. Kontrollér, om det svarer til den planlagte aktivitet.',zero_order_cost:'Bestillingsomkostningen er nul. EOQ-modellen har derfor intet positivt minimum; 1 enhed er kun et praktisk eksempel, ikke en optimal anbefaling.',zero_mean_positive_variation:'Gennemsnittet er nul, men variationen er positiv. Normaltilnærmelsen er sandsynligvis ikke egnet til disse data.',zero_variation:'Variation er nul. Den statistiske model beregner derfor intet sikkerhedslager.',normal_independent_daily_demand:'Statistisk model: fast leveringstid, uafhængigt dagligt forbrug og normaltilnærmelse. Cyklusservicegrad er ikke fill rate.',zero_lead_time:'Leveringstiden er nul. Kontrollér, at varemodtagelse og håndtering er medregnet.',undiscounted:'Ud​iskonteret TCO: fremtidige beløb vægtes som dagens beløb. Inflation og nutidsværdi indgår ikke. Et eventuelt kapitaltillæg beregnes særskilt.',no_unit_basis:'Mængden er nul. Omkostning pr. enhed kan ikke beregnes.',partial_year:'Perioden er en del af et år. Årlige poster, mængder og ordreantal skaleres forholdsmæssigt.',zero_total_value:'Den samlede værdi er nul. Alle varer placeres i C; procentandele og Pareto-graf giver ikke et prioriteringsgrundlag.',duplicate_names:'Flere varer har samme navn. De er bevaret som særskilte rækker; kontrollér eventuelle dubletter.'};
  return codes.map(code=>{const [type,altid]=code.split(':');let message=messages[type];const name=result.alternatives?.find(a=>a.id===altid)?.name||'Et alternativ';if(type==='residual_exceeds_cost')message=`${name}: Restværdien overstiger omkostningerne. Kontrollér det negative nettobeløb.`;if(type==='zero_orders')message=`${name}: Der er forbrug, men 0 ordrer. Omkostningsposter pr. ordre bliver derfor nul.`;return message?`<p class="result-warning">${e(message)}</p>`:'';}).join('');
}
