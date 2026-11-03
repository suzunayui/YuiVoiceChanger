const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {normalize}=require('./config.cjs');
const {effectDefaults}=require('./singing-config.cjs');
const {obsDefaults}=require('./obs-config.cjs');
const keys=['beatrice_model','beatrice_voice','beatrice_model_alias','beatrice_model_icon','beatrice_pitch','beatrice_formant',
 'input','output','input_name','output_name','input_gain','gain','compute','singing_enabled','singing_latency_ms',
 ...Object.keys(effectDefaults),...Object.keys(obsDefaults)];
function snapshot(config){
 if(!config||typeof config!=='object'||Array.isArray(config))throw Error('保存する設定が正しくありません。');
 const clean=normalize({...config,engine_version:2});return Object.fromEntries(keys.map(key=>[key,clean[key]]));
}
function presetName(value){
 if(typeof value!=='string'||!value.trim()||value.trim().length>80||/[\x00-\x1f\x7f]/.test(value))throw Error('プリセット名を1〜80文字で入力してください。');
 return value.trim().normalize('NFC');
}
class Presets{
 constructor(home){
  this.file=path.join(home,'presets.json');this.items=[];this.active='';
  try{
   const data=JSON.parse(fs.readFileSync(this.file,'utf8'));
   if(data.version!==1||!Array.isArray(data.presets))throw Error('Invalid presets');
   const ids=new Set(),names=new Set();
   this.items=data.presets.map(item=>{
    if(!item||typeof item.id!=='string'||!item.id||ids.has(item.id))throw Error('Invalid preset');
    const name=presetName(item.name),key=name.toLocaleLowerCase();
    if(names.has(key))throw Error('Duplicate preset');ids.add(item.id);names.add(key);
    if(!item.settings||typeof item.settings!=='object'||Array.isArray(item.settings)||keys.some(key=>!Object.hasOwn(item.settings,key)))throw Error('Incomplete preset');
    return {id:item.id,name,settings:snapshot(item.settings)};
   });
   if(typeof data.active==='string'&&ids.has(data.active))this.active=data.active;
  }catch(error){if(error.code!=='ENOENT')this.error='プリセットファイルを読み込めませんでした。presets.jsonを確認してください。';}
 }
 check(){if(this.error)throw Error(this.error);}
 list(config){this.check();const current=config?snapshot(config):null;return this.items.map(({id,name,settings})=>({id,name,...(current?{active:this.active===id&&keys.every(key=>{
  if((key==='input'&&settings.input_name&&current.input_name)||(key==='output'&&settings.output_name&&current.output_name))return true;
  return settings[key]===current[key];
 })}:{})}));}
 get(id){this.check();const item=this.items.find(item=>item.id===id);if(!item)throw Error('プリセットが見つかりません。');return item;}
 write(items,active=this.active){
  this.check();fs.mkdirSync(path.dirname(this.file),{recursive:true});
  const tmp=this.file+'.tmp';fs.writeFileSync(tmp,JSON.stringify({version:1,presets:items,active:items.some(item=>item.id===active)?active:''},null,2));fs.renameSync(tmp,this.file);this.items=items;this.active=items.some(item=>item.id===active)?active:'';
 }
 save({id,name,config}){
  this.check();if(id)this.get(id);
  const cleanName=presetName(name);
  if(this.items.some(item=>item.id!==id&&item.name.toLocaleLowerCase()===cleanName.toLocaleLowerCase()))throw Error('同じ名前のプリセットがあります。別の名前を付けてください。');
  const item={id:id||randomUUID(),name:cleanName,settings:config===undefined?this.get(id).settings:snapshot(config)};
  this.write(id?this.items.map(previous=>previous.id===id?item:previous):[...this.items,item]);return item.id;
 }
 remove(id){this.get(id);this.write(this.items.filter(item=>item.id!==id));}
 markApplied(id){this.get(id);this.write(this.items,id);}
 apply(id,current,devices){
  const settings=snapshot(this.get(id).settings);
  if(settings.beatrice_model){
   let exists=false;try{exists=fs.statSync(settings.beatrice_model).isFile();}catch{}
   if(!exists)throw Error('プリセットのモデルファイルが見つかりません。モデルの保存先を確認してください。');
  }
  if(Array.isArray(devices))for(const [key,name,channel,label] of [['input','input_name','inputs','マイク'],['output','output_name','outputs','出力先']]){
   const match=devices.find(device=>device.host==='Windows WASAPI'&&device[channel]>0&&(settings[name]?device.name===settings[name]:device.id===settings[key]));
   if(!match&&(settings[name]||settings[key]!==-1))throw Error(`プリセットの${label}が見つかりません。デバイスを接続して音声デバイス一覧を更新してください。`);
   settings[key]=match?match.id:-1;if(match)settings[name]=match.name;
  }
  return normalize({...current,...settings});
 }
}
module.exports={Presets,snapshot,keys};
