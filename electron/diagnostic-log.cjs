const fs=require('node:fs');

const MAX_LOG_BYTES=2*1024*1024;
const MISSING_LOG='診断ログはまだありません。声変換を一度開始してから保存してください。';

// People post this file, so user folder names must not survive in any spelling.
function redactPaths(text,home){
 const escaped=home.split(/[\\/]+/).filter(Boolean).map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('[\\\\/]+');
 return text.replace(new RegExp(escaped,'gi'),'%USERPROFILE%')
  .replace(/([\\/]Users[\\/]+)[^\\/\s"':]+/gi,'$1<user>')
  .replace(/(\/home\/)[^/\s"':]+/g,'$1<user>');
}

function readNewest(file){
 const size=fs.statSync(file).size,start=Math.max(0,size-MAX_LOG_BYTES);
 const buffer=Buffer.alloc(size-start);
 const handle=fs.openSync(file,'r');
 try{fs.readSync(handle,buffer,0,buffer.length,start);}finally{fs.closeSync(handle);}
 if(!start)return {text:buffer.toString('utf8'),trimmed:false};
 const firstLine=buffer.indexOf(10);
 return {text:buffer.subarray(firstLine+1).toString('utf8'),trimmed:true};
}

function exportDiagnosticLog(logFile,outputFile,home,{version,electron,platform,release,arch,now=new Date()}){
 if(!fs.existsSync(logFile))throw Error(MISSING_LOG);
 const {text,trimmed}=readNewest(logFile);
 const header=[`YuiVoiceChanger ${version}`,`Electron ${electron}`,`${platform} ${release} ${arch}`,`保存日時 ${now.toLocaleString('ja-JP')}`,'',...(trimmed?['（古い部分を省略しました）']:[])].join('\n');
 fs.writeFileSync(outputFile,`${header}\n${redactPaths(text,home)}`,'utf8');
}

module.exports={exportDiagnosticLog,redactPaths,MAX_LOG_BYTES,MISSING_LOG};
