'use strict';
(() => {
  const $=id=>document.getElementById(id);
  const invoke=(action,payload={})=>window.veyroMail.invoke(action,payload);
  const state={identity:null,folders:[],folder:'INBOX',page:1,query:'',uidValidity:null,messages:[],current:null,drafts:[],draft:null,view:'mail',listEpoch:0,readEpoch:0,draftEpoch:0,uploading:false,sending:false};
  let draftTimer,draftChain=Promise.resolve(),oauthBusy=false,configureBusy=false,gmailManual=false;
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
  function folderName(folder){return folder.path.toUpperCase()==='INBOX'?'Indbakke':names[folder.specialUse] || folder.name;}
  function selected(){return state.current?{folder:state.current.folder,uid:state.current.uid,uidValidity:state.current.uidValidity}:null;}
  function setReader(message){state.current=message;$('message').hidden=!message;$('reader-empty').hidden=!!message;$('workspace').classList.toggle('reading',!!message);if(!message){$('message-frame').removeAttribute('src');$('message-frame').hidden=true;}}
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
      state.folder='INBOX';state.view='mail';state.page=1;state.query='';$('search').value='';setReader(null);$('workspace').hidden=false;notice('Kontoen er forbundet.');await refreshFolders();await loadMessages();await refreshDrafts();
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
      text($('account-address'),state.identity.account?.email || account.email);state.folder='INBOX';state.page=1;state.query='';state.view='mail';$('search').value='';setReader(null);$('workspace').hidden=false;await refreshFolders();await loadMessages();await refreshDrafts();
    }catch(error){errorAt('settings-error',error);}
    finally{configureBusy=false;renderSetup();}
  }
  function renderFolders(){
    $('folders').replaceChildren();
    for(const folder of state.folders){
      const button=node('button','folder',folderName(folder));button.type='button';button.setAttribute('aria-current',String(state.view==='mail'&&state.folder===folder.path));
      if(folder.unseen)button.append(node('span','',String(folder.unseen)));
      button.addEventListener('click',()=>changeFolder(folder.path));$('folders').append(button);
    }
    $('drafts').setAttribute('aria-current',String(state.view==='drafts'));
  }
  async function refreshFolders(){state.folders=await invoke('folders');if(!state.folders.some(f=>f.path===state.folder)&&state.folders.length)state.folder=state.folders[0].path;renderFolders();}
  async function changeFolder(folder){state.view='mail';state.folder=folder;state.page=1;state.query='';$('search').value='';setReader(null);state.readEpoch++;renderFolders();await loadMessages();}
  async function loadMessages(){
    const epoch=++state.listEpoch;state.view='mail';renderFolders();
    const folder=state.folders.find(f=>f.path===state.folder);text($('folder-title'),folder?folderName(folder):state.folder);
    $('search-form').hidden=false;$('pagination').hidden=false;$('messages').replaceChildren();text($('list-state'),'Henter mails …');$('previous').disabled=true;$('next').disabled=true;
    try{
      const result=await invoke('messages',{folder:state.folder,query:state.query,page:state.page,pageSize:40});if(epoch!==state.listEpoch)return;
      if(!result.messages.length&&state.page>1){state.page--;return loadMessages();}
      state.messages=result.messages;state.uidValidity=result.uidValidity;renderMessages();text($('list-state'),result.messages.length?'':state.query?'Ingen mails matcher din søgning.':'Her er ingen mails endnu.');
      text($('page-label'),`${result.total} mails · side ${state.page}`);$('previous').disabled=state.page<=1;$('next').disabled=!result.hasNext;
    }catch(error){if(epoch===state.listEpoch){text($('list-state'),errorText(error));notice('Kunne ikke hente mappen. Tryk på opdater for at prøve igen.');}}
  }
  function renderMessages(){
    $('messages').replaceChildren();
    for(const message of state.messages){
      const li=node('li'),button=node('button',`message-row${message.seen?'':' unread'}`);button.type='button';button.setAttribute('aria-current',String(state.current?.uid===message.uid&&state.current.folder===state.folder));
      const row=node('span','row');row.append(node('span','sender',message.from?.map(a=>a.name || a.address).join(', ') || 'Ukendt afsender'),node('span','date',showDate(message.date)));
      const subject=node('span','subject');if(message.flagged)subject.append(node('span','star','★'));subject.append(document.createTextNode(message.subject || '(Intet emne)'));button.append(row,subject);
      button.addEventListener('click',()=>openMessage(message.uid));li.append(button);$('messages').append(li);
    }
  }
  async function openMessage(uid){
    const epoch=++state.readEpoch,folder=state.folder,uidValidity=state.uidValidity;notice('Åbner mail …');
    try{
      const message=await invoke('message',{folder,uid,uidValidity});if(epoch!==state.readEpoch||folder!==state.folder||state.view!=='mail')return;
      setReader({...message,folder,richMode:true,imagesEnabled:false});const row=state.messages.find(m=>m.uid===uid);if(row)row.seen=true;renderMessages();renderMessage();notice('');
    }catch(error){if(epoch===state.readEpoch)notice(errorText(error));}
  }
  function renderMessage(){
    const message=state.current;if(!message)return;
    text($('message-subject'),message.subject || '(Intet emne)');text($('message-from'),addressList(message.from));text($('message-date'),showDate(message.date,true));
    text($('sender-avatar'),(message.from?.[0]?.name || message.from?.[0]?.address || '?').slice(0,2).toUpperCase());
    text($('message-recipients'),[`Til: ${addressList(message.to)}`,message.cc?.length?`Cc: ${addressList(message.cc)}`:''].filter(Boolean).join(' · '));
    text($('message-body'),message.text || '(Denne mail har ingen tekstversion.)');$('truncation-note').hidden=!message.textTruncated;
    const rich=message.richAvailable&&/^veyro:\/\/message\/[a-f\d-]{36}$/.test(message.htmlUrl || '');
    $('rich-controls').hidden=!rich;$('message-frame').hidden=!rich||!message.richMode;$('message-body').hidden=rich&&message.richMode;
    text($('toggle-format'),message.richMode?'Vis som tekst':'Vis originalt layout');$('remote-images').hidden=!rich||!message.hasRemoteImages;
    text($('images-note'),message.imagesEnabled?'Eksterne billeder er tilladt i denne mail.':'Eksterne billeder er skjult. Afsenderen kan registrere, at du åbner dem.');text($('load-images'),message.imagesEnabled?'Skjul eksterne billeder':'Vis billeder i denne mail');
    if(rich&&$('message-frame').getAttribute('src')!==message.htmlUrl)$('message-frame').src=message.htmlUrl;
    if(!rich)$('message-frame').removeAttribute('src');
    text($('toggle-read'),message.seen?'Markér ulæst':'Markér læst');text($('toggle-star'),message.flagged?'★ Fjern stjerne':'☆ Stjernemarkér');
    $('message-attachments').replaceChildren();
    for(const file of message.attachments || []){
      const button=node('button','attachment',`↓ ${file.filename} · ${bytes(file.size)}`);button.type='button';button.title='Gem vedhæftet fil';
      button.addEventListener('click',async()=>{button.disabled=true;try{await invoke('saveAttachment',{folder:message.folder,uid:message.uid,uidValidity:message.uidValidity,index:file.index});}catch(error){notice(errorText(error));}finally{button.disabled=false;}});
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
    const target=selected();if(!target)return;const buttons=document.querySelectorAll('.message-actions button');buttons.forEach(b=>b.disabled=true);
    try{
      await invoke('action',{...target,action});
      if(state.current?.uid===target.uid&&state.current.folder===target.folder){
        if(action==='archive'||action==='trash'){state.readEpoch++;setReader(null);}
        else{if(action==='read'||action==='unread')state.current.seen=action==='read';else state.current.flagged=action==='star';renderMessage();}
      }
      if(state.folder===target.folder&&state.view==='mail')await loadMessages();await refreshFolders();
    }catch(error){notice(errorText(error));}finally{buttons.forEach(b=>b.disabled=false);}
  }
  async function refreshDrafts(){state.drafts=await invoke('drafts');text($('draft-count'),state.drafts.length?String(state.drafts.length):'');}
  async function showDrafts(){
    state.view='drafts';state.listEpoch++;state.readEpoch++;setReader(null);renderFolders();$('search-form').hidden=true;$('pagination').hidden=true;text($('folder-title'),'Kladder');text($('list-state'),'Henter kladder …');$('messages').replaceChildren();
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
      const button=node('button','attachment',`${file.filename} · ${bytes(file.size)} · videresendes ×`);button.type='button';button.title='Fjern vedhæftet fil fra videresendelsen';
      button.addEventListener('click',()=>{if(state.sending)return;state.draft.forwardedAttachments.splice(index,1);renderComposeAttachments();scheduleDraft();});$('compose-attachments').append(button);
    }
  }
  async function addAttachments(){
    const files=Array.from($('attachment-input').files || []);$('attachment-input').value='';if(!files.length||!state.draft)return;
    errorAt('compose-error',null);state.uploading=true;$('send').disabled=true;
    try{
      const existing=state.draft.attachments.reduce((sum,a)=>sum+Math.floor(a.data.length*3/4),0)+state.draft.forwardedAttachments.reduce((sum,a)=>sum+a.size,0);
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
  $('retry-start').addEventListener('click',start);$('compose').addEventListener('click',()=>openCompose());$('drafts').addEventListener('click',showDrafts);
  $('refresh').addEventListener('click',async()=>{try{notice('');if(state.view==='drafts')await showDrafts();else{await refreshFolders();await loadMessages();}}catch(error){notice(errorText(error));}});
  $('search-form').addEventListener('submit',event=>{event.preventDefault();state.query=$('search').value.trim();state.page=1;loadMessages();});
  $('search').addEventListener('search',()=>{if(!$('search').value){state.query='';state.page=1;loadMessages();}});
  $('previous').addEventListener('click',()=>{state.page=Math.max(1,state.page-1);loadMessages();});$('next').addEventListener('click',()=>{state.page++;loadMessages();});
  $('back-list').addEventListener('click',()=>{$('workspace').classList.remove('reading');});
  $('toggle-read').addEventListener('click',()=>messageAction(state.current?.seen?'unread':'read'));$('toggle-star').addEventListener('click',()=>messageAction(state.current?.flagged?'unstar':'star'));$('archive').addEventListener('click',()=>messageAction('archive'));$('trash').addEventListener('click',()=>messageAction('trash'));
  $('reply').addEventListener('click',()=>composeReply());$('reply-all').addEventListener('click',()=>composeReply(true));$('forward').addEventListener('click',()=>composeReply(false,true));
  $('toggle-format').addEventListener('click',()=>{if(state.current){state.current.richMode=!state.current.richMode;renderMessage();}});$('load-images').addEventListener('click',toggleImages);
  $('compose-form').addEventListener('submit',send);$('compose-form').addEventListener('input',scheduleDraft);$('close-compose').addEventListener('click',closeCompose);$('save-draft').addEventListener('click',()=>saveDraft().catch(error=>errorAt('compose-error',error)));$('discard-draft').addEventListener('click',discardDraft);
  $('compose-dialog').addEventListener('cancel',event=>{event.preventDefault();closeCompose();});$('attach').addEventListener('click',()=>$('attachment-input').click());$('attachment-input').addEventListener('change',addAttachments);
  start();
})();
