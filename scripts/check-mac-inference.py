"""Exercise real inference kernels using random weights; no user model or audio IO."""
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import numpy as np
import torch
from backend.beatrice_model import PhoneExtractor,PitchEstimator,ConverterNetwork
from backend.direct_gpu import DirectModel

torch.set_num_threads(2)
torch.manual_seed(42)
model=DirectModel.__new__(DirectModel)
model.preference='cpu';model.voice=0;model.device=torch.device('cpu')
model.phone=PhoneExtractor();model.pitch=PitchEstimator()
model.net=ConverterNetwork(model.phone,model.pitch,n_speakers=1,pitch_bins=384,hidden_channels=256)
model._finish(torch)
t=np.arange(16000,dtype=np.float32)/16000
audio=(.05*np.sin(2*np.pi*180*t)).astype(np.float32)
output=model.infer(audio,shift=0,formant=0)
assert output.ndim==1 and len(output)>0 and np.isfinite(output).all()
print('PASS native CPU Beatrice model inference with synthetic input and random weights:',len(output))
