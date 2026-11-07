// Gives the screen the same window.yvc under Tauri that Electron's preload gives it.
type Listener=(event:unknown)=>void;
type TauriGlobal={core:{invoke:(command:string,args?:unknown)=>Promise<unknown>};event:{listen:(name:string,handler:(event:{payload:unknown})=>void)=>Promise<unknown>}};
const tauri=(window as unknown as {__TAURI__?:TauriGlobal}).__TAURI__;
if(tauri){
 const listeners=new Set<Listener>();
 // Anything arriving before the screen subscribes waits for it, such as a problem found at startup.
 let waiting:unknown[]=[];
 void tauri.event.listen('engine-event',({payload})=>{
  if(!listeners.size)waiting.push(payload);
  for(const listener of [...listeners])listener(payload);
 }).then(()=>tauri.core.invoke('yvc_ready'));
 (window as unknown as {yvc:unknown}).yvc={
  platform:'win32',
  invoke:async(action:string,payload?:unknown)=>{
   try{return await tauri.core.invoke('yvc_invoke',{action,payload:payload===undefined?null:payload});}
   catch(error){throw error instanceof Error?error:new Error(String(error));}
  },
  subscribe:(callback:Listener)=>{
   listeners.add(callback);
   const queued=waiting;waiting=[];
   for(const event of queued)callback(event);
   return()=>{listeners.delete(callback);};
  },
 };
}
export {};
