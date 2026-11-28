'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile, spawn} = require('node:child_process');
const {promisify} = require('node:util');
const run = promisify(execFile);

// macOS exposes a same-volume atomic exchange of two existing bundles. Keep
// the previous bundle until LaunchServices has accepted the replacement.
const EXCHANGE = `ObjC.import('Foundation');
ObjC.bindFunction('renamex_np', ['int', ['char *','char *','unsigned int']]);
function run(paths) {
  if ($.renamex_np(paths[0], paths[1], 2) !== 0) throw Error('Bundle exchange failed');
}`;
const REOPEN = `parent=$1; installed=$2; old=$3; stage=$4; exchange=$5; working=$6; expected=$7; identity=$8; token=$9
same_bundle() { [ "$(/usr/bin/stat -f '%d:%i' "$installed")" = "$identity" ]; }
rollback() {
  if same_bundle && /usr/bin/osascript -l JavaScript -e "$exchange" "$installed" "$old"; then
    /bin/rm -rf "$stage" "$working"
    return 0
  fi
  return 1
}
count=0
while kill -0 "$parent" 2>/dev/null; do
  count=$((count + 1))
  if [ "$count" -ge 120 ]; then rollback; exit 1; fi
  /bin/sleep 1
done
if same_bundle && /usr/bin/open -n "$installed" --args "--veyro-update-confirm=$token"; then
  count=0
  while [ "$count" -lt 120 ]; do
    if [ -f "$working/ready" ] && [ "$(/bin/cat "$working/ready")" = "$expected" ]; then
      /bin/rm -rf "$stage" "$working"
      exit 0
    fi
    count=$((count + 1))
    /bin/sleep 1
  done
fi
if rollback; then /usr/bin/open "$installed"; fi`;
function exchangeBundles(a,b) {
  return run('/usr/bin/osascript',['-l','JavaScript','-e',EXCHANGE,a,b],{timeout:20000});
}
async function reopenWhenClosed(bundle,previous,stage,working,version,pid=process.pid) {
  const {dev,ino} = await fs.stat(bundle,{bigint:true});
  const helper = spawn('/bin/sh',['-c',REOPEN,'veyro-update',String(pid),bundle,previous,stage,EXCHANGE,working,
    version,String(dev)+':'+String(ino),path.basename(working)],{detached:true,stdio:'ignore',cwd:'/'});
  return new Promise((resolve,reject) => {
    helper.once('error',reject);
    helper.once('spawn',() => { helper.unref(); resolve(); });
  });
}
async function confirmRestart(userData,version,args) {
  const flag = args.find(arg => /^--veyro-update-confirm=version-[A-Za-z0-9]{6}$/.test(arg));
  if (!flag) return;
  const base = await fs.realpath(path.join(userData,'downloaded-updates'));
  const folder = path.join(base,flag.slice(flag.indexOf('=') + 1));
  if (await fs.realpath(folder) !== folder) return;
  const pending = JSON.parse(await fs.readFile(path.join(folder,'pending.json'),'utf8'));
  if (pending.version !== version || pending.bundle !== await fs.realpath(path.dirname(path.dirname(path.dirname(process.execPath))))) return;
  await fs.writeFile(path.join(folder,'ready'),version,{flag:'wx',mode:0o600});
}
async function verifyBundle(candidate,current,version) {
  for (const [key,value] of [['CFBundleIdentifier','dk.veyro.mail'],['CFBundleShortVersionString',version]]) {
    const {stdout} = await run('/usr/bin/plutil',['-extract',key,'raw','-o','-',path.join(candidate,'Contents','Info.plist')]);
    if (stdout.trim() !== value) throw Error('Unexpected bundle identity');
  }
  await run('/usr/bin/codesign',['--verify','--deep','--strict',candidate],{timeout:90000});
  const signingTeam = async bundle => {
    const {stderr} = await run('/usr/bin/codesign',['-dv','--verbose=4',bundle]);
    const team = stderr.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
    if (!team) throw Error('Cannot identify signing team');
    return team;
  };
  const oldTeam = await signingTeam(current), newTeam = await signingTeam(candidate);
  if (oldTeam !== 'not set' && oldTeam !== newTeam) throw Error('Signing team changed');
  const quarantined = async bundle => (await run('/usr/bin/xattr',[bundle])).stdout.split('\n').includes('com.apple.quarantine');
  const previouslyQuarantined = await quarantined(current), alreadyQuarantined = await quarantined(candidate);
  if (previouslyQuarantined && !alreadyQuarantined) {
    // Record a new download, never copy a prior version's user-approval bits.
    const timestamp = Math.floor(Date.now()/1000).toString(16);
    await run('/usr/bin/xattr',['-w','com.apple.quarantine','0081;' + timestamp + ';Veyro Mail;',candidate]);
  }
  if (newTeam !== 'not set' || previouslyQuarantined || alreadyQuarantined)
    await run('/usr/sbin/spctl',['--assess','--type','execute',candidate],{timeout:90000});
}
async function installMac({filename,working,execPath,release,beforeHandoff,UpdateError},reopen = reopenWhenClosed) {
  const executable = await fs.realpath(execPath);
  const bundle = path.dirname(path.dirname(path.dirname(executable)));
  if (path.extname(bundle) !== '.app' || path.dirname(executable) !== path.join(bundle,'Contents','MacOS') ||
      bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) {
    throw new UpdateError('Flyt Veyro Mail til Programmer, og åbn appen derfra før opdatering.');
  }
  const parent = path.dirname(bundle);
  let stage;
  try { stage = await fs.mkdtemp(path.join(parent,'.veyro-mail-update-')); }
  catch { throw new UpdateError('Din macOS-bruger mangler skriveadgang til mappen med Veyro Mail.'); }
  const candidate = path.join(stage,'Veyro Mail.app');
  const mount = path.join(working,'mounted');
  let mounted = false, exchanged = false;
  try {
    await fs.mkdir(mount,{mode:0o700});
    await run('/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-noautoopen','-mountpoint',mount,filename],{timeout:120000});
    mounted = true;
    const source = path.join(mount,'Veyro Mail.app');
    if (!(await fs.lstat(source)).isDirectory() || await fs.realpath(source) !== await fs.realpath(mount) + '/Veyro Mail.app') throw Error('Unexpected package');
    await run('/usr/bin/ditto',[source,candidate],{timeout:240000});
    await run('/usr/bin/hdiutil',['detach',mount],{timeout:60000});
    mounted = false;
    await verifyBundle(candidate,bundle,release.version);
    await fs.writeFile(path.join(working,'pending.json'),JSON.stringify({bundle,version:release.version}),{flag:'wx',mode:0o600});
    await beforeHandoff();
    await exchangeBundles(bundle,candidate);
    exchanged = true;
    try {
      await reopen(bundle,candidate,stage,working,release.version);
    } catch (error) {
      await exchangeBundles(bundle,candidate);
      exchanged = false;
      throw error;
    }
  } finally {
    if (mounted) await run('/usr/bin/hdiutil',['detach','-force',mount],{timeout:30000}).catch(() => {});
    if (!exchanged) await fs.rm(stage,{recursive:true,force:true}).catch(() => {});
  }
}
const VERIFY_WINDOWS = `$ErrorActionPreference = 'Stop'
$current = Get-AuthenticodeSignature -LiteralPath $env:VEYRO_RUNNING_EXE
$next = Get-AuthenticodeSignature -LiteralPath $env:VEYRO_VERIFIED_UPDATE_EXE
if ($current.Status -eq 'Valid') {
  if ($next.Status -ne 'Valid' -or $current.SignerCertificate.Subject -ne $next.SignerCertificate.Subject) { throw 'Unexpected publisher' }
} elseif ($current.Status -ne 'NotSigned' -or $next.Status -notin @('NotSigned','Valid')) {
  throw 'Signature failed'
}`;
async function installWindows({filename,execPath,beforeHandoff}) {
  // ShellExecute through the system PowerShell so Windows can apply its
  // normal origin/publisher checks. No downloaded code is used as a helper.
  await fs.writeFile(filename + ':Zone.Identifier','[ZoneTransfer]\r\nZoneId=3\r\n');
  const shell = path.win32.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const options = {cwd:path.dirname(execPath),windowsHide:true,timeout:180000,
    env:{...process.env,VEYRO_VERIFIED_UPDATE_EXE:filename,VEYRO_RUNNING_EXE:execPath}};
  const powershell = command => run(shell,['-NoLogo','-NoProfile','-NonInteractive','-Command',command],options);
  await powershell(VERIFY_WINDOWS);
  await beforeHandoff();
  await powershell("$ErrorActionPreference='Stop'; Start-Process -FilePath $env:VEYRO_VERIFIED_UPDATE_EXE -ArgumentList @('/S','--updated','--force-run')");
}
async function installPackage(context) {
  if (context.platform === 'darwin') return installMac(context);
  if (context.platform === 'win32') return installWindows(context);
  throw Error('Platform not supported');
}
module.exports = {installPackage, installMac, confirmRestart, reopenWhenClosed};
