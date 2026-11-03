const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function modelName(file,alias=''){
 return alias.trim()||path.posix.basename(file.replace(/\\/g,'/'))||'未選択';
}
function key(item){return path.resolve(item.path).toLowerCase()+'#'+item.voice;}
function available(file){try{return fs.statSync(file,{throwIfNoEntry:false})?.isFile()||false;}catch{return false;}}
class ModelHistory{
 constructor(home){
  this.file=path.join(home,'model-history.json');this.items=[];
  try{
   const saved=JSON.parse(fs.readFileSync(this.file,'utf8'));
   if(Array.isArray(saved))this.items=saved.filter(item=>item&&typeof item.id==='string'&&typeof item.path==='string'&&
    Number.isInteger(item.voice)&&item.voice>=0&&item.voice<=65535).map(item=>({
     id:item.id,path:item.path,voice:item.voice,last_used:item.last_used,
     // Old labels included inferred names. Only the explicit alias field counts.
     alias:typeof item.alias==='string'?item.alias:'',icon:typeof item.icon==='string'&&/^[a-f0-9]{64}$/.test(item.icon)?item.icon:''
    }));
  }catch{}
 }
 list(){return this.items.map(item=>({...item,label:modelName(item.path,item.alias),available:available(item.path)}));}
 write(items){
  fs.mkdirSync(path.dirname(this.file),{recursive:true});
  const temporary=this.file+'.tmp';fs.writeFileSync(temporary,JSON.stringify(items,null,2));fs.renameSync(temporary,this.file);this.items=items;
 }
 edit(id,changes){
  if(!this.items.some(item=>item.id===id))throw Error('モデルが一覧に見つかりません。');
  this.write(this.items.map(item=>item.id===id?{...item,...changes,id:item.id,path:item.path,voice:item.voice}:item));
 }
 remove(id){
  const item=this.items.find(entry=>entry.id===id);
  if(!item)throw Error('モデルが一覧に見つかりません。');
  this.write(this.items.filter(entry=>entry.id!==id));return item;
 }
 remember(config){
  const file=config.beatrice_model;
  if(!file||!(/\.(pt(\.gz)?|toml|bin)$/i.test(file))||!available(file))return false;
  const item={path:path.resolve(file),voice:config.beatrice_voice,alias:config.beatrice_model_alias||'',icon:config.beatrice_model_icon||''};
  const previous=this.items.find(entry=>key(entry)===key(item));
  if(previous===this.items[0]&&previous?.alias===item.alias&&previous?.icon===item.icon)return false;
  const next=[{...item,id:previous?.id||crypto.randomUUID(),last_used:new Date().toISOString()},...this.items.filter(entry=>key(entry)!==key(item))];
  this.write(next);
  return true;
 }
 select(id){
  const item=this.list().find(entry=>entry.id===id);
  if(!item)throw Error('モデルの履歴が見つかりません。');
  if(!item.available)throw Error('モデルファイルが見つかりません。「モデル一覧」から追加し直してください。');
  return {beatrice_model:item.path,beatrice_voice:item.voice,beatrice_model_alias:item.alias,beatrice_model_icon:item.icon};
 }
}
module.exports={ModelHistory,modelName};
