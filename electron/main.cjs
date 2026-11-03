const {app,BrowserWindow,ipcMain,dialog,shell,safeStorage,systemPreferences} = require('electron');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const os = require('node:os');
const {EventEmitter}=require('node:events');
const {normalize,liveControls} = require('./config.cjs');
const {ModelHistory} = require('./model-history.cjs');
const ROOT = path.resolve(__dirname,'..');
const ENGINE_ROOT = require('./paths.cjs').engineRoot(ROOT,process.resourcesPath,app.isPackaged);
const HOME = process.env.YVC_DESKTOP_HOME || path.join(os.homedir(),'.YuiVoiceChanger');
if(process.env.YVC_DESKTOP_HOME)app.setPath('userData',path.join(HOME,'electron-profile'));
const CONFIG = path.join(HOME,'desktop.json');
const LEGACY_CONFIG = path.join(process.env.LOCALAPPDATA || app.getPath('userData'),'YuiVoiceChanger','desktop.json');
let window,worker,workerPython,connecting,quitting=false,settingUp=false;
let engineState='stopped',startToken=0;
let presetSwitching=false,presetAbort;
const engineEvents=new EventEmitter();
const workerStops=new WeakMap();
let officialAbort=null,officialTask=null;
let iconDirectory,audioDevices;
let lastMetrics={};
const training=new (require('./training.cjs').TrainingManager)(HOME,ENGINE_ROOT,send);
function read(file) {try{return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch{return {};}}
function pickerDirectory(value){
 if(typeof value!=='string'||!value.trim())return undefined;
 let directory=path.resolve(value);
 while(true){
  try{if(fs.statSync(directory).isDirectory())return directory;}catch{}
  const parent=path.dirname(directory);
  if(parent===directory)return undefined;
  directory=parent;
 }
}
const source=!process.env.YVC_DESKTOP_HOME&&!fs.existsSync(CONFIG)?LEGACY_CONFIG:CONFIG;
const saved=read(source);
const modelHistory=new ModelHistory(HOME);
const presets=new (require('./presets.cjs').Presets)(HOME);
const obs=new (require('./obs-link.cjs').ObsLink)({notify:send,credentials:require('./obs-password.cjs').passwordStore(HOME,safeStorage)});
let config,configError;
try {config=normalize(saved);} catch(e) {config=normalize({});configError=e.message;}
const calibration=new (require('./latency-calibration.cjs').LatencyCalibration)({engineRoot:ENGINE_ROOT,notify:send,beforeStart:async()=>{if(connecting)await connecting;await stopWorker();},onComplete:result=>save({...config,singing_enabled:true,singing_latency_ms:result.recommended_ms})});
const obsSync=new (require('./obs-sync.cjs').ObsSync)({home:HOME,engineRoot:ENGINE_ROOT,obs,notify:send,isRunning:()=>engineState==='running',getMetrics:()=>lastMetrics,
 prepareEngine:async(next,signal)=>{
  const abort=()=>{void stopWorker();};signal.addEventListener('abort',abort,{once:true});
  try{
   if(engineState==='running'&&next.singing_enabled!==config.singing_enabled)await stopPresetEngine(true,signal);
   if(signal.aborted||quitting)throw Error('測定を中止しました。');
   save(next,{obsSyncPreparation:true});send({type:'obs-sync',...obsSync.status(),config});
   if(engineState!=='running'){
    obsSync.update({message:'声変換を起動しています…'});
    await startPresetEngine(signal,'OBSの同期測定');
   }
  }catch(error){
   if(signal.aborted||engineState==='loading'){await stopWorker();send({type:'state',state:'stopped'});}
   throw error;
  }finally{signal.removeEventListener('abort',abort);}
 },onComplete:result=>{if(engineState!=='running')throw Error('声変換が停止したため補正を保存しません。');return save({...config,obs_correction_ms:result.correction_ms});}});
if(saved.engine_version!==2&&Object.keys(saved).length&&fs.existsSync(source)){
 fs.mkdirSync(HOME,{recursive:true});
 const backup=path.join(HOME,'desktop-before-direct-gpu.json');
 if(!fs.existsSync(backup))fs.copyFileSync(source,backup);
}
function send(event){
 if(event.type==='metrics')lastMetrics=event;
 if(event.type==='devices')audioDevices=event.devices;
 if(event.type==='state'){engineState=event.state;obs.configure(config,engineState==='running');}
 if(window&&!window.isDestroyed())window.webContents.send('engine-event',event);
 engineEvents.emit('event',event);
}
function publishPresets(){try{send({type:'presets',items:presets.list(config)});}catch{}}
function save(next,{preset=false,obsSyncPreparation=false}={}){
 const clean=normalize(next);
 if(calibration.busy&&Object.keys(clean).some(key=>clean[key]!==config[key]))throw Error('自動設定の測定が終わるまでお待ちください。');
 if(obsSync.busy&&!obsSyncPreparation&&Object.keys(clean).some(key=>clean[key]!==config[key]))throw Error('OBSの同期測定が終わるまでお待ちください。');
 if(!preset&&engineState!=='stopped'&&require('./obs-config.cjs').obsConnectionKeys.some(key=>config[key]!==clean[key]))throw Error('変換を停止してからOBSのポート・伴奏ソースを変更してください。');
 const controls=liveControls(config,clean,engineState);
 if(controls){
  const keys=Object.keys(require('./singing-config.cjs').effectDefaults);
  const effects=keys.some(key=>config[key]!==clean[key])?Object.fromEntries(keys.map(key=>[key,clean[key]])):undefined;
  request('update-controls',{controls,...(effects?{effects}:{})});
 }
 config=clean;
 obs.configure(config,engineState==='running');
 fs.mkdirSync(HOME,{recursive:true});
 const tmp=CONFIG+'.tmp';fs.writeFileSync(tmp,JSON.stringify(config,null,2));fs.renameSync(tmp,CONFIG);
 if(modelHistory.remember(config))send({type:'model-history',models:modelHistory.list()});
 publishPresets();
 return config;
}
async function startPresetEngine(signal,label='プリセットの切り替え'){
 if(signal.aborted||quitting)throw Error(`${label}を中止しました。`);
 await microphonePermission();
 if(signal.aborted||quitting)throw Error(`${label}を中止しました。`);
 send({type:'state',state:'loading'});await boot();
 if(signal.aborted||quitting)throw Error(`${label}を中止しました。`);
 await new Promise((resolve,reject)=>{
  let detail='';
  const finish=error=>{clearTimeout(timer);engineEvents.off('event',listener);signal.removeEventListener('abort',cancel);error?reject(error):resolve();};
  const listener=event=>{
   if(event.type==='error')detail=event.message;
   if(event.type==='state'&&event.state==='running')finish();
   if(event.type==='state'&&event.state==='stopped')finish(Error(detail||'音声変換を開始できませんでした。'));
  };
  const cancel=()=>finish(Error(`${label}を中止しました。`));
  const timer=setTimeout(()=>finish(Error(`${label}の読み込みが時間切れになりました。`)),120000);
  engineEvents.on('event',listener);signal.addEventListener('abort',cancel,{once:true});
  try{request('start',{config});}catch(error){finish(error);}
 });
}
async function stopPresetEngine(reuseWorker,signal){
 if(!reuseWorker||!worker)return stopWorker();
 if(engineState==='stopped')return;
 try{
  await new Promise((resolve,reject)=>{
   const finish=error=>{clearTimeout(timer);engineEvents.off('event',listener);signal.removeEventListener('abort',cancel);error?reject(error):resolve();};
   const listener=event=>{if(event.type==='state'&&event.state==='stopped')finish();};
   const cancel=()=>finish(Error('プリセットの切り替えを中止しました。'));
   const timer=setTimeout(()=>finish(Error('音声の停止が時間切れになりました。')),20000);
   engineEvents.on('event',listener);signal.addEventListener('abort',cancel,{once:true});
   if(signal.aborted){cancel();return;}
   try{request('stop');}catch(error){finish(error);}
  });
 }catch(error){await stopWorker();throw error;}
}
async function applyPreset(id){
 if(settingUp||training.busy||calibration.busy||presetSwitching||!['stopped','running'].includes(engineState))throw Error('準備・停止・学習・自動設定が終わってからプリセットを適用してください。');
 const previous={...config},next=presets.apply(id,config,audioDevices);
 let restart=false;
 if(engineState==='running'){
  if(!next.beatrice_model||next.input<0||next.output<0)throw Error('モデル・マイク・出力先を選択したプリセットを使用してください。');
  try{liveControls(config,next,'running');}catch{restart=true;}
 }
 if(!restart){save(next,{preset:true});presets.markApplied(id);publishPresets();return config;}
 const reuseWorker=['python','compute','beatrice_voice'].every(key=>previous[key]===next[key])&&path.resolve(previous.beatrice_model).toLowerCase()===path.resolve(next.beatrice_model).toLowerCase();
 presetSwitching=true;presetAbort=new AbortController();const signal=presetAbort.signal;
 send({type:'preset-switch',busy:true});
 try{
  send({type:'state',state:'stopping'});await stopPresetEngine(reuseWorker,signal);
  if(signal.aborted||quitting)throw Error('プリセットの切り替えを中止しました。');
  save(next);send({type:'preset-config',config});
  await startPresetEngine(signal);
  presets.markApplied(id);publishPresets();return config;
 }catch(error){
  // An explicit Stop or quit never restarts either voice.
  if(signal.aborted||quitting)throw error;
  await stopPresetEngine(reuseWorker,signal).catch(()=>{});send({type:'state',state:'stopped'});
  save(previous);send({type:'preset-config',config});
  if(signal.aborted||quitting)throw error;
  try{await startPresetEngine(signal);}catch(restoreError){
   await stopPresetEngine(reuseWorker,signal).catch(()=>{});send({type:'state',state:'stopped'});
   if(signal.aborted||quitting)throw Error('プリセットの切り替えを中止しました。');
   throw Error(`プリセットを切り替えられませんでした。元の設定へ戻しましたが、変換を再開できませんでした。${error.message} ${restoreError.message}`);
  }
  throw Error(`プリセットを切り替えられませんでした。元の設定で変換を再開しました。${error.message}`);
 }finally{presetSwitching=false;presetAbort=null;send({type:'preset-switch',busy:false});}
}
async function stopWorker(){
 if(!worker)return;
 const child=worker;
 if(workerStops.has(child))return workerStops.get(child);
 const pending=new Promise((resolve)=>{
  const timer=setTimeout(()=>child.kill(),20000);
  child.once('exit',()=>{clearTimeout(timer);resolve();});
  if(child.stdin.writable&&!child.stdin.destroyed)child.stdin.write(JSON.stringify({command:'quit'})+'\n');else child.kill();
 });
 workerStops.set(child,pending);try{await pending;}finally{workerStops.delete(child);}
}
async function microphonePermission(){
 if(process.platform==='darwin'&&systemPreferences.getMediaAccessStatus('microphone')!=='granted'&&!await systemPreferences.askForMediaAccess('microphone'))throw Error('システム設定の「プライバシーとセキュリティ → マイク」でYuiVoiceChangerを許可してください。');
}
async function boot(){
 if(connecting)return connecting;
 if(worker&&workerPython===config.python)return;
 if(!config.python)throw Error('必要な環境を自動セットアップしてください。');
 connecting=(async()=>{
  await stopWorker();
  if(!fs.existsSync(config.python)||!fs.statSync(config.python).isFile())throw Error('環境設定でPython実行ファイルを指定してください。');
  if(!fs.existsSync(path.join(ENGINE_ROOT,'backend','worker.py')))throw Error('音声処理ファイルが見つかりません。アプリをすべて展開してください。');
  const logs=path.join(HOME,'logs');fs.mkdirSync(logs,{recursive:true});
  const log=fs.createWriteStream(path.join(logs,'independent-engine.log'),{flags:'a'});
  workerPython=config.python;
  const child=spawn(config.python,['-I','-u',path.join(ENGINE_ROOT,'backend','worker.py')],{
   cwd:ENGINE_ROOT,windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8',OMP_NUM_THREADS:'2'},stdio:['pipe','pipe','pipe']});
  worker=child;child.stderr.pipe(log);
  await new Promise((resolve,reject)=>{
   let ready=false;
   const timer=setTimeout(()=>{child.kill();reject(Error('Pythonの起動が時間切れになりました。環境を確認してください。'));},30000);
   readline.createInterface({input:child.stdout}).on('line',line=>{
    let event;
    try{event=JSON.parse(line);}catch{log.write(line+'\n');return;}
    send(event);
    if(event.type==='ready'){ready=true;clearTimeout(timer);resolve();}
   });
   child.on('error',e=>{clearTimeout(timer);reject(Error(`Pythonを起動できません (${e.code||e.message}): ${workerPython}`));});
   child.on('exit',code=>{
    clearTimeout(timer);if(worker===child)worker=null;log.end();
    if(!connecting)send({type:'state',state:'stopped'});
    if(!ready)reject(Error('Python環境を起動できませんでした。Python 3.15の環境をセットアップしてください。'));
    else if(!quitting&&code)send({type:'error',message:`音声処理が終了しました (${code})。環境を確認してください。`});
   });
  });
 })();
 try{await connecting;}finally{connecting=null;}
}
function request(command,payload={}){
 if(!worker||!worker.stdin.writable)throw Error('音声プロセスが未起動です。環境をセットアップしてください。');
 worker.stdin.write(JSON.stringify({command,...payload})+'\n');
}
if(!app.requestSingleInstanceLock())app.quit();
else {
 app.on('second-instance',()=>{if(window){window.restore();window.focus();}});
 app.whenReady().then(()=>{
  window=new BrowserWindow({width:1280,height:600,minWidth:1000,minHeight:560,icon:path.join(ROOT,'assets','icon.ico'),title:`Yui Voice Changer — ${app.getVersion()}`,backgroundColor:'#f7f5f2',
   autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  window.on('page-title-updated',event=>event.preventDefault());
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',event=>event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  ipcMain.handle('yvc',async(event,action,payload)=>{
   if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw Error('Unauthorized IPC');
   if(obsSync.busy&&!['config','obs-sync-status','obs-sync-cancel','obs-status','presets','model-icon','read-help','open-help-link','training-status','latency-calibration-status','stop'].includes(action))throw Error('OBSの同期測定が終わるまでお待ちください。');
   if(presetSwitching&&!['config','presets','model-icon','read-help','open-help-link','training-status','latency-calibration-status','obs-status','obs-sync-status','obs-sync-info','stop'].includes(action))throw Error('プリセットを切り替えています。完了までお待ちください。');
   if(action==='config')return config;
   if(action==='obs-sync-status')return obsSync.status();
   if(action==='obs-sync-info')return obsSync.info();
   if(action==='obs-sync-start'){
    if(settingUp||training.busy||calibration.busy||presetSwitching||!['stopped','running'].includes(engineState))throw Error('準備・停止・学習・自動設定が終わるまでお待ちください。');
    if(!payload||typeof payload!=='object')throw Error('測定する声ソースを選んでください。');
    const next=normalize({...payload.config,singing_enabled:true,obs_enabled:true});
    if(!next.python||!next.beatrice_model||next.input<0||next.output<0)throw Error('モデル・マイク・出力先と変換環境を設定してください。');
    obsSync.validateStart(next,payload,{requireRunning:false});
    return obsSync.start(next,payload,{prepare:true});
   }
   if(action==='obs-sync-cancel')return obsSync.cancel();
   if(action==='obs-sync-recover')return obsSync.recover();
   if(action==='obs-sync-pick-ffmpeg'){
    const picked=await dialog.showOpenDialog(window,{properties:['openFile'],filters:process.platform==='darwin'?undefined:[{name:'ffmpeg.exe',extensions:['exe']}]});
    return picked.canceled?obsSync.info():obsSync.setFfmpeg(picked.filePaths[0]);
   }
   if(action==='presets')return presets.list(config);
   if(action==='save-preset'){
    if(!payload||typeof payload!=='object'||Array.isArray(payload))throw Error('プリセットの指定が正しくありません。');
    const id=presets.save(payload);publishPresets();return {id,items:presets.list(config)};
   }
   if(action==='remove-preset'){presets.remove(payload);publishPresets();return presets.list(config);}
   if(action==='apply-preset')return applyPreset(payload);
   if(action==='latency-calibration-status')return calibration.status();
   if(action==='latency-calibration-start'){
    if(settingUp||training.busy||engineState!=='stopped'||calibration.busy)throw Error('変換・セットアップ・学習を停止してから自動設定してください。');
    await microphonePermission();
    save(payload);return calibration.start(config);
   }
   if(action==='latency-calibration-cancel')return calibration.cancel();
   if(action==='obs-status')return obs.status();
   if(action==='obs-connect'){
    if(!payload||typeof payload!=='object'||!Number.isInteger(payload.port)||payload.port<1||payload.port>65535||typeof payload.password!=='string'||payload.password.length>1024||typeof payload.remember!=='boolean')throw Error('OBSの接続設定が正しくありません。');
    save({...config,obs_port:payload.port});
    return obs.connect(payload);
   }
   if(action==='obs-refresh')return obs.refresh();
   if(action==='obs-disconnect'){save({...config,obs_enabled:false});return obs.disconnect();}
   if(action==='model-history'){modelHistory.remember(config);return modelHistory.list();}
   if(['add-library-model','edit-library-model','remove-library-model','pick-library-icon'].includes(action)){
    const check=()=>{if(settingUp||training.busy||calibration.busy||engineState!=='stopped')throw Error('変換や学習を停止してからモデル一覧を変更してください。');};
    check();
    const publish=()=>{const models=modelHistory.list();send({type:'model-history',models});return models;};
    if(action==='add-library-model'){
     const result=await dialog.showOpenDialog(window,{defaultPath:pickerDirectory(config.beatrice_model),properties:['openFile'],filters:[{name:'音声モデル',extensions:['gz','pt','toml','bin','pth','onnx']}]});
     if(result.canceled||!result.filePaths.length)return null;
     let file=result.filePaths[0];check();
     if(/\.(pth|onnx)$/i.test(file))return {training_source:file};
     if(config.python){const info=await training.inspect(config.python,file);if(info.train_required)return {training_source:info.path};file=info.path;}
     check();
     const previous=modelHistory.list().find(item=>path.resolve(item.path).toLowerCase()===path.resolve(file).toLowerCase()&&item.voice===0);
     modelHistory.remember({beatrice_model:file,beatrice_voice:0,beatrice_model_alias:previous?.alias||'',beatrice_model_icon:previous?.icon||''});
     const models=publish();const id=models.find(item=>path.resolve(item.path).toLowerCase()===path.resolve(file).toLowerCase()&&item.voice===0)?.id;
     if(!id)throw Error('Beatriceの.pt.gz・.pt・.toml・.binを選んでください。');
     return {models,id};
    }
    const item=modelHistory.list().find(entry=>entry.id===payload?.id);
    if(!item)throw Error('モデルが一覧に見つかりません。');
    const current=path.resolve(item.path).toLowerCase()===path.resolve(config.beatrice_model||'.').toLowerCase()&&item.voice===config.beatrice_voice;
    if(action==='pick-library-icon'){
     const result=await dialog.showOpenDialog(window,{defaultPath:iconDirectory||app.getPath('pictures'),properties:['openFile'],filters:[{name:'アイコン画像',extensions:['ico','png','jpg','jpeg']}]});
     if(result.canceled||!result.filePaths.length)return null;check();
     const icon=require('./model-icons.cjs').storeIcon(HOME,result.filePaths[0]);iconDirectory=path.dirname(result.filePaths[0]);
     return {icon,data:require('./model-icons.cjs').readIcon(HOME,icon)};
    }
    if(action==='edit-library-model'){
     const clean=normalize({beatrice_model_alias:payload.alias,beatrice_model_icon:payload.icon});
     modelHistory.edit(item.id,{alias:clean.beatrice_model_alias.trim(),icon:clean.beatrice_model_icon});
     if(current)save({...config,beatrice_model_alias:clean.beatrice_model_alias.trim(),beatrice_model_icon:clean.beatrice_model_icon});
    }else{
     modelHistory.remove(item.id);
     if(current)save({...config,beatrice_model:'',beatrice_voice:0,beatrice_model_alias:'',beatrice_model_icon:''});
    }
    return {models:publish(),config};
   }
   if(action==='model-icon')return require('./model-icons.cjs').readIcon(HOME,payload);
   if(action==='pick-model-icon'||action==='clear-model-icon'){
    const checkSelection=()=>{
     if(settingUp||training.busy||calibration.busy||engineState!=='stopped')throw Error('変換や学習を停止してからアイコンを変更してください。');
     if(!config.beatrice_model||typeof payload?.path!=='string'||path.resolve(payload.path).toLowerCase()!==path.resolve(config.beatrice_model).toLowerCase()||payload.voice!==config.beatrice_voice)throw Error('モデルが切り替わりました。もう一度アイコンを設定してください。');
    };
    checkSelection();
    if(action==='clear-model-icon')return save({...config,beatrice_model_icon:''});
    const result=await dialog.showOpenDialog(window,{defaultPath:iconDirectory||app.getPath('pictures'),properties:['openFile'],filters:[{name:'アイコン画像',extensions:['ico','png','jpg','jpeg']}]});
    if(result.canceled||!result.filePaths.length)return null;
    checkSelection();
    const icon=require('./model-icons.cjs').storeIcon(HOME,result.filePaths[0]);
    iconDirectory=path.dirname(result.filePaths[0]);
    return save({...config,beatrice_model_icon:icon});
   }
   if(action==='rename-model'){
    if(settingUp||training.busy||calibration.busy||engineState!=='stopped')throw Error('変換や学習を停止してから別名を変更してください。');
    if(!config.beatrice_model||typeof payload?.path!=='string'||path.resolve(payload.path).toLowerCase()!==path.resolve(config.beatrice_model).toLowerCase()||payload.voice!==config.beatrice_voice)throw Error('モデルが切り替わりました。もう一度別名を設定してください。');
    if(typeof payload.alias!=='string')throw Error('別名を入力してください。');
    return save({...config,beatrice_model_alias:payload.alias.trim()});
   }
   if(action==='select-model-history'){
    if(settingUp||training.busy||calibration.busy||engineState!=='stopped')throw Error('変換や学習を停止してからモデルを切り替えてください。');
    const selected=modelHistory.select(payload);
    if(config.python){
     const info=await training.inspect(config.python,selected.beatrice_model);
     if(info.train_required)throw Error('このモデルは学習が必要です。モデルを選び直してください。');
    }
    // Recheck the file and engine state after asynchronous inspection.
    if(settingUp||training.busy||calibration.busy||engineState!=='stopped')throw Error('変換や学習を停止してからモデルを切り替えてください。');
    modelHistory.select(payload);
    return save({...config,...selected});
   }
   if(action==='read-help'){
    const docs=app.isPackaged?process.resourcesPath:ROOT;
    const files={readme:path.join(docs,'README.md'),beatrice:path.join(docs,'docs','beatrice.md'),mac:path.join(docs,'docs','mac-preview.md'),license:path.join(ROOT,'LICENSE'),notices:path.join(ROOT,'THIRD_PARTY_NOTICES.md')};
    if(typeof payload!=='string'||!Object.hasOwn(files,payload))throw Error('Unknown help document');
    return fs.readFileSync(files[payload],'utf8');
   }
   if(action==='open-help-link'){
    if(typeof payload!=='string')throw Error('Invalid help link');
    const url=new URL(payload);
    if(url.protocol!=='https:'||url.username||url.password)throw Error('Invalid help link');
    await shell.openExternal(url.href);return;
   }
   if(action==='save')return save(payload);
   if(action==='inspect-model')return training.inspect(config.python,payload);
   if(action==='gpu-info')return training.tool(config.python,'gpu');
   if(action==='compute-devices')return require('./compute-devices.cjs').computeDevices(config.python,training.tool.bind(training));
   if(action==='training-status')return training.status();
   if(action==='training-start'){
    if(settingUp||calibration.busy||engineState!=='stopped')throw Error('声変換を停止してから学習してください。');
    save(payload);return training.start(config);
   }
   if(action==='training-resume'){
    if(settingUp||calibration.busy||engineState!=='stopped')throw Error('声変換を停止してから学習してください。');
    return training.start(config,{resume:true});
   }
   if(action==='training-cancel')return training.cancel();
   if(action==='use-trained-model'){
    const state=training.status();
    if(state.busy||!state.model||!fs.existsSync(state.model))throw Error('使用できる学習モデルがありません。');
    return save({...config,beatrice_model:state.model,beatrice_voice:0,beatrice_model_alias:'',beatrice_model_icon:''});
   }
   if(action==='install-tsukuyomi'){
    if(payload?.agreed!==true)throw Error('公式モデルの利用規約への同意が必要です。');
    if(settingUp||training.busy||calibration.busy||engineState!=='stopped')throw Error('変換と学習を停止してから導入してください。');
    settingUp=true;officialAbort=new AbortController();
    try{
     officialTask=require('./official-model.cjs').installOfficial(HOME,{
      agreed:true,signal:officialAbort.signal,
      progress:message=>send({type:'official-model-progress',message})
     });
     const selected=await officialTask;
     const previous=modelHistory.list().find(item=>path.resolve(item.path).toLowerCase()===path.resolve(selected.beatrice_model).toLowerCase()&&item.voice===selected.beatrice_voice);
     const icon=previous?.icon||require('./model-icons.cjs').storeIcon(HOME,path.join(path.dirname(selected.beatrice_model),'tsukuyomichan.png'));
     const alias=previous?.alias||'つくよみちゃん';
     modelHistory.remember({...selected,beatrice_model_alias:alias,beatrice_model_icon:icon});
     if(config.beatrice_model&&path.resolve(config.beatrice_model).toLowerCase()===path.resolve(selected.beatrice_model).toLowerCase()&&config.beatrice_voice===selected.beatrice_voice)save({...config,beatrice_model_alias:alias,beatrice_model_icon:icon});
     const models=modelHistory.list();send({type:'model-history',models});
     const id=models.find(item=>path.resolve(item.path).toLowerCase()===path.resolve(selected.beatrice_model).toLowerCase()&&item.voice===selected.beatrice_voice)?.id;
     return {models,id,config};
    }finally{officialTask=null;officialAbort=null;settingUp=false;}
   }
   if(action==='cancel-official-model'){officialAbort?.abort();return;}
   if(action==='setup-runtime'){
    if(settingUp||training.busy||calibration.busy||engineState!=='stopped')throw Error('変換と学習を停止してからセットアップしてください。');
    settingUp=true;
    try{
     await stopWorker();
     const next=await require('./setup.cjs').setup(HOME,message=>send({type:'setup',message}));
     save({...config,...next});await boot();request('devices');return config;
    }finally{settingUp=false;}
   }
   if(action==='open-resource'){
    const links={models:'https://github.com/fierce-cats/beatrice-trainer',python:'https://www.python.org/downloads/',cable:'https://vb-audio.com/Cable/',tsukuyomi_terms:require('./official-model.cjs').TERMS_URL};
    if(!Object.hasOwn(links,payload))throw Error('Unknown resource');
    await shell.openExternal(links[payload]);return;
   }
   if(action==='export-settings'){
    const result=await dialog.showSaveDialog(window,{defaultPath:'YuiVoiceChanger-settings.json',filters:[{name:'YuiVoiceChanger 設定',extensions:['json']}]});
    if(result.canceled||!result.filePath)return null;
    fs.writeFileSync(result.filePath,JSON.stringify(config,null,2),'utf8');return result.filePath;
   }
   if(action==='import-settings'){
    if(calibration.busy||engineState!=='stopped')throw Error('変換や自動設定を停止してください。');
    const result=await dialog.showOpenDialog(window,{properties:['openFile'],filters:[{name:'YuiVoiceChanger 設定',extensions:['json']}]});
    if(result.canceled)return null;
    const value=JSON.parse(fs.readFileSync(result.filePaths[0],'utf8').replace(/^\uFEFF/,''));
    return save(normalize(value,{importing:true}));
   }
   if(action==='pick'){
    if(payload==='training_audio'){
     const result=await dialog.showOpenDialog(window,{defaultPath:pickerDirectory(config.training_audio),properties:['openDirectory']});return result.canceled?null:result.filePaths[0];
    }
    if(!['python','beatrice_model','training_source'].includes(payload))throw Error('Invalid selection');
    const result=await dialog.showOpenDialog(window,{defaultPath:pickerDirectory(config[payload]),properties:['openFile'],filters:payload==='python'&&process.platform==='darwin'?undefined:[{name:payload==='python'?'Python':'音声モデル',extensions:payload==='python'?['exe']:['gz','pt','toml','bin','pth','onnx']}]});
    return result.canceled?null:result.filePaths[0];
   }
   if(action==='devices'||action==='connect'){
    if(settingUp||!config.python)return;
    await boot();request('devices');return;
   }
   if(action==='start'){
    if(settingUp||training.busy||calibration.busy)throw Error('セットアップ・学習・自動設定が終わるまでお待ちください。');
    if(engineState!=='stopped')throw Error('すでに起動中です。');
    save(payload);
    const token=++startToken;
    send({type:'state',state:'loading'});
    try{
     await microphonePermission();
     if(token!==startToken||quitting)return;
     await boot();
     if(token!==startToken||quitting)return;
     request('start',{config});return;
    }catch(e){send({type:'state',state:'stopped'});throw e;}
   }
   if(action==='stop'){
    if(obsSync.busy)obsSync.cancel();
    ++startToken;
    if(presetSwitching){presetAbort?.abort();await stopWorker();send({type:'state',state:'stopped'});return;}
    if(connecting){send({type:'state',state:'stopped'});return;}
    request('stop');return;
   }
   throw Error('Unknown action');
  });
  window.loadFile(path.join(ROOT,'renderer-dist','index.html'));
  window.webContents.once('did-finish-load',()=>{if(configError)send({type:'error',message:configError});obs.configure(config,false);});
 });
 app.on('before-quit',event=>{
  officialAbort?.abort();
  presetAbort?.abort();
  if(!quitting){event.preventDefault();quitting=true;Promise.allSettled([stopWorker(),training.shutdown(),officialTask,calibration.shutdown(),obsSync.shutdown()]).then(()=>obs.shutdown()).catch(()=>{}).finally(()=>app.exit(0));}
 });
 app.on('window-all-closed',()=>app.quit());
}
