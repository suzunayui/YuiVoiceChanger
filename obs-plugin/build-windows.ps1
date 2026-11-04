param(
    [Parameter(Mandatory)][string]$ObsSource,
    [Parameter(Mandatory)][string]$QtSdk,
    [Parameter(Mandatory)][string]$ObsBin,
    [Parameter(Mandatory)][string]$Output
)

$ErrorActionPreference = 'Stop'
if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    throw 'Run this script from an x64 Visual Studio Developer PowerShell.'
}
$ObsSource = (Resolve-Path -LiteralPath $ObsSource).Path
$QtSdk = (Resolve-Path -LiteralPath $QtSdk).Path
$ObsBin = (Resolve-Path -LiteralPath $ObsBin).Path
$Output = (New-Item -ItemType Directory -Path $Output -Force).FullName
$source = $PSScriptRoot

Push-Location -LiteralPath $Output
try {
    # Import libraries match the actual OBS DLLs; no OBS rebuild is needed.
    foreach ($name in @('obs', 'obs-frontend-api')) {
        $symbols = & dumpbin.exe /nologo /exports (Join-Path $ObsBin "$name.dll")
        if ($LASTEXITCODE) { throw "dumpbin failed for $name.dll" }
        $exports = foreach ($line in $symbols) {
            if ($line -match '^\s+\d+\s+[\da-fA-F]+\s+[\da-fA-F]+\s+(\S+)') { $Matches[1] }
        }
        if (-not $exports) { throw "No exports found in $name.dll" }
        @("LIBRARY $name.dll", 'EXPORTS') + $exports | Set-Content -Encoding ascii "$name.def"
        & lib.exe /nologo /machine:x64 "/def:$name.def" "/out:$name.lib"
        if ($LASTEXITCODE) { throw "Import library generation failed for $name.dll" }
    }

    @('#pragma once', '#define OBS_RELEASE_CANDIDATE 0', '#define OBS_BETA 0') |
        Set-Content -Encoding ascii obsconfig.h

    $common = @('/nologo', '/O2', '/MD', '/utf-8', '/DNOMINMAX', "/I$Output", "/I$ObsSource/libobs")
    & cl.exe @common /std:c11 /c "$source/preview-delay.c"
    if ($LASTEXITCODE) { throw 'Filter compilation failed' }

    $qtIncludes = @('include','include/QtCore','include/QtGui','include/QtWidgets') | ForEach-Object { "/I$QtSdk/$_" }
    & cl.exe @common @qtIncludes /std:c++17 /EHsc /Zc:__cplusplus /permissive- "/I$ObsSource/frontend/api" /c "$source/live-preview.cpp"
    if ($LASTEXITCODE) { throw 'Preview compilation failed' }

    & link.exe /nologo /dll /out:yui-live-preview.dll live-preview.obj preview-delay.obj obs.lib obs-frontend-api.lib "/libpath:$QtSdk/lib" Qt6Core.lib Qt6Gui.lib Qt6Widgets.lib
    if ($LASTEXITCODE) { throw 'Plugin linking failed' }
} finally {
    Pop-Location
}
