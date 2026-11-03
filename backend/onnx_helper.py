"""ONNX CPU execution in an isolated Python 3.14 helper, JSON-lines control."""
import json
import os
from contextlib import redirect_stdout
import sys
import numpy as np
handles=[]
if len(sys.argv)>2 and os.name=='nt':
    handles.append(os.add_dll_directory(sys.argv[2]))
    os.environ['PATH']=sys.argv[2]+os.pathsep+os.environ.get('PATH','')
import onnxruntime as ort

sys.stdin.reconfigure(encoding='utf-8');sys.stdout.reconfigure(encoding='utf-8')
options=ort.SessionOptions();options.intra_op_num_threads=2;options.inter_op_num_threads=1
if len(sys.argv)>2 and hasattr(ort,'preload_dlls'):
    with redirect_stdout(sys.stderr):ort.preload_dlls(directory=sys.argv[2])
providers=['CUDAExecutionProvider','CPUExecutionProvider'] if 'CUDAExecutionProvider' in ort.get_available_providers() else ['CPUExecutionProvider']
session=ort.InferenceSession(sys.argv[1],sess_options=options,providers=providers)
print(json.dumps({'ready':True,'providers':session.get_providers()}),flush=True)
for line in sys.stdin:
    try:
        request=json.loads(line)
        if request.get('quit'):break
        with np.load(request['input'],allow_pickle=False) as data:
            frames=data['feats'].shape[1]
            aliases={'phone':'feats','phone_lengths':'p_len','ds':'sid','speaker_id':'sid','nsff0':'pitchf'}
            feed={}
            for item in session.get_inputs():
                key=aliases.get(item.name,item.name)
                if key in data:array=data[key]
                elif key in ('rnd','noise'):
                    channels=item.shape[1] if isinstance(item.shape[1],int) else 192
                    array=np.random.default_rng(42).standard_normal((1,channels,frames)).astype(np.float32)
                else:raise ValueError('未対応のONNX入力: '+item.name)
                dtype={'tensor(float)':np.float32,'tensor(float16)':np.float16,'tensor(int64)':np.int64}.get(item.type)
                if dtype is None:raise ValueError('未対応のONNX入力型: '+item.type)
                feed[item.name]=array.astype(dtype,copy=False)
            result=session.run(None,feed)[0]
        np.save(request['output'],np.asarray(result,dtype=np.float32).reshape(-1),allow_pickle=False)
        print(json.dumps({'ok':True}),flush=True)
    except Exception as exc:print(json.dumps({'error':str(exc)},ensure_ascii=False),flush=True)
