"""Model identification and hardware checks; no microphone access."""
from pathlib import Path
import json
import sys

ROOT=Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:sys.path.insert(0,str(ROOT))


def sample_rate(value):
    if isinstance(value,str) and value.endswith('k'):return int(value[:-1])*1000
    return int(value)


def inspect_model(value):
    path=Path(value).expanduser()
    if not path.is_file():raise ValueError('モデルファイルが見つかりません。')
    if path.suffix.lower() in ('.toml','.bin'):
        from backend.exported_model import manifest_path
        p,meta=manifest_path(path)
        return dict(kind='beatrice-binary',path=str(p),name=meta['model'].get('name',p.stem),voices=len(meta['voice']),train_required=False)
    if path.suffix.lower()=='.onnx':
        import onnx
        graph=onnx.load(str(path),load_external_data=False)
        names={x.name for x in graph.graph.input}
        if not names&{'feats','phone'}:
            raise ValueError('対応するRVCのONNXではありません（音声特徴の入力が必要です）。')
        props={x.key:x.value for x in graph.metadata_props}
        meta=json.loads(props.get('metadata','{}'))
        channels=meta.get('embChannels')
        if channels is None:
            feature=next(x for x in graph.graph.input if x.name in ('feats','phone'))
            channels=feature.type.tensor_type.shape.dim[-1].dim_value
        rate=meta.get('samplingRate') or props.get('sampling_rate') or props.get('sample_rate')
        if not rate:
            # Standard RVC vocoders emit 100 frames/s and one transposed-conv
            # upsampling chain. Fixed voice IDs/lengths may be graph constants.
            strides=[]
            for node in graph.graph.node:
                if node.op_type=='ConvTranspose':
                    attrs={a.name:a for a in node.attribute}
                    if 'strides' in attrs and len(attrs['strides'].ints)==1:strides.append(attrs['strides'].ints[0])
            import math
            inferred=100*math.prod(strides) if strides else 0
            if inferred in (32000,40000,48000):rate=inferred
            else:raise ValueError('ONNXの出力サンプルレートを判別できません。samplingRateメタデータ付きのRVC ONNXが必要です。')
        channels,rate=int(channels),sample_rate(rate)
        if channels not in (256,768) or rate not in (32000,40000,48000):
            raise ValueError('対応するRVCはv1/v2・32k/40k/48kです。')
        if meta.get('embedder','hubert_base') not in ('hubert_base','contentvec'):
            raise ValueError('このONNXの特徴抽出モデルには対応していません。')
        return dict(kind='rvc-onnx',path=str(path),name=path.stem,version='v2' if channels==768 else 'v1',
                    rate=rate,f0=bool({'pitch','pitchf','nsff0'}&names),train_required=True)
    import torch
    import gzip
    opener=gzip.open if path.name.endswith('.pt.gz') else open
    if path.suffix.lower() not in ('.pth','.pt','.gz'):raise ValueError('未対応のファイルです。')
    with opener(path,'rb') as f:data=torch.load(f,map_location='cpu',weights_only=True)
    if isinstance(data,dict) and {'h','net_g','phone_extractor','pitch_estimator'}<=data.keys():
        return dict(kind='beatrice-checkpoint',path=str(path),name=path.name,train_required=False)
    if not isinstance(data,dict) or not {'config','weight'}<=data.keys():
        raise ValueError('RVC v1/v2の推論用.pth、またはBeatriceチェックポイントを選んでください。')
    config,weights=data['config'],data['weight']
    version=data.get('version','v1')
    if not isinstance(config,(tuple,list)) or len(config)!=18 or version not in ('v1','v2'):
        raise ValueError('このRVCの構造には対応していません。v1/v2標準形式が必要です。')
    if 'emb_g.weight' not in weights:raise ValueError('RVCの声埋め込みがありません。')
    rate=sample_rate(config[-1])
    if rate not in (32000,40000,48000):raise ValueError('対応するRVCは32k/40k/48kです。')
    return dict(kind='rvc-pth',path=str(path),name=path.stem,version=version,rate=rate,
                f0=bool(data.get('f0',1)),train_required=True)


def compute_devices():
    import torch
    from backend.direct_gpu import select_device
    devices=[]
    for index in range(torch.cuda.device_count()):
        name=torch.cuda.get_device_name(index)
        item=dict(id=f'cuda:{index}',kind='GPU',name=name,available=False)
        try:
            select_device(item['id'])
            item.update(available=True,memory_gb=round(torch.cuda.get_device_properties(index).total_memory/1024**3,1))
        except Exception:
            item['reason']='このGPUを現在の実行環境で利用できません。'
        devices.append(item)
    return dict(devices=devices)


def gpu_info():
    import torch
    if not torch.cuda.is_available():return dict(eligible=False,reason='対応するNVIDIA GPUがありません。')
    free,total=torch.cuda.mem_get_info()
    test=torch.ones((256,256),device='cuda');value=(test@test).sum().item()
    eligible=total>=8*1024**3 and free>=6*1024**3
    return dict(eligible=eligible,name=torch.cuda.get_device_name(0),free_gb=round(free/1024**3,1),total_gb=round(total/1024**3,1),
                reason='学習を開始できます。実際の所要時間は学習開始後に表示します。' if eligible else '学習にはVRAM合計8GB以上・空き6GB以上を推奨条件として必要とします。')


if __name__=='__main__':
    try:
        if sys.argv[1]=='inspect':result=inspect_model(sys.argv[2])
        elif sys.argv[1]=='gpu':result=gpu_info()
        elif sys.argv[1]=='compute-devices':result=compute_devices()
        else:raise ValueError('不明な操作です。')
        print(json.dumps(result,ensure_ascii=False))
    except Exception as e:
        print(str(e),file=sys.stderr);raise SystemExit(1)
