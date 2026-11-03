const {WebSocketServer}=require('ws');
const {createHash}=require('node:crypto');
const hash=value=>createHash('sha256').update(value).digest('base64');
class ObsServer{
 constructor({password='fixture-password',auth=true}={}){
  this.password=password;this.auth=auth;this.records=[];this.connections=0;this.ignore='';this.delayGet=0;
  this.inputs=[{inputName:'デスクトップ音声',inputUuid:'desktop',offset:23},{inputName:'伴奏ブラウザー',inputUuid:'music',offset:35},{inputName:'変換音声',inputUuid:'voice',offset:0},{inputName:'映像のみ',inputUuid:'video',noAudio:true}];
  this.server=new WebSocketServer({host:'127.0.0.1',port:0});
  this.ready=new Promise(resolve=>this.server.once('listening',()=>{this.port=this.server.address().port;resolve(this);}));
  this.server.on('connection',socket=>{
   this.connections++;socket.send(JSON.stringify({op:0,d:{rpcVersion:1,obsWebSocketVersion:'5.6.0',...(auth?{authentication:{salt:'fixture-salt',challenge:'fixture-challenge'}}:{})}}));
   socket.on('message',async data=>{
    const message=JSON.parse(data.toString()),{op,d}=message;
    if(op===1){if(auth&&d.authentication!==hash(hash(password+'fixture-salt')+'fixture-challenge')){socket.close(4009);return;}socket.send(JSON.stringify({op:2,d:{negotiatedRpcVersion:1}}));return;}
    if(op!==6)return;
    const type=d.requestType,request=d.requestData||{};this.records.push({type,data:request});
    let response={},code=100;
    const input=this.inputs.find(input=>request.inputUuid?input.inputUuid===request.inputUuid:input.inputName===request.inputName);
    const handled=this.handleRequest?await this.handleRequest(type,request):null;
    if(handled){response=handled.response||{};code=handled.code||100;}
    else if(type==='GetVersion')response={availableRequests:['GetInputAudioSyncOffset','SetInputAudioSyncOffset','GetInputList','GetSpecialInputs',...(this.extraRequests||[])]};
    else if(type==='GetInputList')response={inputs:this.inputs.map(({inputName,inputUuid})=>({inputName,inputUuid}))};
    else if(type==='GetSpecialInputs')response={desktop1:'デスクトップ音声',desktop2:null,mic1:'変換音声',mic2:null};
    else if(type==='GetInputAudioSyncOffset'||type==='SetInputAudioSyncOffset'){
     if(!input)code=600;else if(input.noAudio)code=604;
     else if(type==='GetInputAudioSyncOffset'){response={inputAudioSyncOffset:input.offset};if(this.delayGet){const delay=this.delayGet;this.delayGet=0;await new Promise(resolve=>setTimeout(resolve,delay));}}
     else if(!Number.isInteger(request.inputAudioSyncOffset)||request.inputAudioSyncOffset< -950||request.inputAudioSyncOffset>20000)code=402;
     else input.offset=request.inputAudioSyncOffset;
    }else code=204;
    if(this.ignore===type||socket.readyState!==1)return;
    socket.send(JSON.stringify({op:7,d:{requestId:d.requestId,requestType:type,requestStatus:{result:code===100,code},responseData:response}}));
   });
  });
 }
 get(uuid){return this.inputs.find(input=>input.inputUuid===uuid);}
 writes(){return this.records.filter(record=>record.type==='SetInputAudioSyncOffset');}
 drop(){for(const socket of this.server.clients)socket.terminate();}
 kick(){for(const socket of this.server.clients)socket.close(4011);}
 async close(){for(const socket of this.server.clients)socket.terminate();await new Promise(resolve=>this.server.close(resolve));}
}
module.exports={ObsServer};
