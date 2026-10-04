const path=require('node:path');
function engineRoot(root,resources,packaged){
 // The cross-built Mac preview still uses Electron's executable name, so
 // isPackaged alone cannot reliably identify an application inside app.asar.
 const archived=/(^|[\\/])[^\\/]+\.asar([\\/]|$)/i.test(root);
 return packaged||archived?resources:root;
}
module.exports={engineRoot};
