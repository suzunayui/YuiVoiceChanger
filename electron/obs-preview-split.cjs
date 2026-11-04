// Restore temporary OBS scenes created by version 2026.1104.19.
const fs=require('node:fs');
const path=require('node:path');
const {ObsVideoDelay}=require('./obs-video-delay.cjs');

const sceneIdentity=scene=>scene.uuid?{sceneUuid:scene.uuid}:{sceneName:scene.name};
async function waitFor(check){
 for(let attempt=0;attempt<40;attempt++){
  if(await check())return;
  await new Promise(resolve=>setTimeout(resolve,50));
 }
 throw Error('OBSのプレビュー切り替えを確認できませんでした。');
}

class ObsPreviewSplit{
 constructor(home){
  this.file=home?path.join(home,'obs-preview-split.json'):null;
  const delay=name=>new ObsVideoDelay(home,{file:home?path.join(home,`obs-preview-${name}.json`):null});
  this.rawDelay=delay('raw');this.programDelay=delay('program');
  if(this.file&&fs.existsSync(this.file)){
   try{
    const saved=JSON.parse(fs.readFileSync(this.file,'utf8'));
    if(saved.version!==1||!Number.isInteger(saved.port)||typeof saved.collection!=='string'||
       !saved.program?.uuid||!saved.sourceUuid||!Number.isInteger(saved.originalId)||
       !/^YUI 操作用 [a-f0-9-]{36}$/.test(saved.preview?.name)||
       !/^YUI 配信用 [a-f0-9-]{36}$/.test(saved.delayed?.name))throw Error('invalid recovery');
    this.record=saved;
   }catch{this.error='3Dプレビューの復元情報を読み込めません。';}
  }
 }
 get pending(){return !!(this.record||this.error||this.rawDelay.pending||this.programDelay.pending);}
 write(){
  if(!this.file)return;
  if(!this.record){fs.rmSync(this.file,{force:true});return;}
  fs.mkdirSync(path.dirname(this.file),{recursive:true});
  fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.record,null,2));
  fs.renameSync(this.file+'.tmp',this.file);
 }
 async collection(connection){return (await connection.request('GetSceneCollectionList')).currentSceneCollectionName;}
 async restore(connection){
  if(this.error)throw Error(this.error);
  const record=this.record;
  if(record){
   if(!connection?.identified||connection.port!==record.port||await this.collection(connection)!==record.collection)
    throw Error('3Dプレビューを戻すため、元のOBSとシーンコレクションに接続してください。');
   const live=await connection.request('GetCurrentProgramScene');
   if([record.preview,record.delayed].some(scene=>scene.name===live.currentProgramSceneName||scene.uuid&&scene.uuid===live.currentProgramSceneUuid))
    throw Error('OBSで元の配信シーンに切り替えると、3Dプレビューの設定を戻せます。');
   if(record.originalHidden||record.delayed.uuid){
    try{
     const {sceneItems}=await connection.request('GetSceneItemList',sceneIdentity(record.program));
     const item=sceneItems.find(x=>x.sceneItemId===record.originalId&&x.sourceUuid===record.sourceUuid);
     if(record.originalHidden&&item&&!item.sceneItemEnabled)await connection.request('SetSceneItemEnabled',{...sceneIdentity(record.program),sceneItemId:record.originalId,sceneItemEnabled:true});
     for(const replacement of sceneItems.filter(x=>x.sourceUuid===record.delayed.uuid))
      await connection.request('RemoveSceneItem',{...sceneIdentity(record.program),sceneItemId:replacement.sceneItemId});
    }catch(e){if(e.code!==600)throw e;}
   }
   const {studioModeEnabled}=await connection.request('GetStudioModeEnabled');
   if(studioModeEnabled&&(record.previewChanged||record.studioAttempted)){
    const preview=await connection.request('GetCurrentPreviewScene');
    if(preview.currentPreviewSceneName===record.preview.name||(record.preview.uuid&&preview.currentPreviewSceneUuid===record.preview.uuid)||(!record.complete&&record.studioAttempted)){
     if(!record.studioWasEnabled){
      await connection.request('SetStudioModeEnabled',{studioModeEnabled:false});
      await waitFor(async()=>!(await connection.request('GetStudioModeEnabled')).studioModeEnabled);
     }else if(record.previousPreview){
      await connection.request('SetCurrentPreviewScene',sceneIdentity(record.previousPreview)).catch(e=>{if(e.code!==600)throw e;});
     }
    }
   }
   for(const scene of [record.preview,record.delayed]){
    if(!scene.attempted)continue;
    try{await connection.request('RemoveScene',sceneIdentity(scene));}catch(e){if(e.code!==600)throw e;}
   }
   await waitFor(async()=>{
    const {scenes}=await connection.request('GetSceneList');
    return !scenes.some(item=>[record.preview,record.delayed].some(scene=>scene.uuid?item.sceneUuid===scene.uuid:item.sceneName===scene.name));
   });
  }
  await this.programDelay.restore(connection);
  await this.rawDelay.restore(connection);
  this.record=null;this.connection=null;this.write();
 }
}
module.exports={ObsPreviewSplit};
