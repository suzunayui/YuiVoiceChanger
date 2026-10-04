// Assemble an unsigned Apple Silicon preview without extracting Mach-O symlinks on Windows.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const asar=require('@electron/asar');
(async()=>{
 const root=path.resolve(__dirname,'..'),out=path.join(root,'release');fs.mkdirSync(out,{recursive:true});
 const stage=fs.mkdtempSync(path.join(out,'mac-stage-'));
 for(const name of ['electron','renderer-dist','assets'])fs.cpSync(path.join(root,name),path.join(stage,name),{recursive:true});
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
 fs.writeFileSync(path.join(stage,'package.json'),JSON.stringify({name:pkg.name,version:pkg.version,main:pkg.main,author:pkg.author}));
 const appAsar=path.join(out,'mac-preview-app.asar');await asar.createPackage(stage,appAsar);
 const archive=path.join(out,'electron-v44.5.1-darwin-arm64.zip');
 const hash='1d75703019bb16461ae65f3081d7e6f5c0b11e901d0ccb5c343bcf7bcdd6435c';
 if(!fs.existsSync(archive)||crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')!==hash){
  console.log('Downloading official Electron 44.5.1 for Apple Silicon…');
  const response=await fetch('https://github.com/electron/electron/releases/download/v44.5.1/electron-v44.5.1-darwin-arm64.zip',{signal:AbortSignal.timeout(300000)});
  if(!response.ok)throw Error(`Electron download failed: ${response.status}`);
  const data=Buffer.from(await response.arrayBuffer());if(crypto.createHash('sha256').update(data).digest('hex')!==hash)throw Error('Electron SHA256 mismatch');fs.writeFileSync(archive,data);
 }
 const result=spawnSync(process.env.YVC_BUILD_PYTHON||'python',[path.join(__dirname,'package_mac_preview.py'),archive,appAsar],{cwd:root,stdio:'inherit',windowsHide:true});
 if(result.error)throw result.error;if(result.status!==0)throw Error('Mac preview packaging failed');
})().catch(e=>{console.error(e);process.exitCode=1});
