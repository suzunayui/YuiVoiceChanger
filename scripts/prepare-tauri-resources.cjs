// Gathers what the Tauri installer carries, the same set electron-builder's extraResources had on Windows.
const fs=require('fs'),path=require('path');
const root=path.join(__dirname,'..'),out=path.join(root,'src-tauri','resources');
const copy=(from,to=from)=>{const target=path.join(out,to);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(root,from),target);};
fs.rmSync(out,{recursive:true,force:true});
const wanted=name=>/\.(py|json)$/i.test(name)||/LICENSE.*\.txt$/i.test(name);
for(const entry of fs.readdirSync(path.join(root,'backend'),{recursive:true,withFileTypes:true})){
 if(!entry.isFile()||!wanted(entry.name))continue;
 const relative=path.relative(root,path.join(entry.parentPath,entry.name));
 if(!relative.split(path.sep).includes('__pycache__'))copy(relative);
}
copy('requirements.txt',path.join('backend','requirements.txt'));
for(const file of ['README.md','LICENSE','THIRD_PARTY_NOTICES.md',path.join('docs','beatrice.md')])copy(file);
fs.cpSync(path.join(root,'obs-plugin'),path.join(out,'obs-plugin'),{recursive:true});
