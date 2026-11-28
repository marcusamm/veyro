// Synthetic company only. Never imported by production code.
export function createTeamFixture() {
  const email = 'anna@example.test', colleague = 'jonas@example.test';
  const id = n => '11111111-1111-4111-8111-' + String(n).padStart(12,'0');
  let serial = 1000;
  const stamp = '2026-11-28T09:00:00Z';
  const channels = [{id:id(1),name:'Generelt',type:'channel',members:[email,colleague],lastId:id(100),unread:1}];
  let messages = [{id:id(100),channel:id(1),author:colleague,text:'Godmorgen! Ugens plan ligger på intranettet. Vi mødes kl. 10.',createdAt:stamp,deleted:false}];
  let posts = [{id:id(2),title:'Velkommen til vores fælles arbejdsplads',body:'Her deler vi viden og holder hinanden opdateret. Brug chatten til de korte spørgsmål og intranettet til det, vi skal kunne finde igen.',pinned:true,author:email,createdAt:stamp,updatedAt:stamp,version:1,attachments:[]},
    {id:id(3),title:'Ugens fælles morgenmad',body:'Fredag kl. 9 mødes vi i køkkenet. Skriv til Jonas, hvis der er noget, vi skal tage højde for.',pinned:false,author:colleague,createdAt:stamp,updatedAt:stamp,version:1,attachments:[]}];
  let files = [{id:id(4),name:'Velkommen.txt',contentType:'text/plain',size:20,author:email,createdAt:stamp,data:'Velkommen til teamet.'}];
  const requests = [], messageIds = new Map();
  let failOnce = false, signedIn = true;
  const json = (data, status=200) => new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
  async function handle(url,method='GET',body={},headers={}) {
    const path = url.pathname;
    requests.push({path,method,body,headers});
    if (!signedIn) return json({error:'Log ind igen.'},401);
    if (path === '/api/session') return json({email,csrfToken:'fixture-csrf'});
    if (path === '/api/team/bootstrap') return json({email,domain:'example.test',companyName:'Eksempel Studio',canManage:true,members:[{email,name:'Anna Jensen'},{email:colleague,name:'Jonas Møller'}],channels});
    if (path === '/api/team/channels' && method === 'POST') {
      const channel = {id:id(serial++),name:body.name || '',type:body.type,members:body.type === 'direct' ? [email,...body.members] : [email,colleague],unread:0}; channels.push(channel); return json({channel},201);
    }
    if (path === '/api/team/messages' && method === 'GET') {
      let matches = messages.filter(m => m.channel === url.searchParams.get('channel') && m.text.toLowerCase().includes((url.searchParams.get('q') || '').toLowerCase()));
      if (url.searchParams.has('before')) matches = matches.slice(0,matches.findIndex(m => m.id === url.searchParams.get('before')));
      return json({messages:matches.slice(-50),nextBefore:matches.length>50 ? matches.at(-50).id : null});
    }
    if (path === '/api/team/messages' && method === 'POST') {
      if (messageIds.has(body.clientId)) return json({message:messageIds.get(body.clientId)});
      const message = {id:id(serial++),channel:body.channel,author:email,text:body.text,createdAt:stamp,deleted:false}; messageIds.set(body.clientId,message); messages.push(message);
      if (failOnce) { failOnce = false; return json({error:'Forbindelsen blev afbrudt. Prøv igen.'},502); }
      return json({message},201);
    }
    if (path.startsWith('/api/team/messages/') && path.endsWith('/delete')) { const m = messages.find(m => path.includes(m.id)); if(m) m.deleted = true; return json({ok:true}); }
    if (path === '/api/team/read') { channels.forEach(c => {if(c.id===body.channel)c.unread=0;}); return json({ok:true}); }
    if (path === '/api/team/posts' && method === 'GET') return json({posts:posts.filter(p => (p.title+' '+p.body).toLowerCase().includes((url.searchParams.get('q')||'').toLowerCase())),nextBefore:null});
    if (path === '/api/team/posts' && method === 'POST') { const post = {...body,id:id(serial++),author:email,createdAt:stamp,updatedAt:stamp,version:1}; posts.unshift(post);return json({post},201); }
    if (path.startsWith('/api/team/posts/') && method === 'POST') { const index = posts.findIndex(p => path.includes(p.id)); if(index<0) return json({error:'Opslaget findes ikke.'},404); if(body.version!==posts[index].version)return json({error:'En kollega har ændret opslaget. Åbn det igen.'},409); if(path.endsWith('/delete'))posts.splice(index,1);else posts[index]={...posts[index],...body,version:posts[index].version+1};return json({ok:true}); }
    if (path === '/api/team/files' && method === 'GET') return json({files:files.filter(f=>f.name.toLowerCase().includes((url.searchParams.get('q')||'').toLowerCase())),nextBefore:null});
    if (path === '/api/team/files' && method === 'POST') { const file = {...body,id:id(serial++),size:Buffer.from(body.data,'base64').length,author:email,createdAt:stamp}; files.unshift(file); return json({file},201); }
    if (path.startsWith('/api/team/files/')) { const file=files.find(f=>path.includes(f.id)); if(!file)return json({error:'Filen findes ikke.'},404); if(path.endsWith('/delete')){files=files.filter(f=>f.id!==file.id);return json({ok:true});} return new Response(file.data,{headers:{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="'+file.name+'"'}}); }
    return json({error:'Kun lokal testvisning.'},404);
  }
  return {handle,requests,channels,get messages(){return messages},get posts(){return posts},setFailOnce(){failOnce=true},signOut(){signedIn=false},addHistory(count){messages=Array.from({length:count},(_,n)=>({id:id(200+n),channel:id(1),author:colleague,text:'Historisk besked '+n,createdAt:stamp,deleted:false})).concat(messages)}};
}
