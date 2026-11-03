"""Whole-utterance RVC v1/v2 teacher. No microphone or training side effects."""
from pathlib import Path
import json
import subprocess
from types import SimpleNamespace
import numpy as np
import torch
from torch import nn
from torch.nn import functional as F
import torchaudio

from backend.model_tools import inspect_model


class ContentEncoder:
    def __init__(self, folder, device):
        from torchaudio.models.wav2vec2.utils.import_huggingface import _get_config
        folder=Path(folder)
        config=json.loads((folder/'config.json').read_text())
        self.normalize=json.loads((folder/'preprocessor_config.json').read_text()).get('do_normalize',False)
        self.model=torchaudio.models.wav2vec2_model(**_get_config(SimpleNamespace(**config)),aux_num_out=None)
        state=torch.load(folder/'pytorch_model.bin',map_location='cpu',weights_only=True)
        weights={}
        for key,value in state.items():
            if key in ('masked_spec_embed','final_proj.weight','final_proj.bias'):continue
            if key.startswith('feature_projection.'):key='encoder.'+key
            elif key.startswith('encoder.'):key='encoder.transformer.'+key[len('encoder.'):]
            weights[key]=value
        # Support both public weight_norm serialization conventions.
        expected=self.model.state_dict()
        for key in list(weights):
            new=key.replace('.weight_g','.parametrizations.weight.original0').replace('.weight_v','.parametrizations.weight.original1')
            if new in expected and key not in expected:weights[new]=weights.pop(key)
        self.model.load_state_dict(weights,strict=True)
        self.model.eval().to(device)
        self.projection=nn.Linear(config['hidden_size'],config['classifier_proj_size'])
        self.projection.load_state_dict({k:state['final_proj.'+k] for k in ('weight','bias')})
        self.projection.eval().to(device)

    def features(self, source, version):
        if self.normalize:source=F.layer_norm(source,source.shape)
        layers,_=self.model.extract_features(source[None],num_layers=9 if version=='v1' else 12)
        return self.projection(layers[-1]) if version=='v1' else layers[-1]


class RvcTeacher:
    def __init__(self, model, assets, *, helper_python=None, work=None):
        self.info=inspect_model(model)
        if not self.info['train_required']:raise ValueError('RVCモデルを選んでください。')
        self.device=torch.device('cuda')
        self.assets=Path(assets);self.work=Path(work) if work else None
        self.process=None
        self.encoder=ContentEncoder(self.assets/'rvc/hubert_base',self.device)
        if self.info['f0']:
            from backend.rvc.rmvpe import RMVPE,MelSpectrogram,E2E
            self.pitch=RMVPE.__new__(RMVPE)
            self.pitch.device=self.device;self.pitch.is_half=False
            self.pitch.mel_extractor=MelSpectrogram(False,128,16000,1024,160,None,30,8000).to(self.device)
            self.pitch.model=E2E(4,1,(2,2))
            self.pitch.model.load_state_dict(torch.load(self.assets/'rvc/rmvpe.pt',map_location='cpu',weights_only=True))
            self.pitch.model.eval().to(self.device)
            self.pitch.cents_mapping=np.pad(20*np.arange(360)+1997.3794084376191,(4,4))
        if self.info['kind']=='rvc-pth':
            from backend.rvc import models
            data=torch.load(model,map_location='cpu',weights_only=True)
            config=list(data['config']);config[-3]=data['weight']['emb_g.weight'].shape[0]
            name='SynthesizerTrnMs'+('768' if self.info['version']=='v2' else '256')+'NSFsid'+('' if self.info['f0'] else '_nono')
            self.voice=getattr(models,name)(*config,is_half=False)
            del self.voice.enc_q
            incompatible=self.voice.load_state_dict(data['weight'],strict=False)
            if incompatible.missing_keys:raise ValueError('RVCの重みが不足しています: '+str(incompatible.missing_keys[:3]))
            self.voice.eval().to(self.device)
        else:
            if not helper_python or not self.work:raise ValueError('ONNX用の互換環境を準備してください。')
            self.work.mkdir(parents=True,exist_ok=True)
            self.process=subprocess.Popen([helper_python,'-I',str(Path(__file__).with_name('onnx_helper.py')),str(model),str(Path(torch.__file__).parent/'lib')],
                stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=None,text=True,encoding='utf-8',
                creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            first=self.process.stdout.readline()
            if not first or not json.loads(first).get('ready'):raise RuntimeError('ONNX実行環境の起動に失敗しました。')

    @torch.inference_mode()
    def convert(self, audio16k, shift=0):
        torch.manual_seed(42)
        x=torch.from_numpy(np.asarray(audio16k,dtype=np.float32)).to(self.device)
        feats=self.encoder.features(x,self.info['version'])
        feats=torch.cat([feats,feats[:,-1:]],dim=1)
        feats=F.interpolate(feats.transpose(1,2),scale_factor=2).transpose(1,2)
        length=min(len(x)//160,feats.shape[1]);feats=feats[:,:length]
        pitch=np.zeros(length,np.int64);pitchf=np.zeros(length,np.float32)
        if self.info['f0']:
            f0=self.pitch.infer_from_audio(x,thred=.03).astype(np.float32)[:length]*2**(shift/12)
            pitchf[:len(f0)]=f0
            mel=1127*np.log1p(pitchf/700)
            lo,hi=1127*np.log1p(50/700),1127*np.log1p(1100/700)
            mel[mel>0]=(mel[mel>0]-lo)*254/(hi-lo)+1
            pitch=np.rint(np.clip(mel,1,255)).astype(np.int64)
        if self.process:
            inp,out=self.work/'input.npz',self.work/'output.npy'
            np.savez(inp,feats=feats.cpu().numpy(),p_len=np.array([length],np.int64),
                     pitch=pitch[None],pitchf=pitchf[None],sid=np.array([0],np.int64))
            self.process.stdin.write(json.dumps({'input':str(inp),'output':str(out)})+'\n');self.process.stdin.flush()
            line=self.process.stdout.readline()
            if not line:raise RuntimeError('ONNX変換プロセスが終了しました。')
            result=json.loads(line)
            if not result.get('ok'):raise ValueError(result.get('error','ONNX変換に失敗しました。'))
            y=np.load(out,allow_pickle=False)
        else:
            args=(feats,torch.tensor([length],device=self.device))
            sid=torch.tensor([0],device=self.device)
            if self.info['f0']:
                args+= (torch.from_numpy(pitch[None]).to(self.device),torch.from_numpy(pitchf[None]).to(self.device),sid)
            else:args+=(sid,)
            y=self.voice.infer(*args)[0][0,0].cpu().numpy()
        if not np.isfinite(y).all():raise RuntimeError('RVCの生成結果に不正な値があります。')
        return y,self.info['rate']

    def close(self):
        if self.process:
            try:
                self.process.stdin.write('{"quit":true}\n');self.process.stdin.flush()
                self.process.wait(timeout=5)
            except Exception:self.process.kill()
            self.process=None
