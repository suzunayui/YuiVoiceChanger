"""Opt-in compatibility integration: public assets + synthetic RVC/ONNX fixtures.
No proprietary RVC weights are opened. No microphone or full training starts.
"""
from pathlib import Path
import argparse
import json
import sys
import numpy as np
import torch
import onnx
from onnx import helper,TensorProto,numpy_helper
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from backend.model_tools import inspect_model
from backend.rvc_teacher import RvcTeacher
from backend.rvc import models

parser=argparse.ArgumentParser()
parser.add_argument('--assets',required=True);parser.add_argument('--work',required=True);parser.add_argument('--helper',required=True)
args=parser.parse_args()
torch.set_num_threads(2)
root=Path(args.work);root.mkdir(parents=True,exist_ok=True)
config=[513,32,16,16,32,2,2,3,0.,'1',[3,7,11],[[1,3,5]]*3,[10,4,2,4],64,[16,8,4,8],1,16,32000]
pths=[]
for version in ['v1','v2']:
    for f0 in [0,1]:
        klass=getattr(models,'SynthesizerTrnMs'+('768' if version=='v2' else '256')+'NSFsid'+('' if f0 else '_nono'))
        voice=klass(*config,is_half=False)
        state={k:v for k,v in voice.state_dict().items() if not k.startswith('enc_q.')}
        pth=root/f'fixture_{version}_{f0}.pth'
        torch.save(dict(config=config,weight=state,version=version,f0=f0),pth);pths.append(pth)
inputs=[helper.make_tensor_value_info('feats',TensorProto.FLOAT,[1,'T',768]),
        helper.make_tensor_value_info('p_len',TensorProto.INT64,[1]),
        helper.make_tensor_value_info('pitch',TensorProto.INT64,[1,'T']),
        helper.make_tensor_value_info('pitchf',TensorProto.FLOAT,[1,'T']),
        helper.make_tensor_value_info('sid',TensorProto.INT64,[1])]
constants=[numpy_helper.from_array(np.array([0],np.int64),'channel'),numpy_helper.from_array(np.array([1],np.int64),'axes'),
           numpy_helper.from_array(np.array([1,1,1,320],np.int64),'repeats'),numpy_helper.from_array(np.array([1,1,-1],np.int64),'shape'),
           numpy_helper.from_array(np.array(.1,np.float32),'gain')]
nodes=[helper.make_node('Gather',['feats','channel'],['selected'],axis=2),helper.make_node('Tanh',['selected'],['bounded']),
       helper.make_node('Mul',['bounded','gain'],['quiet']),helper.make_node('Unsqueeze',['quiet','axes'],['expanded']),
       helper.make_node('Tile',['expanded','repeats'],['repeated']),helper.make_node('Reshape',['repeated','shape'],['audio'])]
model=helper.make_model(helper.make_graph(nodes,'Synthetic RVC interface',inputs,[helper.make_tensor_value_info('audio',TensorProto.FLOAT,[1,1,'N'])],constants),opset_imports=[helper.make_opsetid('',18)])
model.ir_version=10
helper.set_model_props(model,{'metadata':json.dumps(dict(embChannels=768,samplingRate=32000,f0=True,embedder='hubert_base'))})
onnx_path=root/'fixture.onnx';onnx.save(model,onnx_path)
half=onnx.ModelProto();half.CopyFrom(model)
half.graph.input[0].type.tensor_type.elem_type=TensorProto.FLOAT16
half.graph.output[0].type.tensor_type.elem_type=TensorProto.FLOAT16
for index,initializer in enumerate(half.graph.initializer):
    if initializer.data_type==TensorProto.FLOAT:
        half.graph.initializer[index].CopyFrom(numpy_helper.from_array(numpy_helper.to_array(initializer).astype(np.float16),initializer.name))
half_path=root/'fixture_half.onnx';onnx.save(half,half_path)
source=(.08*np.sin(np.arange(16000*2,dtype=np.float32)*2*np.pi*220/16000)).astype(np.float32)
results=[]
for path in (*pths,onnx_path,half_path):
    info=inspect_model(path)
    teacher=RvcTeacher(path,args.assets,helper_python=args.helper,work=root/'onnx-cache')
    try:
        audio,rate=teacher.convert(source,shift=4)
        assert np.isfinite(audio).all() and len(audio)>rate and np.max(np.abs(audio))>1e-5
        results.append(dict(file=path.name,kind=info['kind'],rate=rate,samples=len(audio),peak=float(np.max(np.abs(audio)))))
    finally:teacher.close()
print(json.dumps(results,indent=2))
