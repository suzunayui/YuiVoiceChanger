const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('yvc',{
 invoke:(action,payload)=>ipcRenderer.invoke('yvc',action,payload),
 subscribe:callback=>{const listener=(_event,data)=>callback(data);ipcRenderer.on('engine-event',listener);return ()=>ipcRenderer.removeListener('engine-event',listener);}
});
