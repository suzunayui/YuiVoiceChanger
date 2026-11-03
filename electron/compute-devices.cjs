const os=require('node:os');
const {run}=require('./setup.cjs');

async function computeDevices(python,tool){
 const cpu={id:'cpu',kind:'CPU',name:os.cpus()[0]?.model.trim()||'CPU',available:true};
 const [adapters,runtime]=await Promise.allSettled([
  process.platform==='win32'?run('powershell.exe',['-NoProfile','-NonInteractive','-Command',
   "[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); @(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) | ConvertTo-Json -Compress"],{timeout:15000}).then(text=>{
    const names=JSON.parse(text.trim()||'[]');return Array.isArray(names)?names:[names];
   }):Promise.resolve([]),
  python?tool(python,'compute-devices'):Promise.resolve({devices:[]})
 ]);
 const gpus=runtime.status==='fulfilled'?runtime.value.devices:[];
 const remaining=[...gpus];
 for(const [index,name] of (adapters.status==='fulfilled'?adapters.value:[]).entries()){
  const match=remaining.findIndex(gpu=>gpu.name===name);
  if(match>=0){remaining.splice(match,1);continue;}
  // Keep every CUDA device, including identically named cards, selectable.
  if(gpus.some(gpu=>gpu.name===name))continue;
  gpus.push({id:`unsupported:${index}`,kind:'GPU',name,available:false,reason:
   !python?'実行環境をセットアップすると利用可否を確認できます。':
   runtime.status==='rejected'?'GPUの利用可否を確認できませんでした。':
   /NVIDIA/i.test(name)?'現在の実行環境では利用できません。環境設定で環境を確認してください。':'このGPUでの変換には対応していません。'});
 }
 return {devices:[cpu,...gpus],warning:runtime.status==='rejected'?'GPUの確認に失敗しました。実行環境を確認して再読み込みしてください。':
  adapters.status==='rejected'?'一部のGPU情報を取得できませんでした。':''};
}
module.exports={computeDevices};
