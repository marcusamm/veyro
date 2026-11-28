'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {execFile} = require('node:child_process');
const run = require('node:util').promisify(execFile);
const {newerVersion,verifyManifest,createUpdater,UpdateError} = require('../app-updates.cjs');
const {installMac} = require('../update-install.cjs');
const {privateKey,publicKey} = crypto.generateKeyPairSync('ed25519');
const pem = publicKey.export({type:'spki',format:'pem'});
const packageBytes = Buffer.from('synthetic package contents');
const files = {
  'darwin-arm64': {name:'Veyro-Mail-0.1.0-beta.7-mac-arm64.dmg',size:packageBytes.length,
    sha256:crypto.createHash('sha256').update(packageBytes).digest('hex')},
};
const manifest = {schema:1,version:'0.1.0-beta.7',files};
function sign(data) {
  const bytes = Buffer.from(JSON.stringify(data));
  return Buffer.from(JSON.stringify({payload:bytes.toString('base64'),signature:crypto.sign(null,bytes,privateKey).toString('base64')}));
}
test('only verified manifests for the precise selected platform yield an installer', () => {
  const signed = sign(manifest);
  assert.equal(verifyManifest(signed,pem,'darwin-arm64').sha256,files['darwin-arm64'].sha256);
  assert.throws(() => verifyManifest(signed,pem,'win32-x64'),UpdateError);
  const fake = JSON.parse(signed);
  fake.payload = Buffer.from(JSON.stringify({...manifest,version:'9.0.0'})).toString('base64');
  assert.throws(() => verifyManifest(Buffer.from(JSON.stringify(fake)),pem,'darwin-arm64'),UpdateError);
  for (const bad of [{name:'../installer.dmg'},{name:'https://other.invalid/update'},{size:0},{size:536870913},
                      {sha256:'f'.repeat(63)},{sha256:'0'.repeat(63)+'G'}]) {
    const modified = {...manifest,files:{'darwin-arm64':{...files['darwin-arm64'],...bad}}};
    assert.throws(() => verifyManifest(sign(modified),pem,'darwin-arm64'),UpdateError);
  }
});
test('stable versions supersede their betas, numbered betas and releases are compared numerically', () => {
  assert.ok(newerVersion('0.1.0-beta.10','0.1.0-beta.9'));
  assert.ok(newerVersion('0.1.0','0.1.0-beta.99'));
  assert.ok(!newerVersion('0.1.0-beta.10','0.1.0'));
  assert.ok(!newerVersion('3.0.0','3.0.0'));
  assert.ok(!newerVersion('1.0.0','2.0.0-beta.1'));
  assert.throws(() => newerVersion('../0.1.0','1.0.0'),UpdateError);
});
async function setup(t,{bytes=packageBytes,version='0.1.0-beta.6',ready=async()=>{}}={}) {
  const userData=await fs.mkdtemp(path.join(os.tmpdir(),'veyro-update-test-'));
  t.after(()=>fs.rm(userData,{recursive:true,force:true}));
  const states=[],requests=[];
  let handoffs=0,quits=0,seen;
  const u=createUpdater({platform:'darwin',arch:'arm64',currentVersion:version,enabled:true,userData,
    readKey:async()=>pem,execPath:'/fixture/Veyro Mail.app/Contents/MacOS/Veyro Mail',publish:()=>states.push(u.snapshot()),
    readyToRestart:ready,quit:()=>{quits++;},fetcher:async (url, options)=>{
      assert.ok(url.startsWith('https://post.veyro.dk/webmail-downloads/'));
      assert.equal(options.redirect,'error'); assert.equal(options.credentials,'omit');
      requests.push(url);
      return new Response(url.endsWith('update.json') ? sign(manifest) : bytes);
    },install:async({filename,beforeHandoff})=>{await beforeHandoff();seen=await fs.readFile(filename);handoffs++;}});
  return {u,states,requests,stats:()=>({handoffs,quits,seen})};
}
test('concurrent checks and repeated install clicks have one handoff, after verification', async t=>{
  const {u,requests,states,stats}=await setup(t);
  await Promise.all([u.check(),u.check()]);
  assert.equal(u.snapshot().status,'available');assert.equal(requests.length,1);
  assert.equal(stats().handoffs,0);
  await Promise.all([u.apply(),u.apply()]);
  assert.deepEqual(stats(),{handoffs:1,quits:1,seen:packageBytes});
  assert.equal(requests.length,3);
  assert.ok(states.some(v=>v.status==='downloading'));
  assert.equal(states.at(-1).status,'installing');
});
test('modified and truncated artifacts cannot start an installer',async t=>{
  for(const bytes of [Buffer.alloc(packageBytes.length,'x'),Buffer.from('partial')]){
    const {u,stats}=await setup(t,{bytes});
    await u.check();await u.apply();
    assert.equal(u.snapshot().status,'error'); assert.equal(stats().handoffs,0); assert.equal(stats().quits,0);
  }
});
test('rechecks draft and account activity before handoff and does not apply a downgrade',async t=>{
  let checks=0;
  const guard=await setup(t,{ready:async()=>{if(++checks===2)throw new UpdateError('Gem først kladden.');}});
  await guard.u.check();await guard.u.apply();
  assert.equal(guard.u.snapshot().error,'Gem først kladden.');assert.equal(guard.stats().quits,0);
  const current=await setup(t,{version:'0.1.0'});
  await current.u.check();await current.u.apply();
  assert.equal(current.u.snapshot().status,'current');assert.equal(current.requests.length,1);
});
test('macOS stages and verifies a synthetic DMG and atomically swaps bundles; helper-start failure restores it',
  {skip:process.platform!=='darwin',timeout:120000},async t=>{
    const tmp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'veyro-update-mac-test-')));
    t.after(()=>fs.rm(tmp,{recursive:true,force:true}));
    async function bundle(parent,version) {
      const root=path.join(parent,'Veyro Mail.app'), contents=path.join(root,'Contents');
      await fs.mkdir(path.join(contents,'MacOS'),{recursive:true});
      await fs.copyFile('/usr/bin/true',path.join(contents,'MacOS','Mail'));
      const plist='<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>'+
        '<key>CFBundleIdentifier</key><string>dk.veyro.mail</string><key>CFBundleExecutable</key><string>Mail</string>'+
        '<key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>'+version+'</string></dict></plist>';
      await fs.writeFile(path.join(contents,'Info.plist'),plist);
      await run('/usr/bin/codesign',['--force','--sign','-',root]);
      return root;
    }
    const media=path.join(tmp,'media'), original=await bundle(path.join(tmp,'Applications'),'0.1.0-beta.6');
    await bundle(media,manifest.version);
    const filename=path.join(tmp,'candidate.dmg'),execPath=path.join(original,'Contents','MacOS','Mail');
    await run('/usr/bin/hdiutil',['create','-fs','HFS+','-format','UDZO','-srcfolder',media,filename],{timeout:60000});
    let called=0;
    async function invoke(working,reopen) {
      await fs.mkdir(working);
      return installMac({working,filename,execPath,release:{version:manifest.version},beforeHandoff:async()=>{called++;},UpdateError},reopen);
    }
    async function versionAt(root) {
      return (await run('/usr/bin/plutil',['-extract','CFBundleShortVersionString','raw','-o','-',path.join(root,'Contents','Info.plist')])).stdout.trim();
    }
    await assert.rejects(invoke(path.join(tmp,'failure'),async()=>{throw Error('helper unavailable');}),/helper unavailable/);
    assert.equal(await versionAt(original),'0.1.0-beta.6');
    await invoke(path.join(tmp,'success'),async(installed,backup)=>{
      assert.equal(await versionAt(installed),manifest.version);assert.equal(await versionAt(backup),'0.1.0-beta.6');
    });
    assert.equal(called,2);assert.equal(await versionAt(original),manifest.version);
  });
test('LaunchServices starts an isolated background fixture and the helper waits for readiness before deleting its backup',
  {skip:process.platform!=='darwin',timeout:30000},async t=>{
    const {reopenWhenClosed}=require('../update-install.cjs');
    const tmp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'veyro-reopen-test-')));
    t.after(()=>fs.rm(tmp,{recursive:true,force:true}));
    const bundle=path.join(tmp,'Veyro Updater Fixture.app'),contents=path.join(bundle,'Contents');
    const stage=await fs.mkdtemp(path.join(tmp,'.veyro-mail-update-'));
    const backup=path.join(stage,'Veyro Updater Fixture.app'),working=await fs.mkdtemp(path.join(tmp,'version-'));
    const version='0.1.0-beta.7';
    await fs.mkdir(path.join(contents,'MacOS'),{recursive:true});
    await fs.mkdir(backup);
    await fs.writeFile(path.join(contents,'Info.plist'),'<?xml version="1.0"?><plist version="1.0"><dict>'+
      '<key>CFBundleIdentifier</key><string>dk.veyro.updatertest.'+crypto.randomUUID()+'</string>'+
      '<key>CFBundleExecutable</key><string>Fixture</string><key>CFBundlePackageType</key><string>APPL</string>'+
      '<key>CFBundleVersion</key><string>1</string><key>LSBackgroundOnly</key><true/></dict></plist>');
    const source=path.join(tmp,'fixture.c'),proof=path.join(tmp,'acknowledged');
    await fs.writeFile(source,'#include <stdio.h>\n#include <string.h>\n#include <unistd.h>\n'+
      'int main(int argc,char **argv) {\n'+
      ' if (argc != 2 || strcmp(argv[1],'+JSON.stringify('--veyro-update-confirm='+path.basename(working))+')) return 1;\n'+
      ' sleep(1); if (access('+JSON.stringify(backup)+',F_OK)) return 2;\n'+
      ' FILE *f=fopen('+JSON.stringify(path.join(working,'ready'))+',"w"); if(!f) return 3; fputs('+JSON.stringify(version)+',f); fclose(f);\n'+
      ' f=fopen('+JSON.stringify(proof)+',"w"); if(!f) return 4; fclose(f); return 0; }\n');
    await run('/usr/bin/xcrun',['clang',source,'-o',path.join(contents,'MacOS','Fixture')],{timeout:20000});
    await run('/usr/bin/codesign',['--force','--sign','-',bundle]);
    await reopenWhenClosed(bundle,backup,stage,working,version,2147483646);
    for(let i=0;i<65;i++){
      if(!(await fs.stat(working).catch(()=>null)))break;
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    assert.ok(await fs.stat(proof));
    assert.equal(await fs.stat(working).catch(()=>null),null);
    assert.equal(await fs.stat(stage).catch(()=>null),null);
    assert.ok(await fs.stat(bundle));
  });
