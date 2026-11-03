const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {Readable,Transform}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const {engineRoot}=require('./paths.cjs');
const PYTHON='3.15.2';
const UV_URL='https://github.com/astral-sh/uv/releases/download/0.13.6/uv-x86_64-pc-windows-msvc.zip';
const UV_SHA='a2a8820d5eea32f08ef467ef3b7f66883a9b076d5737a2fc2fbb5f458d1bb50f';
const MAC_UV_URL='https://github.com/astral-sh/uv/releases/download/0.13.6/uv-aarch64-apple-darwin.tar.gz';
const MAC_UV_SHA='60fbd5c8a1ed681845eea28d9d622fcde03c51e91a43465b64a1e17db1ed3472';
function run(exe,args,{env={},timeout=120000,progress}={}){
 return new Promise((resolve,reject)=>{
  const p=spawn(exe,args,{cwd:os.tmpdir(),windowsHide:true,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
  let output='',settled=false;
  const done=(error)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(output);};
  for(const stream of [p.stdout,p.stderr])stream.on('data',d=>{
   const text=d.toString('utf8');output=(output+text).slice(-12000);
   if(progress)progress(text.trim().slice(-350));
  });
  const timer=setTimeout(()=>{p.kill();done(Error('環境の準備が時間切れになりました。もう一度試してください。'));},timeout);
  p.once('error',e=>done(Error(`準備用プログラムを起動できません (${e.code||e.message}): ${exe}`)));
  p.once('exit',code=>done(code===0?null:Error(output||`準備に失敗しました (${code})`)));
 });
}
async function download(url,file,hash,{timeout=120000,signal,headers,onProgress}={}){
 const response=await fetch(url,{headers,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout)});
 if(!response.ok)throw Error(`ダウンロードに失敗しました (${response.status})`);
 const digest=crypto.createHash('sha256');
 let received=0;const total=Number(response.headers.get('content-length'))||0;
 const verifier=new Transform({transform(chunk,encoding,callback){digest.update(chunk);received+=chunk.length;if(onProgress)onProgress({received,total});callback(null,chunk);}});
 const temporary=file+'.partial';
 try{
  await pipeline(Readable.fromWeb(response.body),verifier,fs.createWriteStream(temporary));
  if(digest.digest('hex')!==hash)throw Error('ダウンロードしたファイルの検証に失敗しました。');
  fs.renameSync(temporary,file);
 }catch(e){fs.rmSync(temporary,{force:true});throw e;}
}
function backendRoot(){return path.join(engineRoot(path.resolve(__dirname,'..'),process.resourcesPath||'',false),'backend');}
async function validate(python){
 const info=JSON.parse((await run(python,['-I',path.join(backendRoot(),'runtime_info.py')])).trim());
 return info;
}
async function setup(home,progress){
 const mac=process.platform==='darwin'&&process.arch==='arm64';
 if(!mac&&(process.platform!=='win32'||process.arch!=='x64'))throw Error('Windows x64またはApple Silicon Macを使用してください。');
 const root=path.join(home,'runtime');fs.mkdirSync(root,{recursive:true});
 const active=path.join(root,'direct-gpu-runtime.json');
 try{
  const previous=JSON.parse(fs.readFileSync(active,'utf8'));
  if(previous.revision===2){
   const info=await validate(previous.python);
   const driver=!mac&&fs.existsSync(path.join(process.env.WINDIR||'C:\\Windows','System32','nvcuda.dll'));
   if(driver&&!info.cuda)throw Error('GPU用環境へ更新します。');
   progress('既存のPython 3.15変換環境を確認しました。');return {python:previous.python};
  }
 }catch{}
 const dir=path.join(root,`direct-gpu-${crypto.randomUUID()}`);fs.mkdirSync(dir,{recursive:true});
 progress('セットアップ用ツールをダウンロードしています…');
 const archive=path.join(dir,mac?'uv.tar.gz':'uv.zip');await download(mac?MAC_UV_URL:UV_URL,archive,mac?MAC_UV_SHA:UV_SHA);
 const quote=s=>"'"+s.replace(/'/g,"''")+"'";
 if(mac)await run('/usr/bin/tar',['-xzf',archive,'-C',dir,'--strip-components=1']);
 else await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(dir)} -Force`]);
 fs.unlinkSync(archive);
 const uv=path.join(dir,mac?'uv':'uv.exe');
 if(mac)fs.chmodSync(uv,0o700);
 const install=path.join(root,'python');
 const env={UV_PYTHON_INSTALL_DIR:install,UV_CACHE_DIR:path.join(root,'uv-cache'),UV_NO_PROGRESS:'1',UV_PYTHON_DOWNLOADS:'manual'};
 progress(`Python ${PYTHON}を準備しています…`);
 await run(uv,['python','install',PYTHON,'--no-bin',...(!mac?['--no-registry']:[])],{env,timeout:300000,progress});
 const base=mac?(await run(uv,['python','find','--managed-python',PYTHON],{env})).trim().split(/\r?\n/).at(-1):path.join(install,`cpython-${PYTHON}-windows-x86_64-none`,'python.exe');
 const venv=path.join(dir,'venv');
 await run(uv,['venv','--python',base,venv],{env});
 const python=path.join(venv,mac?'bin':'Scripts',mac?'python':'python.exe');
 const useGpu=!mac&&fs.existsSync(path.join(process.env.WINDIR||'C:\\Windows','System32','nvcuda.dll'));
 progress(useGpu?'GPU用PyTorchと音声ライブラリを準備しています（数GBのダウンロード）…':'CPU用PyTorchと音声ライブラリを準備しています…');
 const requirementsName=mac?'requirements-mac.txt':'requirements.txt';
 const bundled=path.join(backendRoot(),requirementsName);
 let requirements=fs.existsSync(bundled)?bundled:path.join(backendRoot(),'..',requirementsName);
 if(!mac&&!useGpu){
  const content=fs.readFileSync(requirements,'utf8').replace(/^torch @ .*$/m,'torch @ https://download-r2.pytorch.org/whl/cpu/torch-2.15.0%2Bcpu-cp315-cp315-win_amd64.whl#sha256=5c21ee962b6f67821dac0bc882f5ee1539a4edeabe736284d2ff1d652e595ed1');
  requirements=path.join(dir,'requirements-cpu.txt');fs.writeFileSync(requirements,content);
 }
 await run(uv,['pip','install','--python',python,'--only-binary',':all:','-r',requirements],{env,timeout:1800000,progress});
 progress('Python・GPU・音声デバイスの動作を確認しています…');
 const info=await validate(python);
 fs.writeFileSync(active,JSON.stringify({...info,python_version:info.python,revision:2,python,platform:process.platform,arch:process.arch},null,2));
 return {python};
}
module.exports={setup,run,download,validate,PYTHON,UV_URL,UV_SHA,MAC_UV_URL,MAC_UV_SHA};
