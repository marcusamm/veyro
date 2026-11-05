import {TOOLS} from './registry.mjs';
import {escape as e} from './charts.mjs';
import {canonicalizeInput} from './saved-input.mjs';
import {sitePath,accountPath,accountOrigin} from './paths.mjs';

const $ = selector => document.querySelector(selector);
const draftKey = 'logistik-explicit-login-draft-v1';
const tools = Object.fromEntries(TOOLS.map(tool => [tool.id, tool]));
const date = value => new Intl.DateTimeFormat('da-DK',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
let session = null;

function message(selector,text,error=false){const node=$(selector);if(node){node.textContent=text;node.hidden=!text;if(error)node.setAttribute('role','alert');}}
async function request(path,fields){
  if(accountOrigin)throw new Error('Åbn værktøjerne på Veyro for at bruge din konto.');
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
  let response;
  try{response=await fetch(accountPath(`/api${path}`),{method:fields?'POST':'GET',credentials:'same-origin',cache:'no-store',signal:controller.signal,headers:fields?{'Content-Type':'application/x-www-form-urlencoded'}:{},body:fields?new URLSearchParams({...fields,_csrf:session?.csrf||''}):undefined});}
  catch{throw new Error('Forbindelsen kunne ikke gennemføres. Dine indtastede tal er stadig her. Prøv igen.');}
  finally{clearTimeout(timeout);}
  let data;try{data=await response.json();}catch{throw new Error('Forbindelsen kunne ikke gennemføres. Dine indtastede tal er stadig her. Prøv igen.');}
  if(!response.ok){const error=new Error(data.error||'Handlingen kunne ikke gennemføres. Prøv igen.');error.status=response.status;error.code=data.code;error.path=data.path;throw error;}
  return data;
}
function pendingDraft(){
  try{const raw=sessionStorage.getItem(draftKey);if(!raw)return null;const draft=JSON.parse(raw);if(!Object.hasOwn(tools,draft.toolId)||!Number.isFinite(draft.createdAt)||typeof draft.name!=='string'||draft.name.length>120||Date.now()-draft.createdAt>2*60*60*1000||Date.now()<draft.createdAt){sessionStorage.removeItem(draftKey);return null;}draft.input=canonicalizeInput(draft.toolId,draft.input);return draft;}catch{try{sessionStorage.removeItem(draftKey);}catch{}return null;}
}
function clearDraft(){try{sessionStorage.removeItem(draftKey);}catch{}}

const ready = typeof document==='undefined'?Promise.resolve(null):(async()=>{
  for(const selector of ['#account-login','#save-login','#dashboard-login'])if($(selector))$(selector).href=accountPath('/login');
  try{session=await request('/session');}catch{
    message('#account-status',accountOrigin?'':'Kontoen kunne ikke indlæses. Beregnere virker stadig.');
    return null;
  }
  if(session.authenticated){
    message('#account-status',session.email);
    if($('#account-login'))$('#account-login').hidden=true;
    if($('#account-logout')){
      $('#account-logout').hidden=false;
      $('#account-logout').addEventListener('click',async()=>{
        clearDraft();
        // Let the existing same-origin session endpoint clear the HttpOnly cookie.
        const form=document.createElement('form');form.method='POST';form.action=accountPath('/logout');
        const csrf=document.createElement('input');csrf.type='hidden';csrf.name='_csrf';csrf.value=session.csrf;form.append(csrf);document.body.append(form);form.submit();
      });
    }
  }else message('#account-status','Gæst · intet gemmes automatisk');
  return session;
})();
if(typeof window!=='undefined')window.addEventListener('pageshow',async event=>{
  if(!event.persisted||accountOrigin)return;
  await ready;
  try{const fresh=await request('/session');
    if(fresh.authenticated!==session?.authenticated||fresh.email!==session?.email){location.reload();return;}
    session=fresh;
  }catch{if(session?.authenticated)location.reload();}
});

export function connectCalculator({id,read,load,showError}){
  if(!$('#save-panel'))return;
  let saved=null,busy=false,revision=0,loaded=true;
  const form=$('#calculator'),name=$('#saved-name');
  if(accountOrigin&&$('#save-login-draft'))$('#save-login-draft').hidden=true;
  const title=()=>`${tools[id].title} · ${new Date().toLocaleDateString('da-DK')}`;
  name.value=title();
  const changed=()=>{revision++;if(saved)message('#save-status','Ændringerne er ikke gemt endnu.');};
  form.addEventListener('input',changed);form.addEventListener('change',changed);form.addEventListener('calculatorchange',changed);name.addEventListener('input',changed);
  function buttons(){
    $('#save-plan').disabled=busy||!session?.authenticated||!loaded||Boolean(saved?.archivedAt);
    $('#save-copy').disabled=busy||!session?.authenticated||!loaded;
    $('#save-copy').hidden=!saved;
  }
  function error(problem){message('#save-error',problem.message,true);if(problem.path)showError(problem);}
  function collect(){return canonicalizeInput(id,read());}
  function markSaved(item,snapshotRevision){
    saved=item;
    const url=new URL(location.href);url.searchParams.set('saved',item.id);url.searchParams.delete('resume');history.replaceState(null,'',url);
    message('#saved-meta',`${item.archivedAt?'Arkiveret · ':''}Version ${item.version} · gemt ${date(item.updatedAt)}`);
    message('#save-status',snapshotRevision===revision?'Gemt på din Veyro-konto.':'Versionen blev gemt. Dine nyeste ændringer er endnu ikke gemt.');
    $('#save-plan').textContent='Gem ændringer';buttons();
  }
  async function save(copy=false){
    if(busy)return;message('#save-error','');
    let input;try{input=collect();}catch(problem){error(problem);return;}
    const label=name.value.trim();if(!label||label.length>120){message('#save-error','Giv beregningen et navn på højst 120 tegn.',true);name.focus();return;}
    busy=true;buttons();message('#save-status','Gemmer…');const snapshotRevision=revision;
    try{
      const fields={name:copy?`${label.slice(0,112)} (kopi)`:label,input:JSON.stringify(input),toolId:id};
      if(saved)fields.version=String(saved.version);
      const path=saved?`/calculations/${encodeURIComponent(saved.id)}${copy?'/copy':''}`:'/calculations';
      const {calculation}=await request(path,fields);
      if(copy&&snapshotRevision===revision)name.value=calculation.name;
      markSaved(calculation,snapshotRevision);
    }catch(problem){
      message('#save-status','Ikke gemt. Dine input er stadig her.');
      if(problem.status===409&&problem.code==='conflict'){problem.message='Den gemte version er ændret i et andet vindue. Dine tal er bevaret her. Vælg “Gem som kopi”, eller åbn den nyeste version fra Mine beregninger.';}
      if(problem.status===401){problem.message='Dit login er udløbet. Dine tal er stadig her. Brug “Log ind, og tag mine tal med” nedenfor.';$('#save-guest').hidden=false;}
      error(problem);
    }finally{busy=false;buttons();}
  }
  $('#save-plan').addEventListener('click',()=>save());$('#save-copy').addEventListener('click',()=>save(true));
  $('#save-login-draft')?.addEventListener('click',()=>{
    if(accountOrigin){location.assign(accountPath(tools[id].path));return;}
    try{
      const input=collect();
      sessionStorage.setItem(draftKey,JSON.stringify({toolId:id,input,name:name.value.trim()||title(),createdAt:Date.now()}));
      location.assign(accountPath('/login'));
    }catch(problem){error(problem.name==='QuotaExceededError'||problem.name==='SecurityError'?new Error('Browseren tillader ikke midlertidig opbevaring. Log ind først, og udfyld derefter beregningen.'):problem);}
  });
  const query=new URLSearchParams(location.search),savedId=query.get('saved');
  if(savedId||query.get('resume')==='1'){loaded=false;form.inert=true;message('#save-status','Åbner beregningen…');}
  ready.then(async()=>{
    if(session?.authenticated){$('#save-guest').hidden=true;$('#save-controls').hidden=false;}
    if(savedId){
      if(!session?.authenticated){message('#save-error','Log ind på din Veyro-konto, og åbn beregningen fra Mine beregninger.',true);}
      else try{
        const {calculation}=await request(`/calculations/${encodeURIComponent(savedId)}`);
        if(calculation.toolId!==id)throw new Error('Beregningen hører til et andet værktøj. Åbn den fra Mine beregninger.');
        load(canonicalizeInput(id,calculation.input));name.value=calculation.name;markSaved(calculation,revision);
        if(calculation.archivedAt)message('#save-status','Denne beregning er arkiveret. Du kan gemme en ny kopi eller gendanne den fra Mine beregninger.');
      }catch(problem){error(problem);}
      finally{loaded=true;form.inert=false;buttons();}
      // Even an expired login must not leave the anonymous calculator inert.
      loaded=true;form.inert=false;
    }else if(session?.authenticated&&query.get('resume')==='1'){
      const draft=pendingDraft();
      if(draft&&draft.toolId===id){load(draft.input);name.value=draft.name;clearDraft();message('#save-status','Dine tal er tilbage. Kontrollér dem, og vælg Gem, hvis de skal gemmes på din konto.');}
      else message('#save-status','Den midlertidige beregning er ikke længere tilgængelig. Du kan begynde en ny.');
      const url=new URL(location.href);url.searchParams.delete('resume');history.replaceState(null,'',url);
    }
    loaded=true;form.inert=false;buttons();
  });
}

async function dashboard(){
  await ready;$('#dashboard-loading').hidden=true;
  if(!session?.authenticated){$('#dashboard-guest').hidden=false;if(!session)message('#dashboard-error','Kontoen kunne ikke indlæses. Prøv at genindlæse siden eller logge ind.',true);return;}
  $('#dashboard-guest').hidden=true;$('#dashboard-content').hidden=false;
  let entries=[],requestVersion=0;
  const pending=pendingDraft();
  if(pending){
    const box=document.createElement('div');box.className='draft-notice';
    box.innerHTML=`<h2>Fortsæt med dine tal</h2><p>Din midlertidige ${e(tools[pending.toolId].title)} er klar. Den er endnu ikke gemt på kontoen.</p><a class="button" href="${sitePath(tools[pending.toolId].path)}?resume=1">Fortsæt beregningen ↗</a><button type="button" class="text-button">Kassér de midlertidige tal</button>`;
    $('#dashboard-content').prepend(box);box.querySelector('button').addEventListener('click',()=>{clearDraft();box.remove();});
  }
  function render(){
    const term=$('#saved-search').value.trim().toLocaleLowerCase('da');
    const filtered=entries.filter(row=>`${row.name} ${tools[row.toolId]?.title||''}`.toLocaleLowerCase('da').includes(term));
    $('#saved-empty').hidden=filtered.length>0;
    $('#saved-list').innerHTML=filtered.map(row=>`<article class="saved-card"><div class="saved-card-main"><span class="eyebrow">${e(tools[row.toolId]?.title||row.toolId)}</span><h2><a href="${sitePath(tools[row.toolId].path)}?saved=${encodeURIComponent(row.id)}">${e(row.name)}</a></h2><p class="fine">${row.archivedAt?'Arkiveret · ':''}Opdateret ${e(date(row.updatedAt))} · version ${row.version}</p></div><div class="saved-card-actions"><a class="button secondary" href="${sitePath(tools[row.toolId].path)}?saved=${encodeURIComponent(row.id)}">Åbn ↗</a><button type="button" class="text-button" data-action="copy" data-id="${e(row.id)}">Kopiér</button><button type="button" class="text-button" data-action="${row.archivedAt?'restore':'archive'}" data-id="${e(row.id)}">${row.archivedAt?'Gendan':'Arkivér'}</button></div></article>`).join('');
    message('#dashboard-status',`${filtered.length} ${filtered.length===1?'beregning':'beregninger'}${term?' matcher søgningen':''}.`);
  }
  async function refresh(){
    const sequence=++requestVersion;message('#dashboard-error','');message('#dashboard-status','Henter beregninger…');
    try{const data=await request(`/calculations${$('#saved-filter').value==='archived'?'?archived=1':''}`);if(sequence!==requestVersion)return;entries=data.calculations;render();}catch(problem){if(sequence===requestVersion)message('#dashboard-error',problem.message,true);}
  }
  $('#saved-search').addEventListener('input',render);$('#saved-filter').addEventListener('change',refresh);
  $('#saved-list').addEventListener('click',async event=>{
    const button=event.target.closest('button[data-action]');if(!button)return;
    const entry=entries.find(row=>row.id===button.dataset.id);if(!entry)return;
    const actions=button.closest('.saved-card-actions');actions.querySelectorAll('button').forEach(item=>item.disabled=true);
    try{
      const fields={version:String(entry.version)};
      if(button.dataset.action==='copy')fields.name=`${entry.name.slice(0,112)} (kopi)`;
      await request(`/calculations/${encodeURIComponent(entry.id)}/${button.dataset.action}`,fields);await refresh();
    }catch(problem){message('#dashboard-error',problem.code==='conflict'?'Beregningen er ændret i et andet vindue. Genindlæs listen, og prøv igen.':problem.message,true);}
    finally{actions.querySelectorAll('button').forEach(item=>item.disabled=false);}
  });
  await refresh();
}
if(typeof document!=='undefined'&&$('#account-dashboard'))dashboard();
