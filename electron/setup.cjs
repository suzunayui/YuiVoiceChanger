const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const os=require('node:os');
const {spawn}=require('node:child_process');
function run(exe,args){return new Promise((resolve,reject)=>{
 const cwd=os.tmpdir();
 const p=spawn(exe,args,{cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';
 for(const s of [p.stdout,p.stderr])s.on('data',d=>{output=(output+d).slice(-6000)});
 const timer=setTimeout(()=>{p.kill();reject(Error('環境の準備が時間切れになりました。もう一度試してください。'));},120000);
 p.once('error',e=>{clearTimeout(timer);reject(Error(`準備用プログラムを起動できません (${e.code||e.message})。実行ファイル: ${exe} / 作業フォルダ: ${cwd}`))});p.once('exit',code=>{clearTimeout(timer);code===0?resolve(output):reject(Error(output||`準備に失敗しました (${code})`))});
});}
async function download(url,file,hash){
 const response=await fetch(url,{signal:AbortSignal.timeout(120000)});
 if(!response.ok)throw Error(`ダウンロードに失敗しました (${response.status})`);
 const data=Buffer.from(await response.arrayBuffer());
 if(crypto.createHash('sha256').update(data).digest('hex')!==hash)throw Error('ダウンロードしたファイルの検証に失敗しました。再試行してください。');
 fs.writeFileSync(file,data);
}
async function setup(home,progress){
 if(process.platform==='darwin')return setupMac(home,progress);
 if(process.platform!=='win32'||process.arch!=='x64')throw Error('自動セットアップはWindows 64bit用です。');
 // A fresh folder keeps interrupted installs and existing environments independent.
 const dir=path.join(home,'runtime',`python-3.12.10-${crypto.randomUUID()}`);fs.mkdirSync(dir,{recursive:true});
 const quote=s=>"'"+s.replace(/'/g,"''")+"'";
 const extract=async(zip,destination)=>run('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(destination)} -Force`]);
 progress('Pythonをダウンロードしています…');
 const archive=path.join(dir,'python.zip');
 const digest=Buffer.from('SsvtbdHHRLA3bjsc9XzpBvncnpXmiCRYTICZpjAlo8M=','base64').toString('hex');
 await download('https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip',archive,digest);
 await extract(archive,dir);fs.unlinkSync(archive);
 const libs=path.join(dir,'libs');fs.mkdirSync(libs);
 // Binary wheels only: no compiler, pip, launcher, PATH change, or administrator access.
 for(const [name,version,tag] of [['numpy','1.26.4','cp312-cp312-win_amd64'],['sounddevice','0.5.1','py3-none-win_amd64'],['pedalboard','0.9.25','cp312-cp312-win_amd64'],['cffi','1.17.1','cp312-cp312-win_amd64'],['pycparser','2.22','py3-none-any']]){
  progress(`${name}を準備しています…`);
  const response=await fetch(`https://pypi.org/pypi/${name}/${version}/json`,{signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error(`${name}の配布情報を取得できませんでした。`);
  const metadata=await response.json();const wheel=metadata.urls.find(x=>x.filename.endsWith(`-${tag}.whl`));
  if(!wheel||!wheel.url.startsWith('https://files.pythonhosted.org/'))throw Error(`${name}の対応ファイルが見つかりません。`);
  const zip=path.join(dir,`${name}.zip`);await download(wheel.url,zip,wheel.digests.sha256);await extract(zip,libs);fs.unlinkSync(zip);
 }
 fs.writeFileSync(path.join(dir,'python312._pth'),'python312.zip\n.\nlibs\n');
 const python=path.join(dir,'python.exe');progress('音声ライブラリの動作を確認しています…');
 await run(python,['-I','-c','import numpy, sounddevice, pedalboard, cffi, tomllib; print(numpy.__version__); print(sounddevice.query_devices())']);
 return {python,beatrice_libs:libs};
}
async function setupMac(home,progress){
 if(process.arch!=='arm64')throw Error('Mac版はApple Silicon専用です。Rosettaを使わず起動してください。');
 const dir=path.join(home,'runtime',`python-3.12.11-${crypto.randomUUID()}`);fs.mkdirSync(dir,{recursive:true});
 progress('Mac用Pythonをダウンロードしています…');
 const archive=path.join(dir,'python.tar.gz');
 await download('https://github.com/astral-sh/python-build-standalone/releases/download/20250918/cpython-3.12.11%2B20250918-aarch64-apple-darwin-install_only.tar.gz',archive,'f7bd4b224b5257a2530a9f798612239d9f95043a8432d44c93761a01c58492e9');
 await run('/usr/bin/tar',['-xzf',archive,'-C',dir]);fs.unlinkSync(archive);
 const python=path.join(dir,'python','bin','python3.12');
 const libs=path.join(dir,'libs');fs.mkdirSync(libs);
 for(const [name,version,tag] of [['numpy','1.26.4','cp312-cp312-macosx_11_0_arm64'],['sounddevice','0.5.1','py3-none-macosx_10_6_x86_64.macosx_10_6_universal2'],['pedalboard','0.9.25','cp312-cp312-macosx_11_0_arm64'],['cffi','1.17.1','cp312-cp312-macosx_11_0_arm64'],['pycparser','2.22','py3-none-any']]){
  progress(`${name}を準備しています…`);
  const response=await fetch(`https://pypi.org/pypi/${name}/${version}/json`,{signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error(`${name}の配布情報を取得できませんでした。`);
  const metadata=await response.json();const wheel=metadata.urls.find(x=>x.filename.endsWith(`-${tag}.whl`));
  if(!wheel||!wheel.url.startsWith('https://files.pythonhosted.org/'))throw Error(`${name}のMac対応ファイルが見つかりません。`);
  const zip=path.join(dir,`${name}.zip`);await download(wheel.url,zip,wheel.digests.sha256);
  await run('/usr/bin/ditto',['-x','-k',zip,libs]);fs.unlinkSync(zip);
 }
 progress('Mac用音声ライブラリを確認しています…');
 await run(python,['-I','-c',`import sys; sys.path.insert(0, ${JSON.stringify(libs)}); import numpy, sounddevice, pedalboard, cffi, tomllib; print(sounddevice.query_devices())`]);
 return {python,beatrice_libs:libs};
}
module.exports={setup,run};
