const fs=require('node:fs'),path=require('node:path');
function passwordStore(home,safeStorage){
 const file=path.join(home,'obs-password.bin');
 return {
  available:()=>safeStorage.isEncryptionAvailable(),
  load(){try{return safeStorage.isEncryptionAvailable()?safeStorage.decryptString(fs.readFileSync(file)):'';}catch{return ''; }},
  save(password,remember){
   if(!remember||!password){fs.rmSync(file,{force:true});return;}
   if(!safeStorage.isEncryptionAvailable())return;
   fs.mkdirSync(home,{recursive:true});
   const temporary=file+'.tmp';fs.writeFileSync(temporary,safeStorage.encryptString(password));fs.renameSync(temporary,file);
  }
 };
}
module.exports={passwordStore};
