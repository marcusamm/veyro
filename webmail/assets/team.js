(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const element = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };
  const date = value => { const d = new Date(value); return Number.isNaN(d.valueOf()) ? '' : new Intl.DateTimeFormat('da-DK', {dateStyle:'medium',timeStyle:'short'}).format(d); };
  const initials = value => String(value).split(/[ @._-]/).filter(Boolean).slice(0,2).map(s => s[0]).join('').toUpperCase();
  let session, team, current, tab = 'chat', sequence = 0, timer, noticeTimer, sending = false, refreshing = false;
  let messagesRequest = 0, postsRequest = 0, filesRequest = 0, lastDirectory = 0, sessionEpoch = 0, editorEpoch = 0;
  let displayed = [], posts = [], files = [], messageCursor = null, postCursor = null, fileCursor = null;
  const drafts = new Map(), sendAttempts = new Map();
  function notice(text) { $('notice').textContent = text; $('notice').hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => $('notice').hidden = true, 6000); }
  function error(id, text = '') { $(id).textContent = text; $(id).hidden = !text; }
  function signedOut() { clearInterval(timer); clearTimeout(noticeTimer); sessionEpoch++; editorEpoch++; sequence++; messagesRequest++; postsRequest++; filesRequest++; current = null; sendAttempts.clear(); session = null; team = null; drafts.clear(); displayed = []; posts = []; files = []; $('message-text').value = ''; $('post-form').reset(); document.querySelectorAll('dialog[open]').forEach(d => d.close()); ['messages','posts','files','people','channels','directs','post-files','conversation-members','identity','company','chat-subtitle','notice'].forEach(id => $(id).replaceChildren()); $('notice').hidden=true; $('chat-title').textContent='Generelt'; $('conversation-form').reset(); $('channel-form').reset(); $('team').hidden = true; $('loading').hidden = false; $('loading-text').textContent = 'Log ind i Veyro Mail for at åbne din virksomhed.'; $('login-link').hidden = false; }
  async function api(path, body) {
    const epoch = sessionEpoch;
    const headers = {'Accept':'application/json'};
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; headers['X-CSRF-Token'] = session?.csrfToken || ''; }
    const response = await fetch('/api/' + path, {method:body === undefined ? 'GET' : 'POST',headers,body:body === undefined ? undefined : JSON.stringify(body),credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(30000)});
    const result = await response.json().catch(() => ({error:'Serveren svarede uventet.'}));
    if (epoch !== sessionEpoch) throw new Error('Sessionen er ændret.');
    if (response.status === 401) signedOut();
    if (!response.ok) throw new Error(result.error || 'Handlingen kunne ikke gennemføres. Prøv igen.');
    return result;
  }
  function textWithLinks(container, text) {
    // Messages remain plain text. Only explicit HTTPS links become clickable.
    for (const part of String(text).split(/(https:\/\/[^\s<>]+)/g)) {
      if (part.startsWith('https://')) { try { const u = new URL(part); if (u.protocol === 'https:' && !u.username && !u.password) { const a = element('a', '', part); a.href = u.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.referrerPolicy = 'no-referrer'; container.append(a); continue; } } catch {} }
      container.append(document.createTextNode(part));
    }
  }
  const memberName = address => team?.members.find(m => m.email === address)?.name || address;
  const channelName = channel => channel.type === 'direct' ? channel.members.filter(m => m !== session?.email).map(memberName).join(', ') || 'Dig' : channel.name;
  function renderChannels() {
    $('channels').replaceChildren(); $('directs').replaceChildren();
    let unread = 0;
    for (const channel of team.channels) {
      const button = element('button','channel',(channel.type === 'direct' ? '' : '# ') + channelName(channel)); button.type = 'button'; button.setAttribute('aria-pressed',String(current === channel.id));
      if (channel.unread) { button.append(element('span','badge',String(channel.unread))); unread += channel.unread; }
      button.onclick = () => selectChannel(channel.id);
      $(channel.type === 'direct' ? 'directs' : 'channels').append(button);
    }
    $('unread').textContent = String(unread); $('unread').hidden = !unread;
  }
  async function selectChannel(id) {
    if (!team || !session) return;
    if (sending) { notice('Vent, mens beskeden sendes.'); return; }
    if (current) drafts.set(current,$('message-text').value);
    current = id; sequence++; $('chat-search').value = ''; displayed = []; messageCursor = null; $('messages').replaceChildren();
    $('message-text').value = drafts.get(id) || ''; error('message-error');
    const channel = team.channels.find(c => c.id === id); if (!channel) return;
    $('chat-title').textContent = channelName(channel); $('chat-subtitle').textContent = channel.type === 'direct' ? 'Privat samtale mellem deltagerne' : 'Åben for kollegaer i ' + (team.companyName || team.domain);
    renderChannels();
    if (location.hash !== '#chat') location.hash = 'chat'; else changeTab();
  }
  function renderMessages(scroll = false) {
    const area = $('conversation'); const nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 100;
    const oldHeight = area.scrollHeight, oldTop = area.scrollTop;
    const fragment = document.createDocumentFragment();
    for (const message of displayed) {
      const row = element('article','chat-message' + (message.author === session.email ? ' own' : '')); row.dataset.id = message.id;
      row.append(element('span','avatar',initials(memberName(message.author))));
      const content = element('div'), meta = element('div','message-meta'); meta.append(element('strong','',memberName(message.author)));
      const time = element('time','',date(message.createdAt)); time.dateTime = message.createdAt; meta.append(time);
      if (!message.deleted && (message.author === session.email || team.canManage)) { const remove = element('button','message-delete','Slet'); remove.type = 'button'; remove.setAttribute('aria-label','Slet besked fra ' + memberName(message.author)); remove.onclick = async () => { if (!confirm('Slet denne besked?')) return; remove.disabled = true; try { await api('team/messages/' + message.id + '/delete',{}); displayed = displayed.map(item=>item.id===message.id ? {...item,text:'',deleted:true} : item); if(session)renderMessages(); await loadMessages(); } catch(e) { notice(e.message); remove.disabled = false; } }; meta.append(remove); }
      const body = element('p','message-body'); textWithLinks(body,message.deleted ? 'Beskeden er slettet.' : message.text); content.append(meta,body); row.append(content); fragment.append(row);
    }
    $('messages').replaceChildren(fragment); $('chat-empty').hidden = displayed.length > 0; $('older-messages').hidden = !messageCursor;
    if (scroll || nearBottom) area.scrollTop = area.scrollHeight; else area.scrollTop = oldTop + Math.max(0,area.scrollHeight - oldHeight);
  }
  async function loadMessages(older = false, scroll = false) {
    if (!current || !session) return;
    const ownSequence = sequence, requestId = ++messagesRequest, channel = current;
    const oldestLoaded = displayed[0]?.id;
    const query = new URLSearchParams({channel}); if ($('chat-search').value.trim()) query.set('q',$('chat-search').value.trim());
    if (older && messageCursor) query.set('before',messageCursor);
    const result = await api('team/messages?' + query);
    // Revalidate loaded history, including tombstones, rather than retaining deleted text.
    if (!older && !query.has('q') && displayed.length > 50 && oldestLoaded) {
      const maxPages = Math.ceil(displayed.length / 50);
      for (let page=1; page<maxPages && result.nextBefore && !result.messages.some(m=>m.id===oldestLoaded); page++) {
        if (requestId !== messagesRequest || ownSequence !== sequence || !session) return;
        const previous = await api('team/messages?' + new URLSearchParams({channel,before:result.nextBefore}));
        result.messages = [...previous.messages,...result.messages]; result.nextBefore = previous.nextBefore;
      }
    }
    if (ownSequence !== sequence || requestId !== messagesRequest || channel !== current || !session) return;
    let next = result.messages;
    if (older) next = [...result.messages,...displayed];
    
    const unique = [...new Map(next.map(m => [m.id,m])).values()];
    const different = JSON.stringify(displayed) !== JSON.stringify(unique);
    messageCursor = result.nextBefore;
    displayed = unique;
    if (different || scroll) renderMessages(scroll);
    if (!older && !query.has('q') && !document.hidden && tab === 'chat' && displayed.length) await api('team/read',{channel,lastId:displayed.at(-1).id});
  }
  async function bootstrap() {
    const next = await api('team/bootstrap');
    if (!session || next.email !== session.email) { signedOut(); return; }
    team = next; lastDirectory = Date.now(); $('company').textContent = team.companyName || team.domain; $('identity').textContent = session.email;
    $('new-channel').hidden = !team.canManage; $('pin-label').hidden = !team.canManage;
    if (current && !team.channels.some(c => c.id === current)) { current = null; displayed = []; $('messages').replaceChildren(); $('message-text').value = ''; }
    renderChannels(); renderPeople();
  }
  async function connect() {
    sessionEpoch++;
    $('retry').hidden = true; $('loading-text').textContent = 'Henter din virksomhed …';
    try {
      session = await api('session'); await bootstrap(); if (!team) return;
      $('loading').hidden = true; $('team').hidden = false;
      current = team.channels[0]?.id || null;
      if (current) { const c = team.channels[0]; $('chat-title').textContent = channelName(c); $('chat-subtitle').textContent = 'Åben for kollegaer i ' + (team.companyName || team.domain); }
      changeTab(); renderChannels();
      clearInterval(timer); timer = setInterval(refresh,5000);
    } catch(e) { $('loading-text').textContent = e.message; $('retry').hidden = false; }
  }
  async function refresh() {
    if (document.hidden || !session || refreshing || sending) return;
    if (displayed.length > 50 && Date.now() - lastDirectory < Math.max(30000,Math.ceil(displayed.length / 50) * 1000)) return;
    refreshing = true;
    try { if (Date.now() - lastDirectory > 30000) await bootstrap(); if (tab === 'chat') await loadMessages(); $('sync-status').textContent = 'Opdateret ' + new Intl.DateTimeFormat('da-DK',{hour:'2-digit',minute:'2-digit'}).format(new Date()); }
    catch(e) { $('sync-status').textContent = 'Forbindelsen afbrudt. Prøver igen …'; }
    finally { refreshing = false; }
  }
  function changeTab() {
    tab = ['chat','intranet','people','files'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'chat';
    document.querySelectorAll('[data-tab]').forEach(a => { if (a.dataset.tab === tab) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current'); });
    for (const name of ['chat','intranet','people','files']) $('panel-' + name).hidden = name !== tab;
    $('channel-sidebar').hidden = tab !== 'chat';
    if (!session || !team) return;
    if (tab === 'intranet') loadPosts().catch(e => notice(e.message));
    if (tab === 'files') loadFiles().catch(e => notice(e.message));
    if (tab === 'people') renderPeople();
    if (tab === 'chat') loadMessages(false,true).catch(e => notice(e.message));
  }
  $('message-form').onsubmit = async event => {
    event.preventDefault(); if (sending || !current || !session) return;
    const text = $('message-text').value.trim(); if (!text) return;
    let attempt = sendAttempts.get(current);
    if (!attempt || attempt.text !== text) { attempt = {text,channel:current,clientId:crypto.randomUUID()}; sendAttempts.set(current,attempt); }
    sending = true; $('send-message').disabled = true; $('message-text').readOnly = true; error('message-error');
    try { await api('team/messages',attempt); drafts.delete(current); $('message-text').value = ''; sendAttempts.delete(current); await loadMessages(false,true); }
    catch(e) { error('message-error',e.message); }
    finally { sending = false; $('send-message').disabled = false; $('message-text').readOnly = false; $('message-text').focus(); }
  };
  $('message-text').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('message-form').requestSubmit(); } };
  $('older-messages').onclick = () => loadMessages(true).catch(e => notice(e.message));
  $('new-channel').onclick = () => { $('channel-form').reset(); error('channel-error'); $('channel-dialog').showModal(); $('channel-name').focus(); };
  $('channel-form').onsubmit = async event => { event.preventDefault(); const button = event.submitter || event.target.querySelector('button:not([type=button])'); button.disabled = true; error('channel-error'); try { const result = await api('team/channels',{name:$('channel-name').value.trim(),type:'channel',members:[]}); $('channel-dialog').close(); await bootstrap(); await selectChannel(result.channel.id); } catch(e) { error('channel-error',e.message); } finally { button.disabled = false; } };
  function renderPeople() {
    if (!team) return; const q = $('people-search').value.toLocaleLowerCase('da'); $('people').replaceChildren();
    for (const person of team.members.filter(p => (p.name+' '+p.email).toLocaleLowerCase('da').includes(q))) {
      const row = element('article','person-row'); row.append(element('span','avatar',initials(person.name || person.email)));
      const info = element('div','person-info'); info.append(element('strong','',person.name || person.email),element('p','',person.email)); row.append(info);
      if (person.email !== session.email) { const button = element('button','button','Skriv besked'); button.onclick = async () => { button.disabled = true; try { const result = await api('team/channels',{type:'direct',members:[person.email]}); await bootstrap(); await selectChannel(result.channel.id); } catch(e) { notice(e.message); } finally { button.disabled = false; } }; row.append(button); }
      else row.append(element('span','muted','Dig'));
      $('people').append(row);
    }
  }
  async function loadPosts(older = false) {
    const requestId = ++postsRequest;
    const query = new URLSearchParams({q:$('post-search').value.trim()}); if (older && postCursor) query.set('before',postCursor);
    const result = await api('team/posts?' + query); if (!session || requestId !== postsRequest) return;
    posts = older ? [...posts,...result.posts] : result.posts; postCursor = result.nextBefore; $('posts').replaceChildren(); $('older-posts').hidden = !postCursor; $('posts-empty').hidden = posts.length > 0;
    for (const post of [...posts].sort((a,b) => Number(b.pinned) - Number(a.pinned))) {
      const article = element('article','post' + (post.pinned ? ' pinned' : '')), meta = element('div','post-top');
      if (post.pinned) meta.append(element('span','pinned-tag','Fastgjort'));
      meta.append(element('span','',memberName(post.author) + ' · ' + date(post.updatedAt || post.createdAt))); article.append(meta,element('h2','',post.title));
      const body = element('p','post-body'); textWithLinks(body,post.body); article.append(body);
      for (const file of post.attachments || []) { const id = typeof file === 'string' ? file : file.id; if (!/^[a-f0-9-]{36}$/.test(id)) continue; const link = element('a','quiet-link',file.name || 'Hent vedhæftet dokument'); link.href = '/api/team/files/' + id + '/download'; link.setAttribute('download',''); article.append(link); }
      if (post.author === session.email || team.canManage) {
        const actions = element('div','post-actions'), edit = element('button','','Rediger'), remove = element('button','','Slet');
        edit.onclick = () => editPost(post); remove.onclick = async () => { if (!confirm('Slet opslaget “' + post.title + '”?')) return; remove.disabled = true; try { await api('team/posts/' + post.id + '/delete',{version:post.version}); await loadPosts(); } catch(e) { notice(e.message); remove.disabled = false; } }; actions.append(edit,remove); article.append(actions);
      }
      $('posts').append(article);
    }
  }
  function editPost(post) {
    const editor = ++editorEpoch, epoch = sessionEpoch;
    $('post-form').reset(); $('post-form').querySelector('button:not([type=button])').disabled=false; error('post-error'); $('post-id').value = post?.id || ''; $('post-version').value = post?.version || '';
    $('post-title').value = post?.title || ''; $('post-body').value = post?.body || ''; $('post-pinned').checked = post?.pinned || false;
    const choices = new Map((post?.attachments || []).map(f => [typeof f === 'string' ? f : f.id,{id:typeof f === 'string' ? f : f.id,name:f.name || 'Vedhæftet dokument'}]));
    const selected = new Set(choices.keys());
    const renderChoices = () => { $('post-files').replaceChildren(); for (const file of choices.values()) { const label = element('label','check-label'), input = element('input'); input.type='checkbox'; input.value=file.id; input.checked=selected.has(file.id); input.onchange=()=>{if(input.checked)selected.add(file.id);else selected.delete(file.id);}; label.append(input,document.createTextNode(file.name)); $('post-files').append(label); } };
    renderChoices();
    api('team/files').then(result => { if (epoch !== sessionEpoch || editor !== editorEpoch || !$('post-dialog').open) return; for (const file of result.files) choices.set(file.id,file); renderChoices(); }).catch(e=>{ if(epoch === sessionEpoch && editor === editorEpoch)error('post-error',e.message); });
    $('post-dialog-title').textContent = post ? 'Rediger opslag' : 'Skriv et opslag'; $('post-dialog').showModal(); $('post-title').focus();
  }
  $('new-post').onclick = () => editPost();
  $('post-form').onsubmit = async event => { event.preventDefault(); const button = event.submitter || event.target.querySelector('button:not([type=button])'); button.disabled = true; error('post-error'); const id = $('post-id').value, editor = editorEpoch, epoch = sessionEpoch;
    const data = {title:$('post-title').value.trim(),body:$('post-body').value,pinned:$('post-pinned').checked,attachments:[...$('post-files').querySelectorAll('input:checked')].map(input=>input.value)};
    if (data.attachments.length > 10) { error('post-error','Vælg højst 10 dokumenter.'); button.disabled=false; return; }
    if (id) data.version = Number($('post-version').value);
    try { await api('team/posts' + (id ? '/' + id + '/update' : ''),data); if (editor !== editorEpoch || epoch !== sessionEpoch) return; $('post-dialog').close(); await loadPosts(); notice('Opslaget er gemt.'); } catch(e) { if(editor === editorEpoch && epoch === sessionEpoch)error('post-error',e.message); } finally { if(editor === editorEpoch || !$('post-dialog').open)button.disabled = false; }
  };
  $('older-posts').onclick = () => loadPosts(true).catch(e => notice(e.message));
  async function loadFiles(older = false) {
    const requestId = ++filesRequest;
    const query = new URLSearchParams({q:$('file-search').value.trim()}); if (older && fileCursor) query.set('before',fileCursor);
    const result = await api('team/files?' + query); if (!session || requestId !== filesRequest) return;
    files = older ? [...files,...result.files] : result.files; fileCursor = result.nextBefore; $('files').replaceChildren(); $('older-files').hidden = !fileCursor; $('files-empty').hidden = files.length > 0;
    for (const file of files) {
      const row = element('article','file-row'); row.append(element('span','file-symbol',file.name.split('.').pop().toUpperCase().slice(0,5)));
      const info = element('div','file-info'), link = element('a','',file.name); link.href = '/api/team/files/' + encodeURIComponent(file.id) + '/download'; link.setAttribute('download','');
      info.append(link,element('p','',new Intl.NumberFormat('da-DK',{maximumFractionDigits:1}).format(file.size/1024) + ' KB · ' + memberName(file.author) + ' · ' + date(file.createdAt))); row.append(info);
      if (file.author === session.email || team.canManage) { const button = element('button','','Slet'); button.onclick = async () => { if (!confirm('Slet det fælles dokument “' + file.name + '”?')) return; button.disabled = true; try { await api('team/files/' + file.id + '/delete',{}); await loadFiles(); } catch(e) { notice(e.message); button.disabled = false; } }; row.append(button); }
      $('files').append(row);
    }
  }
  $('file-upload').onchange = async () => {
    const input = $('file-upload'), file = input.files[0], epoch = sessionEpoch; if (!file || !session) return;
    if (!file.size || file.size > 5*1024*1024) { notice('Vælg en fil mellem 1 byte og 5 MB.'); input.value = ''; return; }
    input.disabled = true; notice('Uploader ' + file.name + ' …');
    try { const bytes = new Uint8Array(await file.arrayBuffer()); if (epoch !== sessionEpoch || !session) return; let text = ''; for (let i=0;i<bytes.length;i+=32768) text += String.fromCharCode(...bytes.subarray(i,i+32768)); const types = {pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',txt:'text/plain',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}; await api('team/files',{name:file.name,contentType:types[file.name.split('.').pop().toLowerCase()] || file.type,data:btoa(text)}); await loadFiles(); notice('Dokumentet er gemt i virksomheden.'); } catch(e) { notice(e.message); } finally { input.disabled = false; input.value = ''; }
  };
  $('older-files').onclick = () => loadFiles(true).catch(e => notice(e.message));
  for (const [id,fn] of [['chat-search',loadMessages],['post-search',loadPosts],['file-search',loadFiles]]) { let debounce; $(id).oninput = () => { if (id === 'chat-search') { sequence++; displayed = []; messageCursor = null; } if (id === 'post-search') postsRequest++; if (id === 'file-search') filesRequest++; clearTimeout(debounce); debounce = setTimeout(() => fn().catch(e => notice(e.message)),300); }; }
  $('people-search').oninput = renderPeople;
  $('new-conversation').onclick = () => {
    $('conversation-members').replaceChildren(); error('conversation-error');
    for (const person of team.members.filter(p=>p.email!==session.email)) { const label=element('label','check-label'), input=element('input'); input.type='checkbox'; input.value=person.email; label.append(input,document.createTextNode(person.name + ' · ' + person.email)); $('conversation-members').append(label); }
    $('conversation-dialog').showModal();
  };
  $('conversation-form').onsubmit = async event => {
    event.preventDefault(); const members=[...$('conversation-members').querySelectorAll('input:checked')].map(i=>i.value);
    if (!members.length || members.length>11) { error('conversation-error','Vælg mellem 1 og 11 kollegaer.'); return; }
    const button=event.submitter || event.target.querySelector('button:not([type=button])'); button.disabled=true; error('conversation-error');
    try { const result=await api('team/channels',{type:'direct',members}); $('conversation-dialog').close(); await bootstrap(); await selectChannel(result.channel.id); } catch(e) { error('conversation-error',e.message); } finally { button.disabled=false; }
  };
  document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => $(button.dataset.close).close());
  $('post-dialog').addEventListener('close',()=>{editorEpoch++;});
  $('retry').onclick = connect; window.addEventListener('hashchange',changeTab);
  document.addEventListener('visibilitychange',() => { if (!document.hidden) refresh(); });
  window.addEventListener('beforeunload',event => { if ($('message-text').value.trim() || $('post-dialog').open && $('post-body').value.trim()) { event.preventDefault(); event.returnValue = ''; } });
  connect();
})();
