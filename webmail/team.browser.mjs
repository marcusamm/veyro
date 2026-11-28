import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test} from 'node:test';
import {chromium,webkit} from 'playwright';
import {createTeamFixture} from './fixtures/team.mjs';

for (const [engine,width] of [[chromium,1280],[chromium,390],[webkit,390]]) {
  test(`team workflows, safe rendering and session expiry in ${engine.name()} at ${width}px`,async t => {
    const fixture = createTeamFixture(), exceptions = [];
    fixture.addHistory(60);
    const server = createServer(async (req,res) => {
      const url = new URL(req.url,'http://127.0.0.1');
      let result;
      if (url.pathname.startsWith('/api/')) {
        const chunks = []; for await(const chunk of req) chunks.push(chunk);
        result = await fixture.handle(url,req.method,chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}, req.headers);
      } else {
        const file = url.pathname === '/team' ? 'team.html' : url.pathname.slice(1);
        try { result = new Response(await readFile(new URL('./assets/'+file,import.meta.url)),{headers:{'Content-Type':file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html'}}); }
        catch {result=new Response('',{status:404});}
      }
      res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()));
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');
    t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections()}));
    const browser = await engine.launch(engine === chromium ? {channel:process.env.WEBMAIL_BROWSER} : {});t.after(()=>browser.close());
    const page = await browser.newPage({viewport:{width,height:900}});page.on('pageerror',e=>exceptions.push(e.message));
    await page.goto('http://127.0.0.1:'+server.address().port+'/team');
    await page.locator('#team:not([hidden])').waitFor();
    await page.getByText('Godmorgen! Ugens plan ligger på intranettet. Vi mødes kl. 10.').waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.getByRole('button',{name:'Vis tidligere beskeder'}).click();
    await page.getByText('Historisk besked 0',{exact:true}).waitFor();
    await page.waitForTimeout(5200);
    assert.equal(await page.getByText('Historisk besked 0',{exact:true}).count(),1,'loaded history is retained');
    page.once('dialog',d=>d.accept());
    await page.locator('.chat-message').filter({has:page.getByText('Historisk besked 0',{exact:true})}).getByRole('button',{name:'Slet besked fra Jonas Møller'}).click();
    await page.getByText('Beskeden er slettet.',{exact:true}).waitFor();
    assert.equal(await page.getByText('Historisk besked 0',{exact:true}).count(),0,'deleting older history immediately removes its text');
    fixture.messages[1].deleted=true;fixture.messages[1].text='';
    // Simulate a lost acknowledgement AFTER persistence; retry must use the same client ID.
    fixture.setFailOnce();
    const text = '<img src=x onerror=alert(1)> https://example.test/team';
    await page.getByLabel('Besked',{exact:true}).fill(text);await page.getByRole('button',{name:'Send besked ↑'}).click();
    await page.locator('#message-error:not([hidden])').waitFor();
    assert.equal(await page.getByLabel('Besked',{exact:true}).inputValue(),text);
    await page.getByRole('link',{name:'Kollegaer',exact:true}).click();await page.getByRole('button',{name:'Skriv besked',exact:true}).click();
    await page.getByRole('heading',{name:'Jonas Møller',exact:true}).waitFor();
    await page.getByLabel('Besked',{exact:true}).fill('En anden samtale');await page.getByRole('button',{name:'Send besked ↑'}).click();
    await page.waitForFunction(()=>document.querySelector('#message-text').value==='');
    await page.getByRole('button',{name:/^# Generelt/}).click();
    assert.equal(await page.getByLabel('Besked',{exact:true}).inputValue(),text);
    await page.getByRole('button',{name:'Send besked ↑'}).click();
    await page.waitForFunction(()=>document.querySelector('#message-text').value==='');
    assert.equal(fixture.messages.filter(m=>m.text===text).length,1);
    assert.equal(await page.getByText('Historisk besked 1',{exact:true}).count(),0,'refresh also revalidates remotely deleted older history');
    const attempts=fixture.requests.filter(r=>r.path==='/api/team/messages'&&r.method==='POST'&&r.body.text===text);
    assert.equal(attempts[0].body.clientId,attempts[1].body.clientId);
    assert.equal(attempts[0].headers['x-csrf-token'],'fixture-csrf');
    assert.equal(await page.locator('#messages img').count(),0,'untrusted chat text never becomes HTML');
    const link=page.locator('#messages a').last();assert.equal(await link.getAttribute('rel'),'noopener noreferrer');
    await page.getByRole('button',{name:'Opret kanal',exact:true}).click();
    await page.getByLabel('Kanalens navn').fill('Projekt Alpha');await page.locator('#channel-form').getByRole('button',{name:'Opret kanal',exact:true}).click();
    await page.getByRole('heading',{name:'Projekt Alpha',exact:true}).waitFor();
    await page.getByRole('link',{name:'Kollegaer',exact:true}).click();await page.getByRole('button',{name:'Skriv besked',exact:true}).click();
    await page.getByRole('heading',{name:'Jonas Møller',exact:true}).waitFor();assert.ok(await page.getByText('Privat samtale mellem deltagerne').isVisible());
    await page.getByRole('link',{name:'Intranet',exact:true}).click();await page.getByRole('button',{name:'Skriv et opslag +',exact:true}).click();
    await page.getByLabel('Overskrift',{exact:true}).fill('Fælles frokost');await page.getByLabel('Indhold',{exact:true}).fill('Vi mødes klokken 12.');await page.getByLabel('Fastgør øverst på intranettet').check(); await page.getByLabel('Velkommen.txt',{exact:true}).check();
    await page.getByRole('button',{name:'Gem opslag',exact:true}).click();await page.getByRole('heading',{name:'Fælles frokost',exact:true}).waitFor();
    assert.equal(fixture.posts[0].pinned,true); assert.equal(fixture.posts[0].attachments.length,1);
    const post=page.locator('.post').filter({has:page.getByRole('heading',{name:'Fælles frokost',exact:true})});
    await post.getByRole('button',{name:'Rediger',exact:true}).click();await page.getByLabel('Indhold',{exact:true}).fill('Vi mødes klokken 12.30.');await page.getByRole('button',{name:'Gem opslag',exact:true}).click();
    await page.getByText('Vi mødes klokken 12.30.',{exact:true}).waitFor();assert.equal(fixture.posts[0].version,2); assert.equal(fixture.posts[0].attachments.length,1,'editing preserves selected documents');
    // A late document-list response from a closed editor must not replace the next editor's choices.
    const pending=[];await page.route('**/api/team/files',route=>pending.push(route));
    await page.getByRole('button',{name:'Skriv et opslag +',exact:true}).click();
    await page.waitForTimeout(100);assert.equal(pending.length,1);
    await page.locator('#post-dialog').getByRole('button',{name:'Annuller',exact:true}).click();
    await page.getByRole('button',{name:'Skriv et opslag +',exact:true}).click();
    await page.waitForTimeout(100);assert.equal(pending.length,2);
    const choice={id:'22222222-2222-4222-8222-222222222222',name:'Aktuelt.txt'};
    await pending[1].fulfill({json:{files:[choice],nextBefore:null}});await page.getByLabel('Aktuelt.txt',{exact:true}).check();
    await pending[0].fulfill({json:{files:[{...choice,name:'Forældet.txt'}],nextBefore:null}});await page.waitForTimeout(100);
    assert.equal(await page.getByLabel('Aktuelt.txt',{exact:true}).isChecked(),true);assert.equal(await page.getByLabel('Forældet.txt',{exact:true}).count(),0);
    await page.locator('#post-dialog').getByRole('button',{name:'Annuller',exact:true}).click();await page.unroute('**/api/team/files');
    if(process.env.TEAM_SCREENSHOTS){await mkdir('/tmp/veyro-team-preview',{recursive:true});await page.screenshot({path:`/tmp/veyro-team-preview/intranet-${engine.name()}-${width}.png`});}
    await page.getByRole('link',{name:'Dokumenter',exact:true}).click();
    await page.getByLabel('Upload dokument',{exact:true}).setInputFiles({name:'Proeve.txt',mimeType:'text/plain',buffer:Buffer.from('Fiktivt dokument')});
    await page.getByRole('link',{name:'Proeve.txt',exact:true}).waitFor();
    assert.equal(await page.getByRole('link',{name:'Proeve.txt',exact:true}).getAttribute('download'),'');
    await page.getByLabel('Søg i dokumenter',{exact:true}).fill('Proeve');await page.waitForTimeout(500);
    assert.equal(await page.locator('.file-row').count(),1);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    const uploadsBefore=fixture.requests.filter(r=>r.path==='/api/team/files'&&r.method==='POST').length;
    await page.evaluate(()=>{File.prototype.arrayBuffer=function(){return new Promise(resolve=>{window.resumeUpload=()=>resolve(new TextEncoder().encode('Do not cross a session').buffer)})}});
    await page.getByLabel('Upload dokument',{exact:true}).setInputFiles({name:'Slow.txt',mimeType:'text/plain',buffer:Buffer.from('Slow')});
    fixture.signOut();await page.getByRole('link',{name:'Intranet',exact:true}).click();await page.getByRole('link',{name:'Log ind i Veyro Mail',exact:true}).waitFor();
    await page.evaluate(()=>window.resumeUpload());await page.waitForTimeout(100);
    assert.equal(fixture.requests.filter(r=>r.path==='/api/team/files'&&r.method==='POST').length,uploadsBefore,'a slow file read cannot cross the expired session');
    assert.equal(await page.locator('#post-files').textContent(),'');assert.equal(await page.locator('#conversation-members').textContent(),'');assert.equal(await page.locator('#identity').textContent(),'');assert.equal(await page.locator('#messages').textContent(),'');assert.equal(await page.locator('#posts').textContent(),'');assert.equal(await page.locator('#team').isVisible(),false);
    assert.deepEqual(exceptions,[]);
  });
}
