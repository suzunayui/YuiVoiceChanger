const {app,BrowserWindow,ipcMain,dialog} = require('electron');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const os = require('node:os');
const ROOT = path.resolve(__dirname,'..');
const ENGINE_ROOT = app.isPackaged ? process.resourcesPath : ROOT;
// AppData can be virtualized when launched from a packaged host such as Codex.
// Keep settings outside AppData so Explorer and development launches share them.
const HOME = process.env.YVC_DESKTOP_HOME || path.join(os.homedir(),'.YuiVoiceChanger');
const LEGACY_CONFIG = path.join(process.env.LOCALAPPDATA || app.getPath('userData'),'YuiVoiceChanger','desktop.json');
const CONFIG = path.join(HOME,'desktop.json');
let window, worker, quitting=false;
function read(file,fallback={}) {try{return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch{return fallback;}}
function initialConfig(){
 return {beatrice_model:'',beatrice_vst:'',beatrice_pitch:12,beatrice_block:.04,beatrice_noise_filter:true,beatrice_gate:-50,python:'',beatrice_libs:'',input:-1,output:-1,input_name:'',output_name:'',gain:0};
}
const saved=read(!process.env.YVC_DESKTOP_HOME&&!fs.existsSync(CONFIG)?LEGACY_CONFIG:CONFIG);
let config=Object.fromEntries(Object.entries(initialConfig()).map(([key,value])=>[key,saved[key]??value]));
function send(event){if(window&&!window.isDestroyed())window.webContents.send('engine-event',event);}
function save(next){
  const allowed=Object.keys(initialConfig());
  const clean={};
  for(const key of allowed)if(Object.hasOwn(next,key))clean[key]=next[key];
  config={...config,...clean};
  fs.mkdirSync(HOME,{recursive:true});
  const tmp=CONFIG+'.tmp';fs.writeFileSync(tmp,JSON.stringify(config,null,2));fs.renameSync(tmp,CONFIG);
  return config;
}
function boot(){
  if(worker)return;
  if(!config.python||!fs.existsSync(config.python)){send({type:'error',message:'環境設定でPythonを指定してください。'});return;}
  const logs=path.join(HOME,'logs');fs.mkdirSync(logs,{recursive:true});
  const log=fs.createWriteStream(path.join(logs,'independent-engine.log'),{flags:'a'});
  worker=spawn(config.python,['-I','-u',path.join(ENGINE_ROOT,'backend','worker.py')],{
    cwd:ENGINE_ROOT,windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8',OMP_NUM_THREADS:'2',YVC_BEATRICE_LIBS:config.beatrice_libs||path.join(ROOT,'.local','beatrice-libs')},
    stdio:['pipe','pipe','pipe']});
  worker.stderr.pipe(log);
  readline.createInterface({input:worker.stdout}).on('line',line=>{
    try{const event=JSON.parse(line);send(event);if(event.type==='ready')request('devices');}
    catch{log.write(line+'\n');}
  });
  worker.on('error',e=>send({type:'error',message:e.message}));
  worker.on('exit',code=>{worker=null;log.end();send({type:'state',state:'stopped'});if(!quitting&&code)send({type:'error',message:`音声処理が終了しました (${code})。Python環境を確認してください。`});});
}
function request(command,payload={}){
  if(!worker||worker.stdin.destroyed)throw Error('音声プロセスが未起動です。環境設定から再接続してください。');
  worker.stdin.write(JSON.stringify({command,...payload})+'\n');
}
if(!app.requestSingleInstanceLock())app.quit();
else {
 app.on('second-instance',()=>{if(window){window.restore();window.focus();}});
 app.whenReady().then(()=>{
  window=new BrowserWindow({width:1280,height:720,minWidth:1000,minHeight:720,icon:path.join(ROOT,'assets','icon.ico'),title:'Yui Voice Changer',backgroundColor:'#f7f5f2',
   autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',event=>event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  ipcMain.handle('yvc',async(event,action,payload)=>{
   if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw Error('Unauthorized IPC');
   if(action==='config')return config;
   if(action==='save')return save(payload);
   if(action==='export-settings'){
    const result=await dialog.showSaveDialog(window,{defaultPath:'YuiVoiceChanger-settings.json',filters:[{name:'YuiVoiceChanger 設定',extensions:['json']}]});
    if(result.canceled||!result.filePath)return null;
    fs.writeFileSync(result.filePath,JSON.stringify(config,null,2),'utf8');return result.filePath;
   }
   if(action==='import-settings'){
    const result=await dialog.showOpenDialog(window,{properties:['openFile'],filters:[{name:'YuiVoiceChanger 設定',extensions:['json']}]});
    if(result.canceled)return null;
    const value=JSON.parse(fs.readFileSync(result.filePaths[0],'utf8').replace(/^\uFEFF/,''));
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('設定ファイルの形式が正しくありません。');
    const clean={};const defaults=initialConfig();
    const ranges={beatrice_pitch:[-24,24],beatrice_gate:[-70,-30],gain:[-24,30],input:[-1,65535],output:[-1,65535]};
    for(const key of Object.keys(defaults))if(Object.hasOwn(value,key)){
     const v=value[key];if(typeof v!==typeof defaults[key]||(typeof v==='number'&&!Number.isFinite(v)))throw Error(`設定値が正しくありません: ${key}`);
     if(ranges[key]&&(v<ranges[key][0]||v>ranges[key][1]))throw Error(`設定値が範囲外です: ${key}`);
     if(key==='beatrice_block'&&![.01,.02,.04].includes(v))throw Error('処理ブロックの値が正しくありません。');
     clean[key]=v;
    }
    if(!Object.keys(clean).length)throw Error('YuiVoiceChangerの設定が見つかりません。');
    return save(clean);
   }
   if(action==='pick'){
    if(!['python','beatrice_model','beatrice_vst'].includes(payload))throw Error('Invalid selection');
    const result=await dialog.showOpenDialog(window,{properties:['openFile'],filters:[{name:'File',extensions:payload==='beatrice_model'?['toml']:payload==='beatrice_vst'?['vst3']:['exe']}]});
    return result.canceled?null:result.filePaths[0];
   }
   if(action==='connect'){if(worker)throw Error('起動中です。アプリを再起動してください。');boot();return;}
   if(action==='devices'){if(!worker)boot();else request('devices');return;}
   if(action==='start'){save(payload);request('start',{config});return;}
   if(action==='stop'){request('stop');return;}
   throw Error('Unknown action');
  });
  window.loadFile(path.join(ROOT,'renderer-dist','index.html'));
  window.webContents.once('did-finish-load',()=>{boot();});
 });
 app.on('before-quit',event=>{

  if(worker&&!quitting){event.preventDefault();quitting=true;request('quit');
   const child=worker;child.once('exit',()=>app.exit(0));setTimeout(()=>{child.kill();app.exit(0);},12000).unref();}
 });
 app.on('window-all-closed',()=>app.quit());
}
