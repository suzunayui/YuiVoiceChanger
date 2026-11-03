const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {download,run}=require('./setup.cjs');
const BEATRICE='f34836de014b86956096878aecb8d3b17feaaa0b';
const RVC='e6d0c1a17da07c33557852f9dfa2bd44cc75737d';
const ASSETS=[
 ['beatrice/phone.pt',`https://huggingface.co/fierce-cats/beatrice-trainer/resolve/${BEATRICE}/assets/pretrained/122_checkpoint_03000000.pt`,'46e2d609825ace2158c83672cfc9cc1dcb3c2b7c8d294ee911fcb6840a592bae'],
 ['beatrice/pitch.pt',`https://huggingface.co/fierce-cats/beatrice-trainer/resolve/${BEATRICE}/assets/pretrained/104_3_checkpoint_00300000.pt`,'174e5411009e0e4f6ee8a8c97c4cd2f646791eae1b9aa2b425acb797e0353ef4'],
 ['beatrice/base.pt.gz',`https://huggingface.co/fierce-cats/beatrice-trainer/resolve/${BEATRICE}/assets/pretrained/151_checkpoint_libritts_r_200_02750000.pt.gz`,'14ecdb01e51cf22b80664973daa3dedeeb0bada48bbf5262e58950c818cdcb1a'],
 ['rvc/hubert_base/pytorch_model.bin',`https://huggingface.co/lj1995/VoiceConversionWebUI/resolve/${RVC}/hubert_base/pytorch_model.bin`,'cc8c20f4b90a520757260197a3ff2505705a7adbd20ad9eeaa4e1a9b38442ef5'],
 ['rvc/rmvpe.pt',`https://huggingface.co/lj1995/VoiceConversionWebUI/resolve/${RVC}/rmvpe.pt`,'6d62215f4306e3ca278246188607209f09af3dc77ed4232efdd069798c4ec193']
];
async function digest(file){const hash=crypto.createHash('sha256');for await(const part of fs.createReadStream(file))hash.update(part);return hash.digest('hex');}
async function prepareAssets(home,progress,cancelled=()=>false,signal){
 const root=path.join(home,'model-assets');
 for(const [name,url,hash] of ASSETS){
  if(cancelled())throw Error('準備を中止しました。');
  const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});
  if(fs.existsSync(file)&&await digest(file)===hash)continue;
  progress(`学習用ファイルを準備しています: ${name}`);
  await download(url,file,hash,{timeout:600000,signal});
 }
 for(const name of ['config.json','preprocessor_config.json']){
  const file=path.join(root,'rvc/hubert_base',name);
  const response=await fetch(`https://huggingface.co/lj1995/VoiceConversionWebUI/resolve/${RVC}/hubert_base/${name}`,{signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error('特徴抽出モデルの情報を取得できませんでした。');
  const value=await response.json();fs.writeFileSync(file,JSON.stringify(value));
 }
 return root;
}
async function prepareOnnx(home,progress){
 const root=path.join(home,'runtime'),manifest=JSON.parse(fs.readFileSync(path.join(root,'direct-gpu-runtime.json'),'utf8'));
 // Reuse the verified uv already acquired by normal setup; no system Python.
 const uv=path.join(path.dirname(path.dirname(path.dirname(manifest.python))),'uv.exe');
 if(!fs.existsSync(uv))throw Error('通常の環境セットアップを先に実行してください。');
 const dir=path.join(root,'onnx-helper-3.14');
 const python=path.join(dir,'Scripts','python.exe');
 if(fs.existsSync(python)){
  try{await run(python,['-I','-c','import sys,onnxruntime as o,numpy; assert sys.version_info[:3]>=(3,14,10); assert "CUDAExecutionProvider" in o.get_available_providers()']);return python;}catch{}
 }
 const env={UV_PYTHON_INSTALL_DIR:path.join(root,'python'),UV_CACHE_DIR:path.join(root,'uv-cache'),UV_NO_PROGRESS:'1'};
 progress('ONNX専用の互換環境を準備しています…');
 await run(uv,['python','install','3.14.10','--no-bin','--no-registry'],{env,timeout:300000,progress});
 const base=path.join(env.UV_PYTHON_INSTALL_DIR,'cpython-3.14.10-windows-x86_64-none','python.exe');
 if(!fs.existsSync(python))await run(uv,['venv','--python',base,dir],{env});
 await run(uv,['pip','uninstall','--python',python,'onnxruntime'],{env});
 await run(uv,['pip','install','--python',python,'--only-binary',':all:','onnxruntime-gpu==1.31.1','numpy==2.5.4'],{env,timeout:300000,progress});
 return python;
}
module.exports={prepareAssets,prepareOnnx,ASSETS};
