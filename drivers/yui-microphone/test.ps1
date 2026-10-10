$ErrorActionPreference='Stop'
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$vswhere=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vs=& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if(!$vs){throw 'MSVC C++ tools not found'}
$vc=(Get-ChildItem (Join-Path $vs 'VC/Tools/MSVC') -Directory | Sort-Object Name -Descending | Select-Object -First 1).FullName
$kits=Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10'
$sdk=(Get-ChildItem (Join-Path $kits 'Include') -Directory | Sort-Object Name -Descending | Select-Object -First 1).Name
$oldInclude=$env:INCLUDE;$oldLib=$env:LIB
try {
 $env:INCLUDE="$vc/include;$kits/Include/$sdk/ucrt;$kits/Include/$sdk/shared;$kits/Include/$sdk/um"
 $env:LIB="$vc/lib/x64;$kits/Lib/$sdk/ucrt/x64;$kits/Lib/$sdk/um/x64"
 $folder=Join-Path $repo '.local/yui-driver-tests';New-Item -ItemType Directory -Force $folder | Out-Null
 $exe=Join-Path $folder 'bridge_test.exe';$obj=Join-Path $folder 'bridge_test.obj'
 & (Join-Path $vc 'bin/Hostx64/x64/cl.exe') /nologo /W4 /WX /EHsc /std:c++17 (Join-Path $PSScriptRoot 'bridge_test.cpp') "/Fe$exe" "/Fo$obj"
 if($LASTEXITCODE){throw 'Native bridge compile failed'}
 & $exe
 if($LASTEXITCODE){throw 'Native bridge tests failed'}
} finally { $env:INCLUDE=$oldInclude;$env:LIB=$oldLib }
