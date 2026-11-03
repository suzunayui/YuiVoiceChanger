const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {nativeImage}=require('electron');
function validId(id){return typeof id==='string'&&/^[a-f0-9]{64}$/.test(id);}
function storeIcon(home,file){
 if(!/\.(ico|png|jpe?g)$/i.test(file))throw Error('ICO・PNG・JPG画像を選んでください。');
 const stat=fs.statSync(file);
 if(!stat.isFile()||stat.size>20*1024*1024)throw Error('アイコン画像は20MB以下のファイルを選んでください。');
 const source=nativeImage.createFromPath(file);
 if(source.isEmpty())throw Error('画像を読み込めませんでした。別のICO・PNG・JPG画像を選んでください。');
 const size=source.getSize();
 const image=source.resize(size.width>=size.height?{width:128,quality:'best'}:{height:128,quality:'best'});
 const png=image.toPNG();const id=crypto.createHash('sha256').update(png).digest('hex');
 const directory=path.join(home,'model-icons');fs.mkdirSync(directory,{recursive:true});
 const target=path.join(directory,id+'.png');
 if(!fs.existsSync(target)){
  const temporary=target+'.tmp';fs.writeFileSync(temporary,png);fs.renameSync(temporary,target);
 }
 return id;
}
function readIcon(home,id){
 if(!id)return '';
 if(!validId(id))throw Error('アイコンの指定が不正です。');
 try{return 'data:image/png;base64,'+fs.readFileSync(path.join(home,'model-icons',id+'.png')).toString('base64');}
 catch{return '';}
}
module.exports={storeIcon,readIcon,validId};
