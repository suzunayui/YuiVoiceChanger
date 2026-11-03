// Download the official model only after the user's explicit consent click.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {download,run}=require('./setup.cjs');
const TERMS_URL='https://prj-beatrice.com/2.0.0-rc.0-official-model-1-terms';
const DOWNLOAD_URL='https://storage.prj-beatrice.com/beatrice_2.0.0-rc.0_official_model_1.zip';
const ARCHIVE_SHA='046273adf7403143c64fabe1f84645f3a0349fdaf6aad23055a0dda23a2efe8f';
const STEM='beatrice_2.0.0-rc.0_official_model_1';
const MANIFEST=STEM+'.toml';
const FILES={
 'README.txt':'ceb6f0c451c5aa85fa186ff7b6490c1c13872b906c3de9b22fba6a9ac0ccd363',
 'embedding_setter.bin':'96a26173e970b1c38223a1fba6a6855f235d987d43972b39e7a8f9b434cdfd1b',
 'speaker_embeddings.bin':'3b2a6ff73398d6a2acac4e0b4ae562d85c4c0eb2fb1e8fb7dedadab6457bf270',
 'phone_extractor.bin':'2fc0f8f2f9af6a1831a38ee236907c1663a25809ed4368dfc1c88288aab60e63',
 'pitch_estimator.bin':'a99cba14478c6e8a8a727191316f0df5ff1951f968316d5e464356aa5b1708f1',
 'waveform_generator.bin':'294ee92c1a7a9d514285e313b54ef7b9e138e6b787deec8234a6ba7b6e5fdb0c',
 [MANIFEST]:'518a73586eb57668a0f52684babcfdd5638e14c5b0151c981f0931ff88254ff7',
 'tsukuyomichan.png':'229f95643480f8b4845aa085161653e7b4757a39043d2e22272670f5f8c35cb8',
 'tokinashigure.png':'b6d75cffa8648850b1afdc99259980a02291818588a6c978e56df2af3e0d63ce',
 'olune.png':'e207ce0c610b48633c14c2a2ec3ea7c540884d54ee832531fc27c7f93cc7f9aa'
};
function validInstallation(folder){
 try{return Object.entries(FILES).every(([name,hash])=>{
  const file=path.join(folder,name);
  return fs.statSync(file).isFile()&&crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')===hash;
 });}catch{return false;}
}
function quote(value){return "'"+value.replace(/'/g,"''")+"'";}
async function extract(archive,destination){
 const script=[
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName System.IO.Compression.FileSystem',
  `$extractRoot=[IO.Path]::GetFullPath(${quote(destination)}).TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar`,
  `$modelZip=[IO.Compression.ZipFile]::OpenRead(${quote(archive)})`,
  'try { foreach($modelEntry in $modelZip.Entries) {',
  "if([IO.Path]::IsPathRooted($modelEntry.FullName) -or $modelEntry.FullName.Contains(':')) { throw 'Invalid archive path' }",
  '$entryTarget=[IO.Path]::GetFullPath([IO.Path]::Combine($extractRoot,$modelEntry.FullName))',
  "if(-not $entryTarget.StartsWith($extractRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'Archive escapes destination' }",
  "if((($modelEntry.ExternalAttributes -shr 16) -band 61440) -eq 40960) { throw 'Archive links are not supported' }",
  '} } finally { $modelZip.Dispose() }',
  `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(destination)}`
 ].join('\n');
 await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script]);
}
async function installOfficial(home,{agreed,signal,progress=()=>{}}={}){
 if(agreed!==true)throw Error('公式モデルの利用規約への同意が必要です。');
 if(process.platform!=='win32')throw Error('モデルの自動導入はWindows用です。');
 const root=path.resolve(home,'models');
 const target=path.join(root,'beatrice-official-model-1-rc0');
 const receipt={source:DOWNLOAD_URL,archive_sha256:ARCHIVE_SHA,terms_url:TERMS_URL,
  agreed_at:new Date().toISOString(),consent:'explicit-install-button',voice:1,name:'つくよみちゃん（コーパス）'};
 const result=()=>({beatrice_model:path.join(target,MANIFEST),beatrice_voice:1,beatrice_model_alias:'',beatrice_model_icon:''});
 if(validInstallation(target)){
  fs.writeFileSync(path.join(target,'installation.json'),JSON.stringify(receipt,null,2));
  progress('導入済みの公式モデルを確認しました。');return result();
 }
 fs.mkdirSync(root,{recursive:true});
 const stage=path.join(root,'.official-install-'+crypto.randomUUID());fs.mkdirSync(stage);
 try{
  progress('公式配布元からモデルをダウンロードしています…');
  let last=-1;
  await download(DOWNLOAD_URL,path.join(stage,'model.zip'),ARCHIVE_SHA,{
   signal,timeout:300000,headers:{Referer:TERMS_URL},onProgress:({received,total})=>{
    const percent=total?Math.floor(received*100/total):-1;
    if(percent>last){last=percent;progress(`公式モデルをダウンロード中… ${percent}%`);}
   }
  });
  signal?.throwIfAborted();
  progress('公式モデルを展開・確認しています…');
  const destination=path.join(stage,'extracted');await extract(path.join(stage,'model.zip'),destination);
  signal?.throwIfAborted();
  const model=path.join(destination,STEM);
  if(!validInstallation(model))throw Error('公式モデルの検証に失敗しました。もう一度導入してください。');
  fs.writeFileSync(path.join(model,'installation.json'),JSON.stringify(receipt,null,2));
  let backup;
  if(fs.existsSync(target)){backup=target+'.previous-'+crypto.randomUUID();fs.renameSync(target,backup);}
  try{fs.renameSync(model,target);}catch(error){if(backup&&!fs.existsSync(target))fs.renameSync(backup,target);throw error;}
  progress('つくよみちゃん（コーパス）の導入が完了しました。');
  return result();
 }finally{
  // Delete only this newly created staging directory after checking its root.
  const resolved=path.resolve(stage);
  if(path.dirname(resolved)===root&&path.basename(resolved).startsWith('.official-install-'))fs.rmSync(resolved,{recursive:true,force:true});
 }
}
module.exports={installOfficial,validInstallation,TERMS_URL,DOWNLOAD_URL,ARCHIVE_SHA,FILES};
