const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {ObsVideoDelay,delayParts}=require('./obs-video-delay.cjs');
const keyOf=(port,input)=>JSON.stringify([port,input.inputUuid?'uuid:'+input.inputUuid:'name:'+input.inputName]);
class ObsVideoSources{
 constructor(home){
  this.home=home;this.directory=home?path.join(home,'obs-video-delays'):null;this.legacy=new ObsVideoDelay(home);this.items=new Map();
  if(this.directory)try{
   for(const name of fs.readdirSync(this.directory).filter(name=>/^[a-f0-9]{64}\.json$/.test(name))){
    const manager=new ObsVideoDelay(home,{file:path.join(this.directory,name)});
    if(manager.pending)this.items.set(manager.record?keyOf(manager.record.port,manager.record.input):name,manager);
   }
  }catch(error){if(error.code!=='ENOENT')this.legacy.loadError='映像同期の復元情報を読み込めませんでした。obs-video-delaysを確認してください。';}
 }
 get pending(){return this.legacy.pending||[...this.items.values()].some(item=>item.pending);}
 get record(){return this.legacy.record||[...this.items.values()].find(item=>item.record)?.record;}
 async restore(connection){
  const errors=[];
  for(const manager of [this.legacy,...this.items.values()])try{await manager.restore(connection);}catch(error){errors.push(error.message);}
  for(const [key,item] of this.items)if(!item.pending)this.items.delete(key);
  if(errors.length)throw Error(errors.join(' '));
 }
 async apply(connection,inputs,target,current){
  const desired=inputs.map(input=>({input,target,key:keyOf(connection.port,input)}));
  for(const item of desired)delayParts(item.target);
  if(this.legacy.pending)await this.legacy.restore(connection);
  for(const [key,manager] of this.items)if(!desired.some(item=>item.key===key)){await manager.restore(connection);this.items.delete(key);}
  for(const item of desired){
   if(!current())return false;
   let manager=this.items.get(item.key);
   if(!manager){
    const file=this.directory?path.join(this.directory,createHash('sha256').update(item.key).digest('hex')+'.json'):null;
    manager=new ObsVideoDelay(this.home,{file});this.items.set(item.key,manager);
   }
   try{if(!await manager.apply(connection,item.input,item.target,current))return false;}
   catch(error){throw Error(`OBSの映像「${item.input.inputName}」の遅延を設定できませんでした。${error.message}`);}
  }
  return true;
 }
}
module.exports={ObsVideoSources};
