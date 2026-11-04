const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const run=promisify(execFile);

const name='yui-live-preview';
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const encoded=script=>Buffer.from(script,'utf16le').toString('base64');

async function identical(file,bytes){
 try{return (await fs.readFile(file)).equals(bytes);}
 catch(error){if(error.code==='ENOENT')return false;throw error;}
}

async function installObsPlugin(source){
 if(process.platform!=='win32'||process.arch!=='x64'||!process.env.ProgramData)throw Error('Windows x64で利用できます。');
 const bytes=await fs.readFile(source);
 const directory=path.join(process.env.ProgramData,'obs-studio','plugins',name);
 const target=path.join(directory,name+'.dll');
 if(await identical(target,bytes))return {alreadyInstalled:true};

 const temporary=path.join(directory,randomUUID()+'.tmp');
 try{
  await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(temporary,bytes,{flag:'wx'});
  await fs.rename(temporary,target);
 }catch(error){
  if(!['EACCES','EPERM'].includes(error.code))throw error;
  const hash=createHash('sha256').update(bytes).digest('hex');
  const elevatedTemporary=path.join(directory,randomUUID()+'.tmp');
  const copy=`$ErrorActionPreference='Stop'
$source=${quote(source)}
$destination=${quote(target)}
$temporary=${quote(elevatedTemporary)}
$copied=$false
try {
 if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne '${hash}') { throw 'Plugin file changed' }
 $directory=$env:ProgramData
 foreach ($part in @('obs-studio','plugins','yui-live-preview')) {
  $directory=Join-Path $directory $part
  $item=[System.IO.Directory]::CreateDirectory($directory)
  if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Redirected OBS plugin directory' }
 }
 if ((Join-Path $directory 'yui-live-preview.dll') -ne $destination) { throw 'Unexpected destination' }
 [System.IO.File]::Copy($source,$temporary,$false)
 $copied=$true
 if ((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash -ne '${hash}') { throw 'Plugin file changed' }
 if ([System.IO.File]::Exists($destination)) {
  if ([System.IO.File]::GetAttributes($destination) -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Redirected plugin file' }
  [System.IO.File]::Replace($temporary,$destination,"$temporary.bak")
  [System.IO.File]::Delete("$temporary.bak")
 }
 else { [System.IO.File]::Move($temporary,$destination) }
} finally { if ($copied -and [System.IO.File]::Exists($temporary)) { [System.IO.File]::Delete($temporary) } }`;
  const elevate=`$ErrorActionPreference='Stop'
$p=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile -NonInteractive -EncodedCommand ${encoded(copy)}'
exit $p.ExitCode`;
  const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  try{await run(powershell,['-NoProfile','-NonInteractive','-EncodedCommand',encoded(elevate)],{windowsHide:true});}
  catch{throw Error('導入できませんでした。OBSを終了し、管理者の許可を確認してからもう一度お試しください。');}
 }finally{
  await fs.rm(temporary,{force:true}).catch(()=>{});
 }
 if(!await identical(target,bytes))throw Error('導入したプラグインを確認できませんでした。');
 return {alreadyInstalled:false};
}
module.exports={installObsPlugin};
