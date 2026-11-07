const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
// The renderer saves soon after startup, so a broken file must be copied aside before defaults replace it.
function keepUnreadable(file,home){
 const stamp=new Date().toISOString().replace(/[-:]/g,'').replace('T','-').slice(0,15);
 const backup=path.join(home,`desktop.unreadable-${stamp}-${crypto.randomBytes(2).toString('hex')}.json`);
 fs.mkdirSync(home,{recursive:true});fs.copyFileSync(file,backup);
 return backup;
}
function unreadable(file,home,normalize,detail){
 let kept='';
 try{kept=`元のファイルは ${keepUnreadable(file,home)} に残しています。`;}catch{}
 return {saved:{},config:normalize({}),error:`設定ファイルを読み込めなかったため、初期設定で起動しました。${kept}（${detail}）`};
}
function loadConfig(file,home,normalize){
 let text;
 try{text=fs.readFileSync(file,'utf8');}
 catch(error){
  if(error.code==='ENOENT')return {saved:{},config:normalize({})};
  return unreadable(file,home,normalize,error.code||error.message);
 }
 try{const saved=JSON.parse(text.replace(/^﻿/,''));return {saved,config:normalize(saved)};}
 catch(error){return unreadable(file,home,normalize,error instanceof SyntaxError?'JSONの形式が正しくありません':error.message);}
}
module.exports={loadConfig};
