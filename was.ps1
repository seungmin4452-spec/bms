# Standalone Tomcat for pigon_pc (replaces IntelliJ run config "pigon_pc")
# usage: was.ps1 build | start | stop | restart | status
# ASCII only: Windows PowerShell 5.1 reads BOM-less files as ANSI.
param([Parameter(Mandatory = $true)][ValidateSet('build', 'start', 'stop', 'restart', 'status')][string]$Action)

$ErrorActionPreference = 'Stop'
$Project      = 'C:\Users\SMSHIN\IdeaProjects\pigon_pc'
$JavaHome     = 'C:\Program Files\Java\jdk1.8.0_202'
$Mvn          = 'C:\Program Files\JetBrains\IntelliJ IDEA 2026.1.1\plugins\maven\lib\maven3\bin\mvn.cmd'
$CatalinaHome = Join-Path $env:USERPROFILE 'tomcat\apache-tomcat-8.0.52'
$Base         = Join-Path $PSScriptRoot 'tomcat-base'
$PidFile      = Join-Path $Base 'tomcat.pid'
$BuildLog     = Join-Path $Base 'logs\build.log'
$ConsoleLog   = Join-Path $Base 'logs\console.log'
$HttpPort     = 20010
$ShutdownPort = 8015
$DocBase      = Join-Path $Project 'target\pigon_pc'
$StartTimeoutSec = 600

$env:JAVA_HOME = $JavaHome
$env:JRE_HOME = $JavaHome
$env:CATALINA_HOME = $CatalinaHome
$env:CATALINA_BASE = $Base

function Fail($msg) { Write-Output "WAS FAIL: $msg"; exit 1 }

New-Item -ItemType Directory -Force (Join-Path $Base 'logs') | Out-Null

function Init-Base {
    foreach ($d in 'conf', 'conf\Catalina\localhost', 'logs', 'temp', 'work', 'webapps') {
        New-Item -ItemType Directory -Force (Join-Path $Base $d) | Out-Null
    }
    foreach ($f in 'catalina.properties', 'catalina.policy', 'context.xml', 'logging.properties', 'web.xml', 'tomcat-users.xml') {
        $dst = Join-Path $Base "conf\$f"
        if (-not (Test-Path $dst)) { Copy-Item (Join-Path $CatalinaHome "conf\$f") $dst }
    }
    $server = @"
<?xml version="1.0" encoding="UTF-8"?>
<Server port="$ShutdownPort" shutdown="SHUTDOWN">
  <Listener className="org.apache.catalina.startup.VersionLoggerListener" />
  <Listener className="org.apache.catalina.core.JreMemoryLeakPreventionListener" />
  <Listener className="org.apache.catalina.mbeans.GlobalResourcesLifecycleListener" />
  <Listener className="org.apache.catalina.core.ThreadLocalLeakPreventionListener" />
  <Service name="Catalina">
    <Connector port="$HttpPort" protocol="HTTP/1.1" connectionTimeout="20000" URIEncoding="UTF-8" />
    <Engine name="Catalina" defaultHost="localhost">
      <Host name="localhost" appBase="webapps" unpackWARs="false" autoDeploy="false" />
    </Engine>
  </Service>
</Server>
"@
    Set-Content -Path (Join-Path $Base 'conf\server.xml') -Value $server -Encoding ASCII

    # Same context as IntelliJ ROOT.xml, docBase -> Maven exploded war
    $skip = 'poi*.jar,xmlbeans*.jar,jackson-*.jar,ojdbc*.jar,postgresql-*.jar,sqljdbc*.jar,p6spy-*.jar,chartfx*.jar,softwarefx*.jar,cglib*.jar,aspectjweaver*.jar,bcprov*.jar,bctls*.jar,bcutil*.jar,gson*.jar,okhttp*.jar,okio*.jar,jai_*.jar,commons-net*.jar,aether-*.jar,activation*.jar,aopalliance*.jar,jsoup*.jar,json-*.jar,curvesapi*.jar,ibatis-sqlmap*.jar,stax-api*.jar,jsr250-api*.jar,MarkCore.jar,nets-nsso*.jar,sapjco3.jar,kit-*.jar,open-csv*.jar'
    $ctx = @"
<Context path="" docBase="$DocBase">
  <Parameter name="log4jConfigLocation" value="classpath:log4j/local.properties" override="false" />
  <JarScanner>
    <JarScanFilter tldSkip="$skip" pluggabilitySkip="$skip" />
  </JarScanner>
</Context>
"@
    Set-Content -Path (Join-Path $Base 'conf\Catalina\localhost\ROOT.xml') -Value $ctx -Encoding ASCII
}

function Port-Owner {
    $c = Get-NetTCPConnection -LocalPort $HttpPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { return $c.OwningProcess } else { return $null }
}

function Our-Pid {
    if (Test-Path $PidFile) { return [int](Get-Content $PidFile) } else { return $null }
}

function Do-Build {
    # Tomcat runs the exploded dir (target\pigon_pc), so skip the .war zip and test compile (saves ~4 min)
    Write-Output "build: mvn clean compile war:exploded -> $BuildLog"
    $args1 = @('-f', (Join-Path $Project 'pom.xml'), '-o', '-B', '-Dmaven.test.skip=true', '-Dproject.build.sourceEncoding=UTF-8', 'clean', 'compile', 'war:exploded')
    & $Mvn @args1 *> $BuildLog
    if ($LASTEXITCODE -ne 0) {
        Write-Output 'build: offline build failed, retrying online'
        $args2 = @('-f', (Join-Path $Project 'pom.xml'), '-B', '-Dmaven.test.skip=true', '-Dproject.build.sourceEncoding=UTF-8', 'clean', 'compile', 'war:exploded')
        & $Mvn @args2 *> $BuildLog
        if ($LASTEXITCODE -ne 0) {
            Get-Content $BuildLog | Select-String '\[ERROR\]' | Select-Object -First 20 | ForEach-Object { $_.Line }
            Fail "maven build failed. log: $BuildLog"
        }
    }
    Write-Output 'build: OK'
}

function Do-Stop {
    $p = Our-Pid
    if ($p -and (Get-Process -Id $p -ErrorAction SilentlyContinue)) {
        Write-Output "stop: tomcat pid $p"
        & (Join-Path $CatalinaHome 'bin\catalina.bat') stop *> $null
        for ($i = 0; $i -lt 30 -and (Get-Process -Id $p -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Seconds 1 }
        if (Get-Process -Id $p -ErrorAction SilentlyContinue) { & taskkill /PID $p /T /F *> $null }
    }
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    $owner = Port-Owner
    if ($owner) { Fail "port $HttpPort is used by another process (pid $owner, maybe IntelliJ Tomcat). Not killing it." }
    Write-Output 'stop: OK'
}

function Do-Start {
    if (-not (Test-Path (Join-Path $DocBase 'WEB-INF\web.xml'))) { Fail "no exploded war at $DocBase. run build first" }
    $owner = Port-Owner
    if ($owner) { Fail "port $HttpPort already in use (pid $owner)" }
    Init-Base
    $before = @(Get-Process java -ErrorAction SilentlyContinue | ForEach-Object Id)
    # cmd /c strips the outermost quote pair, so wrap the whole line once more
    $cmd = "/c `"`"$CatalinaHome\bin\catalina.bat`" run > `"$ConsoleLog`" 2>&1`""
    $launcher = Start-Process -FilePath 'cmd.exe' -ArgumentList $cmd -WindowStyle Hidden -PassThru
    $deadline = (Get-Date).AddSeconds($StartTimeoutSec)
    $javaPid = $null
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 3
        if ($launcher.HasExited -and -not (Port-Owner)) {
            $tail = if (Test-Path $ConsoleLog) { (Get-Content $ConsoleLog -Tail 5) -join ' / ' } else { '(no console log)' }
            Fail "tomcat process exited early: $tail"
        }
        if (-not $javaPid) {
            $owner = Port-Owner
            if ($owner -and ($before -notcontains $owner)) { $javaPid = $owner; Set-Content $PidFile $javaPid }
        }
        if (Test-Path $ConsoleLog) {
            $bad = Select-String -Path $ConsoleLog -Pattern 'Context \[.*\] startup failed|One or more listeners failed to start|Error listenerStart' -SimpleMatch:$false | Select-Object -First 1
            if ($bad) { Do-Stop | Out-Null; Fail "context startup failed: $($bad.Line). log: $ConsoleLog" }
            if (Select-String -Path $ConsoleLog -Pattern 'Server startup in' -Quiet) {
                try {
                    $r = Invoke-WebRequest -Uri "http://localhost:$HttpPort/" -UseBasicParsing -TimeoutSec 30 -MaximumRedirection 0 -ErrorAction SilentlyContinue
                } catch { $r = $_.Exception.Response }
                Write-Output "start: OK (pid $javaPid) http://localhost:$HttpPort"
                return
            }
        }
    }
    Fail "startup timeout ${StartTimeoutSec}s. log: $ConsoleLog"
}

switch ($Action) {
    'build'   { Do-Build }
    'start'   { Do-Start }
    'stop'    { Do-Stop }
    'restart' { Do-Stop; Do-Build; Do-Start }
    'status'  {
        $p = Our-Pid; $o = Port-Owner
        Write-Output ("pidfile={0} portOwner={1} running={2}" -f $p, $o, [bool]($o -and $o -eq $p))
    }
}
exit 0
