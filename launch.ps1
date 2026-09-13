# String Art Studio launcher.
#
# Starts the static server on a free loopback port with no console window,
# opens it in an Edge app window (no tabs, no address bar, its own taskbar
# icon), and shuts the server down again when that window is closed.
#
# Normally started by Launch.vbs so nothing flashes on screen.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Log($msg) {
    $dir = Join-Path $env:LOCALAPPDATA 'StringArtStudio'
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg" |
        Out-File -FilePath (Join-Path $dir 'launcher.log') -Append -Encoding utf8
}

function Get-FreePort {
    param([int]$Start = 8123)
    for ($p = $Start; $p -lt ($Start + 60); $p++) {
        $listener = $null
        try {
            $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p)
            $listener.Start()
            $listener.Stop()
            return $p
        } catch {
            if ($listener) { try { $listener.Stop() } catch {} }
        }
    }
    throw 'No free port in 8123-8182.'
}

function Wait-ForPort {
    param([int]$Port, [int]$TimeoutSec = 20)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $client = New-Object System.Net.Sockets.TcpClient
        try {
            $client.Connect('127.0.0.1', $Port)
            $client.Close()
            return $true
        } catch {
            Start-Sleep -Milliseconds 120
        } finally {
            $client.Dispose()
        }
    }
    return $false
}

function Find-Edge {
    $candidates = @(
        "$env:ProgramFiles(x86)\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
    )
    foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
    $cmd = Get-Command msedge.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

$server = $null
try {
    $port = Get-FreePort
    Write-Log "starting on port $port"

    # pythonw / node run without spawning a console window
    $pyw  = Get-Command pythonw.exe -ErrorAction SilentlyContinue
    $node = Get-Command node.exe -ErrorAction SilentlyContinue

    if ($pyw) {
        $server = Start-Process -FilePath $pyw.Source `
            -ArgumentList @('serve.py', "$port", '--no-browser') `
            -WorkingDirectory $root -WindowStyle Hidden -PassThru
    } elseif ($node) {
        $server = Start-Process -FilePath $node.Source `
            -ArgumentList @('serve.mjs', "$port") `
            -WorkingDirectory $root -WindowStyle Hidden -PassThru
    } else {
        [System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null
        [System.Windows.Forms.MessageBox]::Show(
            "String Art Studio needs Python or Node.js to serve its files locally.`n`nInstall either one, then try again.",
            'String Art Studio') | Out-Null
        exit 1
    }

    if (-not (Wait-ForPort -Port $port)) {
        throw "Server did not come up on port $port."
    }

    $url  = "http://127.0.0.1:$port/"
    $edge = Find-Edge

    if ($edge) {
        # A dedicated profile keeps the app window's size and position between
        # launches, and keeps its saved settings separate from normal browsing.
        $profile = Join-Path $env:LOCALAPPDATA 'StringArtStudio\window'
        $edgeArgs = @(
            "--app=$url",
            "--user-data-dir=`"$profile`"",
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-features=Translate,msEdgeSplitScreen'
        )
        $browser = Start-Process -FilePath $edge -ArgumentList $edgeArgs -PassThru
        Write-Log "edge launched, pid $($browser.Id)"

        # Do NOT just WaitForExit() on that process. When a browser process is
        # already alive for this profile, the one we launched hands the window
        # over and exits immediately — we would then tear the server down under
        # a window that is still open. Track every msedge owning this profile.
        $mine = { @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
                    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profile) }) }

        $appeared = $false
        $deadline = (Get-Date).AddSeconds(25)
        while ((Get-Date) -lt $deadline) {
            if ((& $mine).Count -gt 0) { $appeared = $true; break }
            Start-Sleep -Milliseconds 400
        }

        if ($appeared) {
            Write-Log 'window open, waiting for it to close'
            while ((& $mine).Count -gt 0) { Start-Sleep -Seconds 2 }
            Write-Log 'window closed'
        } else {
            # Never saw a window — keep serving rather than killing it blindly.
            Write-Log 'no window detected; waiting on the launched process'
            if (-not $browser.HasExited) { $browser.WaitForExit() }
        }
    } else {
        # No Edge: fall back to the default browser and keep serving until
        # the user closes this launcher from the tray/Task Manager.
        Write-Log 'edge not found, using default browser'
        Start-Process $url
        while ($server -and -not $server.HasExited) { Start-Sleep -Seconds 2 }
    }
} catch {
    Write-Log "ERROR: $_"
    [System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null
    [System.Windows.Forms.MessageBox]::Show(
        "String Art Studio could not start.`n`n$_`n`nDetails: %LOCALAPPDATA%\StringArtStudio\launcher.log",
        'String Art Studio') | Out-Null
} finally {
    if ($server -and -not $server.HasExited) {
        try { Stop-Process -Id $server.Id -Force; Write-Log 'server stopped' } catch {}
    }
}
