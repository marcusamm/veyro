'use strict';
(() => {
  const $=id=>document.getElementById(id);
  const invoke=(action,payload={})=>window.veyroMail.invoke(action,payload);
  const state={identity:null,folders:[],views:[],gmail:false,keywordLabels:false,availableLabels:[],keywordLabel:'',viewId:'inbox',folder:'INBOX',page:1,query:'',uidValidity:null,messages:[],current:null,drafts:[],draft:null,view:'mail',listEpoch:0,draftEpoch:0,uploading:false,sending:false};
  let draftTimer,draftChain=Promise.resolve(),oauthBusy=false,configureBusy=false,gmailManual=false;
  let activeRead=null,wantedRead=null,openedAt=0;
  let pendingTimer, cancelFrame, listedPage;
  const providers={
    gmail:{imap:'imap.gmail.com',smtp:'smtp.gmail.com',oauth:'google',note:'Vælg din Google-konto i browseren. Du bruger din eksisterende Gmail-adresse.'},
    outlook:{imap:'outlook.office365.com',smtp:'smtp.office365.com',oauth:'microsoft',note:'Du logger ind hos Microsoft i din browser.'},
    // Provider settings: support.apple.com/102525 and help.yahoo.com/kb/SLN4075.html.
    icloud:{imap:'imap.mail.me.com',smtp:'smtp.mail.me.com',note:'Brug en app-adgangskode fra din Apple-konto. Du opretter den under Login og sikkerhed → App-specifikke adgangskoder.'},
    yahoo:{imap:'imap.mail.yahoo.com',smtp:'smtp.mail.yahoo.com',note:'Brug en app-adgangskode, som du opretter under Kontosikkerhed på din Yahoo-konto.'},
    custom:{note:'Din mailudbyder har sine egne serveroplysninger. Tilføj dem under Avancerede indstillinger. Du finder dem hos udbyderen eller din it-ansvarlige.'}
  };
  const names={'\\Inbox':'Indbakke','\\Sent':'Sendt','\\Drafts':'Kladder hos udbyderen','\\Trash':'Papirkurv','\\Junk':'Spam','\\Archive':'Arkiv','\\All':'Alle mails'};
  function text(node,value){node.textContent=value || '';}
  function node(tag,className,value){const el=document.createElement(tag);if(className)el.className=className;if(value!==undefined)text(el,value);return el;}
  function errorText(error){return String(error?.message || error || 'Noget gik galt. Prøv igen.').replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');}
  function notice(message){text($('notice'),message);$('notice').hidden=!message;}
  function errorAt(id,error){text($(id),error?errorText(error):'');$(id).hidden=!error;}
  function showDate(value,long=false){if(!value)return '';const d=new Date(value);return Number.isNaN(d.valueOf())?'':new Intl.DateTimeFormat('da-DK',long?{dateStyle:'long',timeStyle:'short'}:{day:'numeric',month:'short'}).format(d);}
  function addressList(list){return (list || []).map(a=>a.name?`${a.name} <${a.address}>`:a.address).join(', ');}
  function recipientString(list){return (list || []).map(a=>a.name?`"${a.name.replace(/["\\\r\n]/g,'')}" <${a.address}>`:a.address).join(', ');}
  function bytes(value){return value<1024?`${value} B`:value<1048576?`${Math.round(value/1024)} KB`:`${(value/1048576).toFixed(1)} MB`;}
  function attachmentSizeSuffix(size){return Number.isSafeInteger(size) && size>=0 ? ' · '+bytes(size) : '';}
  function folderName(folder){return folder.path.toUpperCase()==='INBOX'?'Indbakke':names[folder.specialUse] || folder.name;}
  function selected(){return state.current?{folder:state.current.folder,uid:state.current.uid,uidValidity:state.current.uidValidity}:null;}
  function setReader(message, pending=null){
    clearTimeout(pendingTimer);
    if(cancelFrame)cancelFrame();
    state.current=message;
    openedAt=message?Date.now():0;
    wantedRead=pending;
    const article=$('message');
    article.inert=!!pending;
    $('reader').setAttribute('aria-busy',String(!!pending));
    $('workspace').classList.toggle('reading',!!(message || pending));
    if(pending){
      // A cached read can complete before the next paint. Leave the existing
      // article in place, disabling its actions as soon as selection changes.
      pendingTimer=setTimeout(()=>{
        if(wantedRead!==pending)return;
        $('reader-pending').hidden=false;
      },160);
      return;
    }
    $('message').hidden=!message;
    $('reader-pending').hidden=true;
    $('reader-empty').hidden=!!message;
    $('reader').scrollTop=0;
    if(!message){
      $('message-frame').removeAttribute('src');
      $('message-frame').hidden=true;
    }
  }
  function hasRichBody(message){
    return message.richAvailable && /^veyro:\/\/message\/[a-f\d-]{36}$/.test(message.htmlUrl || '');
  }
  function prepareRichBody(message){
    const previous=$('message-frame');
    const frame=previous.cloneNode(false);
    frame.removeAttribute('id');
    frame.hidden=true;
    return new Promise(resolve=>{
      function finish(ready){
        clearTimeout(timer);
        frame.onload=null;
        cancelFrame=null;
        if(ready){
          previous.remove();
          frame.id='message-frame';
        }else{
          frame.remove();
          message.richMode=false;
        }
        resolve();
      }
      cancelFrame=()=>finish(false);
      const timer=setTimeout(cancelFrame,5000);
      frame.onload=()=>finish(true);
      frame.src=message.htmlUrl;
      previous.after(frame);
    });
  }
  // The list owns the clipping viewport. Include a row even if only the top
  // or bottom of it is visible, and bind every report to its native page.
  const messageList = $('messages');
  let visiblePage = null, lastVisible = null, visibleFrame = 0;
  function publishVisible(uids) {
    if (!visiblePage) return;
    if (lastVisible && lastVisible.length === uids.length && lastVisible.every((uid,i)=>uid === uids[i])) return;
    lastVisible = uids;
    void invoke('visibleMessages', {...visiblePage, uids}).catch(()=>{});
  }
  function measureVisibleRows() {
    if (!visiblePage) return;
    if (document.hidden || state.view !== 'mail' || document.querySelector('dialog[open]')) {
      publishVisible([]);
      return;
    }
    const bounds = messageList.getBoundingClientRect();
    const left = Math.max(0, bounds.left + messageList.clientLeft);
    const right = Math.min(innerWidth, bounds.left + messageList.clientLeft + messageList.clientWidth);
    const top = Math.max(0, bounds.top + messageList.clientTop);
    const bottom = Math.min(innerHeight, bounds.top + messageList.clientTop + messageList.clientHeight);
    const uids = [];
    if (left < right && top < bottom) {
      for (const row of messageList.querySelectorAll('button[data-uid]')) {
        const rect = row.getBoundingClientRect();
        if (rect.width && rect.height && rect.bottom > top && rect.top < bottom && rect.right > left && rect.left < right) {
          uids.push(Number(row.dataset.uid));
        }
      }
    }
    publishVisible(uids);
  }
  function queueVisibleRows() {
    if (visiblePage && !visibleFrame) visibleFrame = requestAnimationFrame(()=>{
      visibleFrame = 0;
      measureVisibleRows();
    });
  }
  const rowResize = new ResizeObserver(queueVisibleRows);
  function clearVisiblePage() {
    publishVisible([]);
    rowResize.disconnect();
    visiblePage = null;
    lastVisible = null;
  }
  function setVisiblePage(folder,uidValidity,pageToken) {
    rowResize.disconnect();
    visiblePage = pageToken ? {folder,uidValidity,pageToken} : null;
    lastVisible = null;
    if (!visiblePage) return;
    rowResize.observe(messageList);
    for (const row of messageList.querySelectorAll('button[data-uid]')) rowResize.observe(row);
    queueVisibleRows();
  }
  messageList.addEventListener('scroll',queueVisibleRows,{passive:true});
  window.addEventListener('resize',queueVisibleRows);
  window.addEventListener('pagehide',()=>publishVisible([]));
  window.addEventListener('pageshow',queueVisibleRows);
  document.addEventListener('visibilitychange',()=>document.hidden ? publishVisible([]) : queueVisibleRows());
  window.veyroMail?.onViewportRequested?.(()=>{
    lastVisible = null;
    if (document.hidden) publishVisible([]);
    else queueVisibleRows();
  });
  const dialogVisibility = new MutationObserver(measureVisibleRows);
  for (const dialog of document.querySelectorAll('dialog')) dialogVisibility.observe(dialog,{attributes:true,attributeFilter:['open']});

  async function start(){
    $('retry-start').hidden=true;
    try{
      if(!window.veyroMail?.invoke)throw new Error('Åbn denne postkasse i Veyro Mail-appen.');
      state.identity=await invoke('bootstrap');text($('account-address'),state.identity.account?.email || state.identity.label);
      $('startup').hidden=true;
      if(!state.identity.configured){openSettings();return;}
      $('workspace').hidden=false;await refreshFolders();await loadMessages();await refreshDrafts();
    }catch(error){notice(errorText(error));$('retry-start').hidden=false;}
  }
  function currentProvider(){return providers[$('provider').value];}
  function manualMode(){const choice=$('provider').value;return !!choice&&choice!=='outlook'&&(choice!=='gmail'||gmailManual)&&state.identity?.account?.authType!=='oauth';}
  function defaultUser(protocol){const email=$('account-email').value.trim();return protocol==='imap'&&$('provider').value==='icloud'?email.split('@')[0]:email;}
  function canKeepPassword(){
    const account=state.identity?.account;
    return !!account&&account.authType!=='oauth'&&account.email===$('account-email').value.trim()&&account.imap?.host===$('imap-host').value.trim()&&account.imap?.user===($('imap-user').value.trim()||defaultUser('imap'));
  }
  function updatePasswordRequirement(){
    const keep=canKeepPassword();$('imap-password').required=manualMode()&&!keep;
    text($('password-hint'),keep?'Lad feltet være tomt for at beholde den gemte adgangskode.':$('provider').value==='custom'?'Brug den adgangskode eller app-adgangskode, din udbyder kræver.':'En app-adgangskode er lavet til mailapps. Brug ikke din almindelige kontoadgangskode.');
  }
  function openSettings(){
    const account=state.identity?.account || {};
    $('account-email').value=account.email || '';$('account-name').value=account.name || '';
    const choice=account.oauthProvider==='google'?'gmail':account.oauthProvider==='microsoft'?'outlook':Object.keys(providers).find(key=>providers[key].imap&&providers[key].imap===account.imap?.host&&providers[key].smtp===account.smtp?.host);
    $('provider').value=choice||(state.identity?.configured?'custom':'');
    for(const protocol of ['imap','smtp']){
      const server=account[protocol] || {};
      $(`${protocol}-host`).value=server.host || '';$(`${protocol}-port`).value=server.port || (protocol==='imap'?993:587);
      $(`${protocol}-secure`).value=String(server.secure??protocol==='imap');$(`${protocol}-user`).value=server.user || '';
      $(`${protocol}-password`).value='';
    }
    gmailManual=$('provider').value==='gmail'&&state.identity?.configured&&account.authType!=='oauth';
    $('advanced-settings').open=false;$('save-sent').checked=account.saveSent!==false;
    $('close-settings').hidden=!state.identity?.configured;text($('settings-title'),state.identity?.configured?'Din konto.':'Saml din mail her.');
    errorAt('settings-error',null);renderSetup();
    if(!$('settings-dialog').open)$('settings-dialog').showModal();
  }
  function providerChanged(){
    gmailManual=false;$('advanced-settings').open=false;errorAt('settings-error',null);
    const selected=currentProvider();
    for(const protocol of ['imap','smtp']){
      $(`${protocol}-host`).value=selected?.[protocol]||'';$(`${protocol}-port`).value=protocol==='imap'?'993':'587';
      $(`${protocol}-secure`).value=String(protocol==='imap');$(`${protocol}-user`).value='';$(`${protocol}-password`).value='';
    }
    $('save-sent').checked=$('provider').value!=='gmail';renderSetup();
  }
  function renderSetup(){
    const choice=$('provider').value,selected=currentProvider(),manual=manualMode(),busy=oauthBusy||configureBusy;
    const active=state.identity?.account?.authType==='oauth',provider=selected?.oauth,available=!!state.identity?.oauth?.[provider]?.available;
    $('provider-fields').hidden=!selected;$('provider').disabled=busy||active;
    const googleLogin=provider==='google'&&!manual;
    $('identity-fields').hidden=googleLogin;
    $('account-email').disabled=!selected||busy||googleLogin;$('account-name').disabled=!selected||busy||googleLogin;
    $('connected-account').hidden=!googleLogin||!state.identity?.configured;text($('connected-account'),state.identity?.account?.email);
    $('manual-settings').hidden=!manual;$('imap-password').disabled=!manual||busy;
    $('advanced-settings').querySelector('summary').setAttribute('aria-disabled',String(busy));
    for(const input of $('advanced-fields').querySelectorAll('input,select'))input.disabled=!manual||!$('advanced-settings').open||busy;
    $('manual-alternative').hidden=choice!=='gmail'||active;$('manual-alternative').disabled=busy;
    $('manual-alternative').setAttribute('aria-expanded',String(gmailManual));text($('manual-alternative'),gmailManual?'Tilbage til Google-login':'Brug en app-adgangskode i stedet');
    $('oauth-actions').hidden=!provider||manual;
    for(const service of ['google','microsoft']){
      $(`oauth-${service}`).hidden=service!==provider||manual;
      $(`oauth-${service}`).disabled=busy||!available;
      text($(`oauth-${service}`),oauthBusy?'Åbner login …':`${active?'Log ind igen med':'Log ind med'} ${service==='google'?'Google':'Microsoft'}`);
    }
    let note=selected?.note||'';
    if(choice==='gmail'&&manual)note='Brug kun denne mulighed, hvis din Google-konto tillader app-adgangskoder. Opret en på din Google-konto med totrinsbekræftelse.';
    else if(provider&&!available)note=`${provider==='google'?'Google':'Microsoft'}-login er ikke tilgængeligt i denne udgave. ${provider==='google'?'Brug en udgave med Google-login, eller vælg alternativet nedenfor.':'Outlook- og Microsoft 365-konti kan derfor ikke forbindes endnu.'}`;
    text($('provider-note'),note);
    $('oauth-note').hidden=!provider||manual;text($('oauth-note'),oauthBusy?'Fuldfør login i din browser. Du kan annullere her.':active?'Kontoen er forbundet. Log ind igen, hvis forbindelsen skal fornys.':available?'Din browser åbner, når du fortsætter.':'');
    $('oauth-cancel').hidden=!oauthBusy;$('close-settings').disabled=busy;
    $('save-settings').disabled=!manual||busy;text($('save-settings'),configureBusy?'Forbinder …':state.identity?.configured?'Gem forbindelse':'Forbind konto');
    text($('password-label'),choice==='custom'?'Adgangskode':'App-adgangskode');
    updatePasswordRequirement();
  }
  async function connectOAuth(provider){
    if(oauthBusy||configureBusy||!state.identity?.oauth?.[provider]?.available||(provider!=='google'&&!$('account-email').reportValidity()))return;
    const payload=provider==='google'?{provider}:{provider,email:$('account-email').value.trim(),name:$('account-name').value.trim()};
    oauthBusy=true;renderSetup();errorAt('settings-error',null);
    try{
      state.identity=await invoke('oauthConnect',payload);
      $('imap-password').value='';$('smtp-password').value='';$('settings-dialog').close();text($('account-address'),state.identity.account.email);
      state.folder='INBOX';state.viewId='inbox';state.keywordLabel='';state.availableLabels=[];state.keywordLabels=false;renderKeywordFilter();state.view='mail';state.page=1;state.query='';$('search').value='';setReader(null);$('workspace').hidden=false;notice('Kontoen er forbundet.');await refreshFolders();await loadMessages();await refreshDrafts();
    }catch(error){errorAt('settings-error',error);}finally{oauthBusy=false;renderSetup();}
  }
  async function configure(event){
    event.preventDefault();if(oauthBusy||configureBusy)return;
    if(currentProvider()?.oauth&&!manualMode()){await connectOAuth(currentProvider().oauth);return;}
    if(!manualMode())return;
    // Collapsed server controls must not obstruct provider login. Validate them before manual configuration.
    for(const input of $('advanced-fields').querySelectorAll('input,select'))input.disabled=false;
    if(!$('settings-form').checkValidity()){
      $('advanced-settings').open=true;renderSetup();$('settings-form').reportValidity();return;
    }
    const account={email:$('account-email').value.trim(),name:$('account-name').value.trim(),saveSent:$('save-sent').checked};
    for(const protocol of ['imap','smtp'])account[protocol]={host:$(`${protocol}-host`).value.trim(),port:Number($(`${protocol}-port`).value),secure:$(`${protocol}-secure`).value==='true',user:$(`${protocol}-user`).value.trim()||defaultUser(protocol),password:$(`${protocol}-password`).value || (protocol==='smtp'?$('imap-password').value:'')};
    configureBusy=true;renderSetup();errorAt('settings-error',null);
    try{
      state.identity=await invoke('configure',account);
      $('imap-password').value='';$('smtp-password').value='';$('settings-dialog').close();notice('Kontoen er forbundet.');
      text($('account-address'),state.identity.account?.email || account.email);state.folder='INBOX';state.viewId='inbox';state.keywordLabel='';state.availableLabels=[];state.keywordLabels=false;renderKeywordFilter();state.page=1;state.query='';state.view='mail';$('search').value='';setReader(null);$('workspace').hidden=false;await refreshFolders();await loadMessages();await refreshDrafts();
    }catch(error){errorAt('settings-error',error);}
    finally{configureBusy=false;renderSetup();}
  }
  const navIcons={
    inbox:'M3 13l3-8h12l3 8v6H3z M3 13h5l2 3h4l2-3h5',
    starred:'M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z',
    snoozed:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z M12 7v5l3 2',
    important:'M4 6h11l5 6-5 6H4l4-6z',sent:'M3 4l18 8-18 8 3-8z M6 12h15',
    drafts:'M6 3h8l4 4v14H6z M14 3v5h4',purchases:'M5 8h14l1 12H4z M9 9V7a3 3 0 0 1 6 0v2',
    social:'M2 20v-2c0-3 3-5 7-5s7 2 7 5v2z M12 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0z M16 5a3 3 0 0 1 0 6 M18 14c3 0 4 2 4 4v2h-3',
    updates:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z M12 11v5 M12 8h.01',
    forums:'M3 4h14v10H8l-5 4z M9 17h7l5 3V8',promotions:'M3 4h8l10 10-7 7L3 10z M7 7h.01',
    scheduled:'M4 4l16 7-5 2 M4 4l2 7-2 8 5-2 M6 11h6 M21 17a5 5 0 1 1-10 0 5 5 0 0 1 10 0z M16 14v3l2 1',
    all:'M4 8h15v12H4z M4 8l7.5 6L19 8 M6 5h15v12',archive:'M3 4h18v5H3z M5 9v11h14V9 M9 13h6',
    spam:'M8 3h8l5 5v8l-5 5H8l-5-5V8z M12 7v6 M12 16h.01',trash:'M4 6h16 M9 6V4h6v2 M6 6l1 14h10l1-14 M10 9v8 M14 9v8',
    subscriptions:'M3 6h18v6 M3 6v13h9 M3 7l8 6 9-6 M22 17a5 5 0 1 1-10 0 5 5 0 0 1 10 0z M15 17h4',
    label:'M3 5h9l9 7-9 7H3z M7 12h.01',folder:'M3 6h6l2 2h10v12H3z',
    manage:'M4 6h5 M13 6h7 M4 12h11 M19 12h1 M4 18h3 M11 18h9 M9 3v6 M15 9v6 M7 15v6',
    expand:'M6 9l6 6 6-6',collapse:'M6 15l6-6 6 6'
  };
  function navIcon(id){
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('class','folder-icon');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
    const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',navIcons[id] || navIcons.folder);
    svg.append(path);return svg;
  }
  function navButton(name,icon,click){
    const button=node('button','folder');button.type='button';button.title=name;
    button.append(navIcon(icon),node('span','folder-name',name));
    button.addEventListener('click',click);return button;
  }
  function navCount(button,count){
    if(Number.isInteger(count) && count>0)button.append(node('span','folder-count',count.toLocaleString('da-DK')));
  }
  function activeView(){return state.views.find(view=>view.id===state.viewId);}
  function customLabels(){return state.folders.filter(folder=>folder.label);}
  function renderFolders(){
    const primary=$('folders'),secondary=$('more-folders'),labels=$('label-folders');
    const focusKey=document.activeElement?.dataset?.nav;
    primary.replaceChildren();secondary.replaceChildren();labels.replaceChildren();
    const more=new Set(['scheduled','all','spam','trash','archive','subscriptions']);
    const usedPaths=new Set();
    for(const view of state.views){
      if(view.folder && !view.filter)usedPaths.add(view.folder);
      const button=navButton(view.id==='subscriptions'?'Abonnementer':view.name,view.id,()=>{
        if(view.webView){
          void invoke('openProviderView',{webView:view.webView}).catch(error=>notice(errorText(error)));
        }else{
          void changeFolder(view.folder,view.id);
        }
      });
      button.dataset.nav='view:'+view.id;
      if(view.webView){
        button.title=view.name+' · Åbner i Gmail';button.setAttribute('aria-label',button.title);
        button.append(node('span','provider-link','↗'));
      }else{
        button.setAttribute('aria-current',String(state.view==='mail' && view.id===state.viewId));
        navCount(button,view.id==='drafts'?view.total:view.unseen);
      }
      (more.has(view.id)?secondary:primary).append(button);
    }
    for(const folder of state.folders){
      if(usedPaths.has(folder.path))continue;
      const name=folder.label?folder.path:folderName(folder);
      const button=navButton(name,folder.label?'label':'folder',()=>changeFolder(folder.path,null));
      button.dataset.nav='folder:'+folder.path;button.setAttribute('aria-current',String(state.view==='mail' && !state.viewId && folder.path===state.folder));
      navCount(button,folder.unseen);
      (folder.label?labels:secondary).append(button);
    }
    $('folder-disclosure').hidden=!secondary.childElementCount;
    const expanded=$('folder-disclosure').getAttribute('aria-expanded')==='true';
    secondary.hidden=!expanded;
    $('folder-disclosure').replaceChildren(navIcon(expanded?'collapse':'expand'),node('span','folder-name',expanded?'Vis færre':'Vis flere'));
    $('labels-section').hidden=!state.gmail;
    $('drafts').setAttribute('aria-current',String(state.view==='drafts'));
    if(focusKey){
      Array.from(document.querySelectorAll('[data-nav]')).find(button=>button.dataset.nav===focusKey)?.focus({preventScroll:true});
    }
  }
  async function refreshFolders(){
    const data=await invoke('sidebar');
    state.folders=data.folders;state.views=data.views;state.gmail=data.gmail;
    if(state.viewId && !activeView() || !state.folders.some(folder=>folder.path===state.folder)){
      const fallback=state.views.find(view=>view.id==='inbox') || state.views.find(view=>view.folder);
      state.folder=fallback?.folder || state.folders[0]?.path || 'INBOX';state.viewId=fallback?.id || null;
    }
    renderFolders();
  }
  async function changeFolder(folder,viewId){
    state.keywordLabel='';state.availableLabels=[];state.keywordLabels=false;renderKeywordFilter();
    state.view='mail';state.folder=folder;state.viewId=viewId;state.page=1;state.query='';$('search').value='';setReader(null);await loadMessages();
  }
  async function loadMessages(){
    const epoch=++state.listEpoch;
    const {identity,folder,query,page,viewId,keywordLabel}=state;
    const view=activeView();
    const samePage=state.view==='mail' && listedPage?.identity===identity &&
      listedPage.keywordLabel===keywordLabel && listedPage.viewId===viewId && listedPage.folder===folder && listedPage.query===query && listedPage.page===page;
    state.view='mail';
    renderFolders();
    const currentFolder=state.folders.find(f=>f.path===folder);
    text($('folder-title'),view?.name || (currentFolder?folderName(currentFolder):folder));
    $('search-form').hidden=false;
    $('pagination').hidden=false;
    if(!samePage){
      clearVisiblePage();
      setReader(null);
      listedPage=null;
      state.messages=[];
      state.uidValidity=null;
      $('messages').replaceChildren();
      $('messages').scrollTop=0;
      text($('list-state'),'Henter mails …');
      $('previous').disabled=true;
      $('next').disabled=true;
    }
    try{
      const result=await invoke('messages',{folder,...(view?.filter?{filter:view.filter}:{}),...(keywordLabel?{keywordLabel}:{}),query,page,pageSize:40});
      if(epoch!==state.listEpoch)return;
      if(!result.messages.length && page>1){state.page--;return loadMessages();}
      const selection=wantedRead || state.current;
      if(selection && (selection.uidValidity!==result.uidValidity || !result.messages.some(item=>item.uid===selection.uid)))setReader(null);
      if(state.uidValidity!==result.uidValidity)$('messages').replaceChildren();
      state.keywordLabels=!!result.keywordLabels && !state.gmail;
      state.availableLabels=Array.isArray(result.availableLabels)?result.availableLabels:[];
      renderKeywordFilter();
      listedPage={identity,folder,viewId,keywordLabel,query,page};
      state.messages=result.messages;
      state.uidValidity=result.uidValidity;
      renderMessages();
      const openRow=state.current && result.messages.find(item=>item.uid===state.current.uid);
      if(openRow){
        if(Array.isArray(openRow.labels))state.current.labels=openRow.labels;
        if(typeof openRow.important==='boolean')state.current.important=openRow.important;
        renderLabelChips($('message-labels'),state.current.labels);
        renderImportant(state.current);
      }
      setVisiblePage(folder,result.uidValidity,result.pageToken);
      text($('list-state'),result.messages.length?'':query?'Ingen mails matcher din søgning.':'Her er ingen mails endnu.');
      text($('page-label'),`${result.total} mails · side ${page}`);
      $('previous').disabled=page<=1;
      $('next').disabled=!result.hasNext;
    }catch(error){
      if(epoch===state.listEpoch){
        if(!samePage)text($('list-state'),errorText(error));
        notice('Kunne ikke hente mappen. Tryk på opdater for at prøve igen.');
      }
    }
  }
  function updateRowStates(){
    const selection=wantedRead || state.current;
    for(const button of $('messages').querySelectorAll('button[data-uid]')){
      const uid=Number(button.dataset.uid);
      const row=state.messages.find(message=>message.uid===uid);
      button.classList.toggle('unread',!!row && !row.seen);
      button.setAttribute('aria-current',String(selection?.uid===uid && selection.folder===state.folder));
    }
  }
  function renderMessages(){
    const list=$('messages');
    const remaining=new Map([...list.children].map(li=>[Number(li.firstElementChild.dataset.uid),li]));
    let index=0;
    for(const {uid,from,date,flagged,subject,labels} of state.messages){
      let li=remaining.get(uid);
      remaining.delete(uid);
      if(!li){
        li=node('li');
        const button=node('button','message-row'),row=node('span','row'),title=node('span','subject');
        button.type='button';
        button.dataset.uid=String(uid);
        row.append(node('span','sender'),node('span','date'));
        title.append(node('span','star','★'),node('span','subject-text'));
        button.append(row,title,node('span','row-labels'));
        li.append(button);
        button.addEventListener('click',()=>openMessage(uid));
      }
      const fields={sender:from?.map(a=>a.name || a.address).join(', ') || 'Ukendt afsender',date:showDate(date),'subject-text':subject || '(Intet emne)'};
      for(const [key,value] of Object.entries(fields)){
        const field=li.querySelector('.'+key);
        if(field.textContent!==value)field.textContent=value;
      }
      li.querySelector('.star').hidden=!flagged;
      renderLabelChips(li.querySelector('.row-labels'),labels);
      if(list.children[index]!==li)list.insertBefore(li,list.children[index] || null);
      index++;
    }
    for(const li of remaining.values())li.remove();
    updateRowStates();
  }
  function openMessage(uid){
    const {folder,uidValidity,identity}=state;
    const matches=target=>target?.folder===folder && target.uid===uid && target.uidValidity===uidValidity;
    if(matches(wantedRead))return;
    const row=state.messages.find(item=>item.uid===uid);
    if(!activeRead && matches(state.current) && Date.now()-openedAt<30_000 && state.current.seen && row?.seen && state.current.flagged===row.flagged){
      $('workspace').classList.add('reading');
      return;
    }
    const request=matches(activeRead) && activeRead.identity===identity ? activeRead : {folder,uid,uidValidity,identity,sizeHint:row?.size};
    text($('pending-subject'),row?.subject || '(Intet emne)');
    setReader(null,request);
    updateRowStates();
    if(!activeRead)void readSelection();
  }
  async function readSelection(){
    // The native account queue serializes reads. Only enqueue the latest selection
    // once the current request finishes, so skipped rows do not delay it.
    while(wantedRead){
      const request=activeRead=wantedRead;
      const {folder,uid,uidValidity,sizeHint}=request;
      try{
        const message=await invoke('message',{folder,uid,uidValidity,sizeHint,markSeen:false});
        if(wantedRead!==request)continue;
        if(state.view!=='mail' || folder!==state.folder || uidValidity!==state.uidValidity || request.identity!==state.identity){
          setReader(null);
          continue;
        }
        const row=state.messages.find(item=>item.uid===uid);
        const opened={...message,folder,seen:true,richMode:true,imagesEnabled:false,
          labels:row?.labels ?? message.labels,important:row?.important ?? message.important};
        if(hasRichBody(opened)){
          await prepareRichBody(opened);
          if(wantedRead!==request)continue;
        }
        setReader(opened);
        if(row){row.seen=true;delete row.pendingSeen;}
        updateRowStates();
        renderMessage();
        if(!message.seen)void markOpenedRead(opened,row);
      }catch(error){
        if(wantedRead===request){
          setReader(null);
          updateRowStates();
          notice(errorText(error));
        }
      }finally{activeRead=null;}
    }
  }
  async function markOpenedRead(opened,row){
    // Queue the read flag before the next click, so an explicit “Markér
    // ulæst” follows it on the server. Showing the body never waits for it.
    const {folder,uid,uidValidity}=opened;
    const attempt=Symbol();
    if(row)row.pendingSeen=attempt;
    try{
      await invoke('action',{folder,uid,uidValidity,action:'read'});
    }catch{
      if(row?.pendingSeen===attempt)row.seen=false;
      if(state.current===opened && opened.seen && !opened.seenEdited){
        opened.seen=false;
        renderMessage();
        notice('Mailen er åben. Den kunne ikke markeres som læst hos din mailudbyder.');
      }
      if(state.view==='mail' && state.messages.includes(row))updateRowStates();
    }finally{
      if(row?.pendingSeen===attempt)delete row.pendingSeen;
    }
  }
  function renderMessage(){
    const message=state.current;if(!message)return;
    $('edit-labels').hidden=!(state.gmail || state.keywordLabels);
    renderLabelChips($('message-labels'),message.labels);
    renderImportant(message);
    text($('message-subject'),message.subject || '(Intet emne)');text($('message-from'),addressList(message.from));text($('message-date'),showDate(message.date,true));
    text($('sender-avatar'),(message.from?.[0]?.name || message.from?.[0]?.address || '?').slice(0,2).toUpperCase());
    text($('message-recipients'),[`Til: ${addressList(message.to)}`,message.cc?.length?`Cc: ${addressList(message.cc)}`:''].filter(Boolean).join(' · '));
    text($('message-body'),message.text || '(Denne mail har ingen tekstversion.)');$('truncation-note').hidden=!message.textTruncated;
    const rich=hasRichBody(message);
    $('rich-controls').hidden=!rich;$('message-frame').hidden=!rich||!message.richMode;$('message-body').hidden=rich&&message.richMode;
    text($('toggle-format'),message.richMode?'Vis som tekst':'Vis originalt layout');$('remote-images').hidden=!rich||!message.hasRemoteImages;
    text($('images-note'),message.imagesEnabled?'Eksterne billeder er tilladt i denne mail.':'Eksterne billeder er skjult. Afsenderen kan registrere, at du åbner dem.');text($('load-images'),message.imagesEnabled?'Skjul eksterne billeder':'Vis billeder i denne mail');
    if(rich&&message.richMode&&$('message-frame').getAttribute('src')!==message.htmlUrl)$('message-frame').src=message.htmlUrl;
    if(!rich)$('message-frame').removeAttribute('src');
    text($('toggle-read'),message.seen?'Markér ulæst':'Markér læst');text($('toggle-star'),message.flagged?'★ Fjern stjerne':'☆ Stjernemarkér');
    $('message-attachments').replaceChildren();
    for(const file of message.attachments || []){
      const button=node('button','attachment',`↓ ${file.filename}${attachmentSizeSuffix(file.size)}`);button.type='button';button.title='Gem vedhæftet fil';
      button.addEventListener('click',async()=>{if(state.current!==message)return;button.disabled=true;try{await invoke('saveAttachment',{folder:message.folder,uid:message.uid,uidValidity:message.uidValidity,index:file.index});}catch(error){notice(errorText(error));}finally{button.disabled=false;}});
      $('message-attachments').append(button);
    }
  }
  async function toggleImages(){
    const message=state.current;if(!message?.htmlUrl)return;const previous=message.htmlUrl;$('load-images').disabled=true;
    try{
      const result=await invoke('messageImages',{htmlUrl:previous,enabled:!message.imagesEnabled});
      if(state.current===message){Object.assign(message,result);message.imagesEnabled=!message.imagesEnabled;renderMessage();}
    }catch(error){notice(errorText(error));}finally{$('load-images').disabled=false;}
  }
  async function messageAction(action){
    const target=selected();if(!target)return;const opened=state.current;const buttons=document.querySelectorAll('.message-actions button');buttons.forEach(b=>b.disabled=true);
    try{
      await invoke('action',{...target,action});
      if(state.current===opened){
        if(action==='archive'||action==='trash'){setReader(null);}
        else{
          if(action==='read'||action==='unread'){
            opened.seen=action==='read';opened.seenEdited=true;
            const row=state.messages.find(item=>item.uid===target.uid);
            if(row){row.seen=opened.seen;delete row.pendingSeen;}
          }else if(action==='important'||action==='unimportant'){opened.important=action==='important';}
          else opened.flagged=action==='star';
          renderMessage();
        }
      }
      if(state.folder===target.folder&&state.view==='mail')await loadMessages();await refreshFolders();
    }catch(error){notice(errorText(error));}finally{buttons.forEach(b=>b.disabled=false);}
  }
  function renderKeywordFilter(){
    const select=$('keyword-select');
    const names=new Set(state.availableLabels);
    if(state.keywordLabel)names.add(state.keywordLabel);
    $('keyword-filter').hidden=!state.keywordLabels || !names.size || state.view!=='mail';
    const option=node('option','', 'Alle etiketter og mails uden etiket');option.value='';
    select.replaceChildren(option);
    for(const name of names){
      const choice=node('option','',name);choice.value=name;select.append(choice);
    }
    select.value=state.keywordLabel;
  }
  function renderImportant(message){
    const button=$('toggle-important');
    button.hidden=!state.gmail;
    button.setAttribute('aria-pressed',String(!!message.important));
    text(button,message.important?'Fjern vigtigmarkering':'Markér vigtig');
  }
  function renderLabelChips(container,names){
    const labels=Array.isArray(names)?names:[];
    container.hidden=!labels.length;
    if(container.childElementCount===labels.length && labels.every((name,i)=>container.children[i].textContent===name))return;
    container.replaceChildren(...labels.map(name=>{
      const chip=node('span','label-chip',name);chip.title=name;return chip;
    }));
    container.title=labels.join(', ');
  }
  let labelDialog=null;
  function openLabelDialog(mode){
    const message=mode==='apply'?state.current:null;
    if(mode==='apply' ? !message || !(state.gmail || state.keywordLabels) : !state.gmail)return;
    labelDialog={message,newNames:[],checked:new Set(message?.labels || []),form:mode==='create'?'create':null,busy:false};
    errorAt('label-error',null);
    $('label-name').value='';$('label-name').setCustomValidity('');
    renderLabelDialog();
    $('labels-dialog').showModal();
    if(mode==='create')$('label-name').focus();
  }
  function editLabelName(form,name=''){
    labelDialog.form=form;labelDialog.target=name;$('label-name').setCustomValidity('');
    $('label-name').value=form==='rename'?name:'';
    errorAt('label-error',null);
    renderLabelDialog();
    if(form==='rename' || form==='create'){
      $('label-name').focus();$('label-name').select();
    }else if(form==='delete')$('cancel-delete-label').focus();
  }
  function renderLabelDialog(){
    const context=labelDialog;
    if(!context)return;
    const {message,checked,form,busy}=context;
    const labels=state.gmail?customLabels().map(folder=>folder.path):[...new Set([...state.availableLabels,...(message?.labels || []),...context.newNames])];
    text($('label-dialog-title'),message?'Etiketter på mailen':'Administrer etiketter');
    text($('label-dialog-context'),message?message.subject:state.identity?.account?.email);
    const list=$('label-options');
    list.replaceChildren();
    if(!labels.length && !form)list.append(node('p','label-empty','Du har ingen etiketter endnu.'));
    for(const name of labels){
      const row=node('div','label-option');
      if(message){
        const label=node('label','label-check');
        const check=node('input');check.type='checkbox';check.checked=checked.has(name);
        check.addEventListener('change',()=>{
          if(check.checked)checked.add(name);else checked.delete(name);
          $('apply-labels').disabled=!labelChanges().changed;
        });
        label.append(check,node('span','label-text',name));row.append(label);
      }else{
        row.append(navIcon('label'),node('span','label-text',name));
        for(const [operation,title] of [['rename','Omdøb'],['delete','Slet']]){
          const button=node('button','quiet',title);button.type='button';button.setAttribute('aria-label',title+' '+name);
          button.addEventListener('click',()=>editLabelName(operation,name));row.append(button);
        }
      }
      list.append(row);
    }
    const editing=form==='rename'||form==='create';
    list.hidden=!!form && !message;
    $('label-name-form').hidden=!editing;
    $('label-confirm').hidden=form!=='delete';
    if(editing)text($('submit-label-name'),form==='rename'?'Gem navn':'Opret');
    if(form==='delete')text($('label-confirm-text'),'Slet etiketten “'+context.target+'” fra din konto? Mailene bliver i postkassen.');
    $('add-label').hidden=!!form;$('apply-labels').hidden=!message || !!form;
    for(const el of $('labels-dialog').querySelectorAll('button,input'))el.disabled=busy;
    if(message)$('apply-labels').disabled=busy || !labelChanges().changed;
  }
  function labelChanges(){
    const original=new Set(labelDialog.message.labels || []);
    const checked=labelDialog.checked;
    const add=[...checked].filter(name=>!original.has(name));
    const remove=[...original].filter(name=>!checked.has(name));
    return {add,remove,changed:!!(add.length || remove.length)};
  }
  async function manageLabel(operation){
    const context=labelDialog;
    if(!context || context.busy)return;
    const entered=$('label-name').value.trim();
    if(operation!=='delete' && !entered){
      $('label-name').setCustomValidity('Indtast et navn.');$('label-name').reportValidity();return;
    }
    if(!state.gmail && operation==='create'){
      if([...entered].length>40 || new TextEncoder().encode(entered).length>120 || /[\u0000-\u001f\u007f]/.test(entered)){
        errorAt('label-error','Brug højst 40 tegn og 120 byte til etikettens navn.');return;
      }
      context.newNames.push(entered);
      context.checked.add(entered);context.form=null;errorAt('label-error',null);renderLabelDialog();
      $('apply-labels').focus();return;
    }
    const name=operation==='create'?entered:context.target;
    const wasSelected=state.view==='mail' && !state.viewId && state.folder===name;
    context.busy=true;renderLabelDialog();errorAt('label-error',null);
    try{
      await invoke('manageLabel',{operation,name,...(operation==='rename'?{newName:entered}:{})});
      if(wasSelected && operation==='rename')state.folder=entered;
      if(context.message && operation==='create')context.checked.add(entered);
      context.form=null;
      await refreshFolders();
      if(state.view==='mail' && operation!=='create')await loadMessages();
      if(!context.message && operation==='create')notice('Etiketten er oprettet.');
    }catch(error){errorAt('label-error',error);}
    finally{context.busy=false;renderLabelDialog();}
  }
  async function applyLabels(){
    const context=labelDialog;
    if(!context?.message || context.busy || state.current!==context.message)return;
    const target=selected(),changes=labelChanges();
    if(!changes.changed)return;
    context.busy=true;renderLabelDialog();errorAt('label-error',null);
    try{
      await invoke('messageLabel',{...target,add:changes.add,remove:changes.remove});
      context.message.labels=[...context.checked];
      const row=state.messages.find(item=>item.uid===target.uid);
      if(row)row.labels=context.message.labels;
      renderMessages();renderLabelChips($('message-labels'),context.message.labels);
      $('labels-dialog').close();
      await loadMessages();await refreshFolders();
    }catch(error){
      await loadMessages();
      if(state.current===context.message){
        context.checked=new Set(context.message.labels || []);errorAt('label-error',error);
      }else{
        if($('labels-dialog').open)$('labels-dialog').close();
        notice(errorText(error));
      }
    }finally{context.busy=false;renderLabelDialog();}
  }
  async function refreshDrafts(){state.drafts=await invoke('drafts');text($('draft-count'),state.drafts.length?String(state.drafts.length):'');}
  async function showDrafts(){
    clearVisiblePage();
    listedPage=null;state.view='drafts';renderKeywordFilter();state.listEpoch++;setReader(null);renderFolders();$('search-form').hidden=true;$('pagination').hidden=true;text($('folder-title'),'Kladder');text($('list-state'),'Henter kladder …');$('messages').replaceChildren();
    try{
      await refreshDrafts();if(state.view!=='drafts')return;
      text($('list-state'),state.drafts.length?'Kladder gemmes krypteret på denne computer.':'Ingen gemte kladder på denne computer.');
      for(const draft of state.drafts){
        const li=node('li'),button=node('button','message-row');button.type='button';button.append(node('span','sender',draft.to || '(Ingen modtager)'),node('span','subject',draft.subject || '(Intet emne)'));
        button.addEventListener('click',()=>openCompose(draft));li.append(button);$('messages').append(li);
      }
    }catch(error){text($('list-state'),errorText(error));}
  }
  function openCompose(draft={}){
    clearTimeout(draftTimer);state.draftEpoch++;state.draft={...draft,attachments:(draft.attachments || []).map(a=>({...a})),forwardedAttachments:(draft.forwardedAttachments || []).map(a=>({...a}))};
    for(const field of ['to','cc','bcc','subject'])$(field).value=draft[field] || '';$('body').value=draft.text || '';
    text($('compose-title'),draft.id?'Fortsæt din kladde':'Ny mail');text($('compose-from'),`Fra ${state.identity?.account?.email || ''}`);text($('draft-status'),draft.id?'Kladde gemt på denne computer.':'');errorAt('compose-error',null);renderComposeAttachments();
    if(!$('compose-dialog').open)$('compose-dialog').showModal();$('to').focus();
  }
  function snapshotDraft(){return {...state.draft,to:$('to').value,cc:$('cc').value,bcc:$('bcc').value,subject:$('subject').value,text:$('body').value,attachments:state.draft.attachments.map(a=>({...a}))};}
  function hasContent(draft){return ['to','cc','bcc','subject','text'].some(k=>draft[k])||draft.attachments.length||draft.forwardedAttachments?.length;}
  function saveDraft(){
    clearTimeout(draftTimer);if(!state.draft||state.sending||state.uploading)return draftChain;
    const snapshot=snapshotDraft(),epoch=state.draftEpoch;if(!hasContent(snapshot))return draftChain;
    const task=draftChain.catch(()=>{}).then(async()=>{
      if(epoch!==state.draftEpoch)return;
      const saved=await invoke('saveDraft',{...snapshot,id:state.draft.id});
      if(epoch===state.draftEpoch){state.draft.id=saved.id;text($('draft-status'),'Kladde gemt på denne computer.');}
      await refreshDrafts();
    });
    draftChain=task;return task;
  }
  function scheduleDraft(){if(!state.draft)return;text($('draft-status'),'Gemmer kladde …');clearTimeout(draftTimer);draftTimer=setTimeout(()=>saveDraft().catch(error=>errorAt('compose-error',error)),800);}
  async function closeCompose(){if(state.sending||state.uploading)return;try{await saveDraft();$('compose-dialog').close();if(state.view==='drafts')await showDrafts();}catch(error){errorAt('compose-error',error);}}
  async function discardDraft(){
    if(state.sending||state.uploading)return;clearTimeout(draftTimer);
    try{await draftChain.catch(()=>{});if(state.draft?.id)await invoke('deleteDraft',{id:state.draft.id});state.draftEpoch++;state.draft=null;$('compose-dialog').close();await refreshDrafts();if(state.view==='drafts')await showDrafts();}catch(error){errorAt('compose-error',error);}
  }
  function composeReply(all=false,forward=false){
    const message=state.current;if(!message)return;
    const me=state.identity.account.email.toLowerCase();const seen=new Set([me]);
    function unique(list){return list.filter(a=>{const key=a.address.toLowerCase();if(seen.has(key))return false;seen.add(key);return true;});}
    const sender=message.replyTo?.length?message.replyTo:message.from;
    const to=forward?[]:unique(all?[...sender,...message.to]:sender);
    const cc=!forward&&all?unique(message.cc || []):[];
    const prefix=forward?'Fwd: ':'Re: ',subject=new RegExp(`^${forward?'(?:fwd?|vs)':'(?:re|sv)'}:`, 'i').test(message.subject)?message.subject:prefix+message.subject;
    const quote=`\n\n${forward?'---------- Videresendt mail ----------':'Den '+showDate(message.date,true)+' skrev '+addressList(message.from)+':'}\n${forward?`Fra: ${addressList(message.from)}\nTil: ${addressList(message.to)}\nDato: ${showDate(message.date,true)}\nEmne: ${message.subject}\n\n`:''}${(message.text || '').split('\n').map(line=>forward?line:'> '+line).join('\n')}`;
    openCompose({to:recipientString(to),cc:recipientString(cc),subject,text:quote,attachments:[],forwardedAttachments:forward?(message.attachments || []).map(file=>({...file,folder:message.folder,uid:message.uid,uidValidity:message.uidValidity,mailboxKey:message.mailboxKey})):[],...(!forward?{inReplyTo:message.messageId,references:[...(message.references || []),message.messageId].filter(Boolean)}:{})});
    $('body').focus();$('body').setSelectionRange(0,0);scheduleDraft();
  }
  function renderComposeAttachments(){
    $('compose-attachments').replaceChildren();
    for(const [index,file] of (state.draft?.attachments || []).entries()){
      const button=node('button','attachment',`${file.filename} · ${bytes(Math.floor(file.data.length*3/4))} ×`);button.type='button';button.title='Fjern vedhæftet fil';
      button.addEventListener('click',()=>{if(state.sending)return;state.draft.attachments.splice(index,1);renderComposeAttachments();scheduleDraft();});$('compose-attachments').append(button);
    }
    for(const [index,file] of (state.draft?.forwardedAttachments || []).entries()){
      const button=node('button','attachment',`${file.filename}${attachmentSizeSuffix(file.size)} · videresendes ×`);button.type='button';button.title='Fjern vedhæftet fil fra videresendelsen';
      button.addEventListener('click',()=>{if(state.sending)return;state.draft.forwardedAttachments.splice(index,1);renderComposeAttachments();scheduleDraft();});$('compose-attachments').append(button);
    }
  }
  async function addAttachments(){
    const files=Array.from($('attachment-input').files || []);$('attachment-input').value='';if(!files.length||!state.draft)return;
    errorAt('compose-error',null);state.uploading=true;$('send').disabled=true;
    try{
      const existing=state.draft.attachments.reduce((sum,a)=>sum+Math.floor(a.data.length*3/4),0)+state.draft.forwardedAttachments.reduce((sum,a)=>sum+(Number.isSafeInteger(a.size)?Math.max(0,a.size):0),0);
      if(existing+files.reduce((sum,f)=>sum+f.size,0)>20*1024*1024)throw new Error('Vedhæftninger må tilsammen fylde højst 20 MB.');
      if(state.draft.attachments.length+state.draft.forwardedAttachments.length+files.length>30)throw new Error('Du kan vedhæfte højst 30 filer.');
      const pending=[];
      for(const file of files){const buffer=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<buffer.length;i+=32768)binary+=String.fromCharCode(...buffer.subarray(i,i+32768));pending.push({filename:file.name,contentType:file.type || 'application/octet-stream',data:btoa(binary)});}
      state.draft.attachments.push(...pending);renderComposeAttachments();
    }catch(error){errorAt('compose-error',error);}finally{state.uploading=false;$('send').disabled=false;scheduleDraft();}
  }
  async function send(event){
    event.preventDefault();if(state.sending||state.uploading)return;errorAt('compose-error',null);clearTimeout(draftTimer);
    const saved=saveDraft();state.sending=true;let deliveryStarted=false;
    document.querySelectorAll('#compose-form button,#compose-form input,#compose-form textarea').forEach(el=>el.disabled=true);text($('send'),'Sender …');
    try{
      await saved;const payload=snapshotDraft();deliveryStarted=true;
      const result=await invoke('send',payload);
      if(result.rejected?.length){
        $('to').value=result.rejected.join(', ');$('cc').value='';$('bcc').value='';errorAt('compose-error',`Mailen er sendt til ${result.accepted?.length || 0} modtagere. Disse adresser blev afvist: ${result.rejected.join(', ')}. Kun de afviste står nu i modtagerfeltet.`);
        if(result.warning)notice(result.warning);
      }else{
        if(state.draft.id){try{await invoke('deleteDraft',{id:state.draft.id});}catch{notice('Mailen er sendt, men den lokale kladde kunne ikke fjernes. Send den ikke igen.');}}
        state.draftEpoch++;state.draft=null;$('compose-dialog').close();notice(result.warning || 'Din mail er sendt.');await refreshDrafts();if(state.view==='drafts')await showDrafts();
      }
    }catch(error){errorAt('compose-error',errorText(error)+(deliveryStarted?'\nHvis forbindelsen blev afbrudt under afsendelsen, kan mailen være leveret. Kontrollér Sendt, inden du prøver igen.':''));}
    finally{state.sending=false;document.querySelectorAll('#compose-form button,#compose-form input,#compose-form textarea').forEach(el=>el.disabled=false);text($('send'),'Send mail ↗');if(state.draft)await saveDraft().catch(error=>errorAt('compose-error',error));}
  }
  $('settings').addEventListener('click',openSettings);$('provider').addEventListener('change',providerChanged);$('settings-form').addEventListener('submit',configure);$('close-settings').addEventListener('click',()=>$('settings-dialog').close());
  $('settings-dialog').addEventListener('cancel',event=>{if(!state.identity?.configured||oauthBusy||configureBusy)event.preventDefault();});
  $('manual-alternative').addEventListener('click',()=>{gmailManual=!gmailManual;errorAt('settings-error',null);renderSetup();});
  $('advanced-settings').addEventListener('toggle',renderSetup);
  $('advanced-settings').querySelector('summary').addEventListener('click',event=>{if(oauthBusy||configureBusy)event.preventDefault();});
  $('account-email').addEventListener('input',updatePasswordRequirement);$('advanced-fields').addEventListener('input',updatePasswordRequirement);
  for(const provider of ['google','microsoft'])$(`oauth-${provider}`).addEventListener('click',()=>connectOAuth(provider));
  $('oauth-cancel').addEventListener('click',()=>invoke('oauthCancel').catch(error=>errorAt('settings-error',error)));
  $('keyword-select').addEventListener('change',()=>{
    state.keywordLabel=$('keyword-select').value;state.page=1;void loadMessages();
  });
  $('folder-disclosure').addEventListener('click',()=>{
    const btn=$('folder-disclosure');btn.setAttribute('aria-expanded',String(btn.getAttribute('aria-expanded')!=='true'));renderFolders();
  });
  $('manage-labels').prepend(navIcon('manage'));
  $('manage-labels').addEventListener('click',()=>openLabelDialog('manage'));
  $('new-label').addEventListener('click',()=>openLabelDialog('create'));
  $('edit-labels').addEventListener('click',()=>openLabelDialog('apply'));
  $('apply-labels').addEventListener('click',applyLabels);
  $('add-label').addEventListener('click',()=>editLabelName('create'));
  $('label-name-form').addEventListener('submit',event=>{event.preventDefault();void manageLabel(labelDialog.form);});
  $('label-name').addEventListener('input',()=>$('label-name').setCustomValidity(''));
  $('confirm-delete-label').addEventListener('click',()=>manageLabel('delete'));
  for(const id of ['cancel-label-name','cancel-delete-label'])$(id).addEventListener('click',()=>editLabelName(null));
  $('close-labels').addEventListener('click',()=>$('labels-dialog').close());
  $('labels-dialog').addEventListener('cancel',event=>{if(labelDialog?.busy)event.preventDefault();});
  $('labels-dialog').addEventListener('close',()=>{labelDialog=null;});
  $('toggle-important').addEventListener('click',()=>messageAction(state.current?.important?'unimportant':'important'));
  $('retry-start').addEventListener('click',start);$('compose').addEventListener('click',()=>openCompose());$('drafts').addEventListener('click',showDrafts);
  $('refresh').addEventListener('click',async()=>{try{notice('');if(state.view==='drafts')await showDrafts();else{await refreshFolders();await loadMessages();}}catch(error){notice(errorText(error));}});
  $('search-form').addEventListener('submit',event=>{event.preventDefault();state.query=$('search').value.trim();state.page=1;loadMessages();});
  $('search').addEventListener('search',()=>{if(!$('search').value){state.query='';state.page=1;loadMessages();}});
  $('previous').addEventListener('click',()=>{state.page=Math.max(1,state.page-1);loadMessages();});$('next').addEventListener('click',()=>{state.page++;loadMessages();});
  $('cancel-read').addEventListener('click',()=>{setReader(null);updateRowStates();});
  $('back-list').addEventListener('click',()=>{$('workspace').classList.remove('reading');});
  $('toggle-read').addEventListener('click',()=>messageAction(state.current?.seen?'unread':'read'));$('toggle-star').addEventListener('click',()=>messageAction(state.current?.flagged?'unstar':'star'));$('archive').addEventListener('click',()=>messageAction('archive'));$('trash').addEventListener('click',()=>messageAction('trash'));
  $('reply').addEventListener('click',()=>composeReply());$('reply-all').addEventListener('click',()=>composeReply(true));$('forward').addEventListener('click',()=>composeReply(false,true));
  $('toggle-format').addEventListener('click',()=>{if(state.current){state.current.richMode=!state.current.richMode;renderMessage();}});$('load-images').addEventListener('click',toggleImages);
  $('compose-form').addEventListener('submit',send);$('compose-form').addEventListener('input',scheduleDraft);$('close-compose').addEventListener('click',closeCompose);$('save-draft').addEventListener('click',()=>saveDraft().catch(error=>errorAt('compose-error',error)));$('discard-draft').addEventListener('click',discardDraft);
  $('compose-dialog').addEventListener('cancel',event=>{event.preventDefault();closeCompose();});$('attach').addEventListener('click',()=>$('attachment-input').click());$('attachment-input').addEventListener('change',addAttachments);
  start();
})();
