"""Validate the isolated runtime without opening a microphone."""
import json
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))


def runtime_info():
    if not ((3, 15, 2) <= sys.version_info[:3] < (3, 16, 0)):
        raise RuntimeError('Python 3.15.2以降の3.15系が必要です。')
    import numpy
    import sounddevice
    import torch
    import torchaudio
    from backend.direct_gpu import select_device
    device=select_device()
    test = torch.ones((16, 16), device=device)
    if not torch.isfinite(test @ test).all().item():
        raise RuntimeError('GPUの動作確認に失敗しました。')
    return dict(python=sys.version.split()[0], torch=torch.__version__, cuda=torch.version.cuda,
                gpu=torch.cuda.get_device_name(0) if device.type=='cuda' else None, device=device.type, numpy=numpy.__version__,
                torchaudio=torchaudio.__version__, devices=len(sounddevice.query_devices()))


if __name__ == '__main__':
    print(json.dumps(runtime_info(), ensure_ascii=False))
