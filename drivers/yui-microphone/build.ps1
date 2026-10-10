param([Parameter(Mandatory=$true)][string]$SourceRoot,[string]$Python='python')
$ErrorActionPreference='Stop'
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$vswhere=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vs=& $vswhere -latest -products '*' -requires Microsoft.Component.MSBuild -property installationPath
if(!$vs){throw 'Visual Studio C++ と WDK が必要です。'}
$msbuild=Join-Path $vs 'MSBuild/Current/Bin/MSBuild.exe'
$toolsets=Get-ChildItem (Join-Path $vs 'MSBuild/Microsoft/VC') -Filter WindowsKernelModeDriver10.0 -Directory -Recurse -ErrorAction SilentlyContinue
if(!$toolsets){throw 'WDK の WindowsKernelModeDriver10.0 ツールセットがありません。ドライバーはまだビルドできません。署名済みドライバーのインストールや起動設定の変更は行いません。'}
$folder=Join-Path $repo ('.local/yui-driver-'+[guid]::NewGuid().ToString('N'))
& $Python (Join-Path $PSScriptRoot 'prepare.py') $SourceRoot $folder
if($LASTEXITCODE){throw 'Source preparation failed'}
& $msbuild (Join-Path $folder 'EndpointsCommon/EndpointsCommon.vcxproj') /p:Configuration=Release /p:Platform=x64
if($LASTEXITCODE){throw 'EndpointsCommon build failed'}
& $msbuild (Join-Path $folder 'TabletAudioSample/TabletAudioSample.vcxproj') /p:Configuration=Release /p:Platform=x64
if($LASTEXITCODE){throw 'Driver build failed'}
Write-Output "Build output: $folder (not installed; requires package verification and signing)"
