const {WebSocketServer}=require('ws');
const {createHash}=require('node:crypto');
const net=require('node:net'),readline=require('node:readline');
const hash=value=>createHash('sha256').update(value).digest('base64');
class ObsServer{
 constructor({password='fixture-password',auth=true,port=0,pipe}={}){
  this.password=password;this.auth=auth;this.records=[];this.connections=0;this.ignore='';this.delayGet=0;
  this.inputs=[{inputName:'デスクトップ音声',inputUuid:'desktop',offset:23},{inputName:'伴奏ブラウザー',inputUuid:'music',offset:35},{inputName:'変換音声',inputUuid:'voice',offset:0},{inputName:'映像のみ',inputUuid:'video',noAudio:true}];
  this.filters=new Map([['video',[]]]);
  this.server=pipe?net.createServer():new WebSocketServer({host:'127.0.0.1',port});
  if(pipe)this.server.clients=new Set();
  this.ready=new Promise((resolve,reject)=>{
   this.server.once('error',reject);
   this.server.once('listening',()=>{this.port=pipe?4455:this.server.address().port;resolve(this);});
  });
  this.server.on('connection',socket=>{
   if(pipe){
    this.server.clients.add(socket);
    socket.on('close',()=>this.server.clients.delete(socket));
    socket.terminate=()=>socket.destroy();
   }
   this.connections++;if(!pipe)socket.send(JSON.stringify({op:0,d:{rpcVersion:1,obsWebSocketVersion:'5.6.0',...(auth?{authentication:{salt:'fixture-salt',challenge:'fixture-challenge'}}:{})}}));
   const receive=async (op,d)=>{
    if(op===1){if(auth&&d.authentication!==hash(hash(password+'fixture-salt')+'fixture-challenge')){socket.close(4009);return;}socket.send(JSON.stringify({op:2,d:{negotiatedRpcVersion:1}}));return;}
    if(op!==6)return;
    const type=d.requestType,request=d.requestData||{};this.records.push({type,data:request});
    let response={},code=100;
    const input=this.inputs.find(input=>request.inputUuid?input.inputUuid===request.inputUuid:input.inputName===request.inputName);
    const handled=this.handleRequest?await this.handleRequest(type,request):null;
    if(handled){response=handled.response||{};code=handled.code||100;}
    else if(type==='GetVersion')response={...(pipe?{protocolVersion:1}:{}),availableRequests:['GetInputAudioSyncOffset','SetInputAudioSyncOffset','GetInputList','GetSpecialInputs','GetInputSettings','GetSourceFilterList','CreateSourceFilter','RemoveSourceFilter','SetSourceFilterEnabled',...(this.extraRequests||[])]};
    else if(type==='GetInputList')response={inputs:this.inputs.map(({inputName,inputUuid,noAudio,inputKind})=>({inputName,inputUuid,inputKind:inputKind||(noAudio?'window_capture':'wasapi_output_capture')}))};
    else if(type==='GetInputSettings'){if(!input)code=600;else response={inputKind:input.inputKind||(input.noAudio?'window_capture':'wasapi_output_capture'),inputSettings:{}};}
    else if(['GetSourceFilterList','CreateSourceFilter','RemoveSourceFilter','SetSourceFilterEnabled'].includes(type)){
     const source=this.inputs.find(item=>request.sourceUuid?item.inputUuid===request.sourceUuid:item.inputName===request.sourceName);
     if(!source)code=600;
     else{
      const filters=this.filters.get(source.inputUuid)||[];this.filters.set(source.inputUuid,filters);
      const filter=filters.find(item=>item.filterName===request.filterName);
      if(type==='GetSourceFilterList')response={filters:structuredClone(filters)};
      else if(type==='CreateSourceFilter'){
       if(filter)code=601;
       else if(!['gpu_delay',...(this.extraFilterKinds||[])].includes(request.filterKind)||request.filterSettings.delay_ms<0||request.filterSettings.delay_ms>500)code=402;
       else filters.push({filterName:request.filterName,filterKind:request.filterKind,filterEnabled:true,filterSettings:structuredClone(request.filterSettings)});
      }else if(!filter)code=600;
      else if(type==='RemoveSourceFilter')this.filters.set(source.inputUuid,filters.filter(item=>item!==filter));
      else filter.filterEnabled=request.filterEnabled;
     }
    }
    else if(type==='GetSpecialInputs')response={desktop1:'デスクトップ音声',desktop2:null,mic1:'変換音声',mic2:null};
    else if(type==='GetInputAudioSyncOffset'||type==='SetInputAudioSyncOffset'){
     if(!input)code=600;else if(input.noAudio)code=604;
     else if(type==='GetInputAudioSyncOffset'){response={inputAudioSyncOffset:input.offset};if(this.delayGet){const delay=this.delayGet;this.delayGet=0;await new Promise(resolve=>setTimeout(resolve,delay));}}
     else if(!Number.isInteger(request.inputAudioSyncOffset)||request.inputAudioSyncOffset< -950||request.inputAudioSyncOffset>20000)code=402;
     else input.offset=request.inputAudioSyncOffset;
    }else code=204;
    if(this.ignore===type)return;
    if(pipe){if(!socket.destroyed)socket.write(JSON.stringify({id:d.requestId,code,data:response})+'\n');}
    else if(socket.readyState===1)socket.send(JSON.stringify({op:7,d:{requestId:d.requestId,requestType:type,requestStatus:{result:code===100,code},responseData:response}}));
   };
   if(pipe)readline.createInterface({input:socket}).on('line',line=>{
    const {id,type,data}=JSON.parse(line);void receive(6,{requestId:id,requestType:type,requestData:data});
   });
   else socket.on('message',data=>{const {op,d}=JSON.parse(data.toString());void receive(op,d);});
  });
  if(pipe)this.server.listen(pipe);
 }
 get(uuid){return this.inputs.find(input=>input.inputUuid===uuid);}
 writes(){return this.records.filter(record=>record.type==='SetInputAudioSyncOffset');}
 drop(){for(const socket of this.server.clients)socket.terminate();}
 kick(){for(const socket of this.server.clients)socket.close(4011);}
 async close(){for(const socket of this.server.clients)socket.terminate();await new Promise(resolve=>this.server.close(resolve));}
}
module.exports={ObsServer};
