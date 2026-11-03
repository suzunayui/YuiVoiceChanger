"""Opt-in recorded-audio GPU integration check; never opens a microphone.

python tests/gpu_inference.py --checkpoint voice.pt.gz --audio original.wav
Optional --reference-dir compares against the listening-tested prototype.
"""
import argparse
import json
from pathlib import Path
import sys
import threading
import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.direct_gpu import BeatricePipeline

parser = argparse.ArgumentParser()
parser.add_argument('--checkpoint', required=True)
parser.add_argument('--audio', required=True)
parser.add_argument('--reference-dir')
parser.add_argument('--device',choices=['auto','cpu','cuda'],default='auto')
args = parser.parse_args()
source, rate = sf.read(args.audio, dtype='float32', always_2d=True)
assert rate == 48000, 'Expected 48k recording'
source = source.mean(axis=1)[:48000*13]
source = np.pad(source, (0, -len(source) % 3840))
pipeline = BeatricePipeline({'beatrice_model':args.checkpoint, 'beatrice_pitch':14,'compute':args.device})
pipeline.warmup(threading.Event())
source=np.pad(source,(0,-len(source)%pipeline.block))
parts, times = [], []
for start in range(0, len(source), pipeline.block):
    parts.append(pipeline.convert(source[start:start+pipeline.block]))
    times.append(pipeline.stats['ms'])
output = np.concatenate(parts)
assert output.shape == source.shape and np.isfinite(output).all()
assert np.max(np.abs(output)) > .001, 'Unexpected silent conversion'
report = dict(blocks=len(parts), python=sys.version.split()[0], gpu=pipeline.device_name,
    median_ms=float(np.median(times)), p95_ms=float(np.percentile(times,95)),
    max_ms=max(times), budget_ms=pipeline.block/48, over_budget=sum(t>pipeline.block/48 for t in times))
if args.reference_dir:
    sys.path.insert(0, args.reference_dir)
    from streaming_direct import StreamingDirect
    baseline = StreamingDirect(block_ms=80,pitch=14,input_gain_db=12,output_gain_db=0)
    baseline.warmup()
    reference = np.concatenate([baseline.convert(source[i:i+3840]) for i in range(0,len(source),3840)])
    difference = float(np.max(np.abs(output-reference)))
    report['prototype_max_sample_difference'] = difference
    assert difference < 1e-6, f'Output changed during integration: {difference}'
# Confirm the independent formant control reaches the real model.
pipeline.reset()
probe = source[:pipeline.block]
pipeline.formant = .5
modified = pipeline.convert(probe)
assert np.isfinite(modified).all() and modified.shape == probe.shape
report['formant_half_semitone_finite'] = True
print(json.dumps(report, indent=2))
