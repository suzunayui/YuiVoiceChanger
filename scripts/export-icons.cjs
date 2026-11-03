// Run with Electron: npx electron scripts/export-icons.cjs
// Derive every platform icon from the approved, transparent PNG source.
const {app,nativeImage}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');

app.whenReady().then(async()=>{
 const source=nativeImage.createFromPath(path.join(root,'assets','icon.png'));
 const size=source.getSize();
 if(source.isEmpty()||size.width!==size.height||size.width<1024)throw Error('Expected a square icon.png of at least 1024 pixels.');
 const png=pixels=>source.resize({width:pixels,height:pixels,quality:'best'}).toPNG();
 const {default:pngToIco}=await import('png-to-ico');
 fs.writeFileSync(path.join(root,'assets','icon.ico'),await pngToIco([16,24,32,48,64,128,256].map(png)));
 const chunks=[['ic07',128],['ic08',256],['ic09',512],['ic10',1024]].map(([type,pixels])=>{
  const data=png(pixels),header=Buffer.alloc(8);
  header.write(type,0,'ascii');header.writeUInt32BE(data.length+8,4);
  return Buffer.concat([header,data]);
 });
 const header=Buffer.alloc(8);header.write('icns',0,'ascii');
 header.writeUInt32BE(8+chunks.reduce((sum,chunk)=>sum+chunk.length,0),4);
 fs.writeFileSync(path.join(root,'assets','icon.icns'),Buffer.concat([header,...chunks]));
 fs.copyFileSync(path.join(root,'assets','icon.png'),path.join(root,'public','icon.png'));
 console.log('Exported 7 Windows icon sizes, 4 macOS icon sizes, and public PNG.');
 app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
