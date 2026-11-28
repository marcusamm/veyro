# Runs on a disposable GitHub Windows runner after the cold-install smoke test.
$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or !$env:RUNNER_TEMP) {
  throw 'Run this test in the Windows CI runner.'
}
$installRoot = Join-Path $env:RUNNER_TEMP 'VeyroMailSmoke'
$exe = Join-Path $installRoot 'Veyro Mail.exe'
$testDist = Join-Path $env:RUNNER_TEMP 'veyro-update-prior'
$oldVersion = '0.0.1-beta.1'
$newVersion = (Get-Content package.json -Raw | ConvertFrom-Json).version
$installer = (Get-Item "dist/Veyro-Mail-$newVersion-win-x64.exe").FullName
$profile = @('Veyro Mail','veyro-mail-desktop') | ForEach-Object { Join-Path $env:APPDATA $_ } |
  Where-Object { Test-Path (Join-Path $_ 'accounts.json') } | Select-Object -First 1
if (!$profile -or !(Test-Path $exe)) { throw 'Expected the disposable cold-install fixture first.' }
$accounts = Join-Path $profile 'accounts.json'
$id = [guid]::NewGuid().ToString()
$accountData = @{accounts=@(@{id=$id; label='Windows update fixture'; kind='external'});activeId=$id} | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($accounts, $accountData, [System.Text.UTF8Encoding]::new($false))

function Read-InstalledVersion {
  $metadata = Join-Path $installRoot 'resources/app.asar'
  if (!(Test-Path $metadata)) { return '' }
  $v = & node -e "console.log(JSON.parse(require('@electron/asar').extractFile(process.argv[1],'package.json')).version)" $metadata 2>$null
  if ($LASTEXITCODE -ne 0) { return '' }
  return $v
}
function Find-MainProcess {
  Get-CimInstance Win32_Process -Filter "Name='Veyro Mail.exe'" |
    Where-Object { $_.ExecutablePath -eq $exe -and $_.CommandLine -notmatch '--type=' } |
    Select-Object -First 1
}

# Build an actual, distinct previous NSIS version in a separate output folder.
& npx.cmd electron-builder --win nsis --x64 --publish never "-c.extraMetadata.version=$oldVersion" "-c.directories.output=$testDist"
if ($LASTEXITCODE -ne 0) { throw 'Building prior fixture installer failed.' }
$oldInstaller = (Get-Item "$testDist/Veyro-Mail-$oldVersion-win-x64.exe").FullName
$prior = Start-Process -FilePath $oldInstaller -ArgumentList @('/S','--updated',"/D=$installRoot") -PassThru -Wait
if ($prior.ExitCode -ne 0 -or (Read-InstalledVersion) -ne $oldVersion) { throw 'Prior installer did not set up the expected fixture.' }
$old = Start-Process -FilePath $exe -PassThru
try {
  Start-Sleep -Seconds 4
  if ($old.HasExited) { throw 'The prior app must be running at the start of the handoff.' }
  $priorId=$old.Id
  # The hosted runner has no operator for a native Windows launch prompt. Record
  # visible windows and installer processes to distinguish OS consent from a hung upgrade.
  $watch = Start-Job -ScriptBlock {
    for ($sample=1; $sample -le 5; $sample++) {
      Start-Sleep -Seconds 15
      "Windows handoff sample $sample"
      Get-Process | Where-Object { $_.MainWindowTitle -or $_.ProcessName -match '^(?:Veyro|powershell$|smartscreen$|consent$|OpenWith$)' } |
        Select-Object Id,ProcessName,MainWindowTitle | Format-Table -AutoSize | Out-String -Width 200
    }
  }
  # Run the exact Windows updater handoff, including origin marking, publisher checks and NSIS launch flags.
  try {
    & node -e "require('./update-install.cjs').installPackage({platform:'win32',filename:process.argv[1],execPath:process.argv[2],beforeHandoff:async()=>{process.kill(Number(process.argv[3]),0);console.log('Publisher check passed; handing off')}}).catch(e=>{console.error(e.message,e.code,e.killed,e.signal);process.exitCode=1})" $installer $exe $priorId
    if ($LASTEXITCODE -ne 0) { throw 'Windows updater rejected the test installer.' }
  } finally {
    Stop-Job $watch
    Receive-Job $watch
    Remove-Job $watch
  }
  if (!$old.HasExited) { $null=$old.CloseMainWindow() }
  if (!$old.WaitForExit(30000)) { throw 'The previous app remained open after the upgrade request.' }
  $deadline=[datetime]::UtcNow.AddSeconds(100)
  do {
    Start-Sleep -Seconds 2
    $reopened=Find-MainProcess
    if ($reopened -and $reopened.ProcessId -ne $priorId -and (Read-InstalledVersion) -eq $newVersion) { break }
  } while ([datetime]::UtcNow -lt $deadline)
  if (!$reopened -or $reopened.ProcessId -eq $priorId -or (Read-InstalledVersion) -ne $newVersion) {
    throw 'The released app version did not reopen from the same custom installation directory.'
  }
  $preserved=Get-Content $accounts -Raw | ConvertFrom-Json
  if ($preserved.activeId -ne $id -or $preserved.accounts[0].label -ne 'Windows update fixture' -or $preserved.accounts[0].kind -ne 'external') {
    throw 'The selected synthetic account or its saved settings were lost in the upgrade.'
  }
  Write-Host "Verified in-place NSIS upgrade from $oldVersion to $newVersion, restart and account settings."
} finally {
  $proc=Find-MainProcess
  if ($proc) { & taskkill /PID $proc.ProcessId /T /F | Out-Null }
}
