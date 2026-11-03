import tempfile
from pathlib import Path
import unittest
import threading
from unittest.mock import patch
import numpy as np
import torch
from backend.direct_gpu import checkpoint_path, select_device, BeatricePipeline
from backend.beatrice_model import CrossAttention
from backend.scheduled_audio import ScheduledAudio, verify_scheduler
from backend.realtime import Realtime, estimate_latency_ms

torch.set_num_threads(2)


class DirectGpuTests(unittest.TestCase):
    def test_latency_estimate_follows_sample_positions_without_double_counting_processing(self):
        import torchaudio
        class IdentityModel:
            device=torch.device('cpu')
            device_name='CPU'
            source_format='test identity'
            def infer(self, audio, **kwargs):
                return torchaudio.functional.resample(torch.from_numpy(audio),16000,24000).numpy()
        pipeline=BeatricePipeline({'input_gain':0,'gain':0},model=IdentityModel())
        source=np.zeros(10*pipeline.block,np.float32)
        impulse=6*pipeline.block+1000
        source[impulse]=.5
        results=[];lookbacks=[]
        for start in range(0,len(source),pipeline.block):
            results.append(pipeline.convert(source[start:start+pipeline.block]))
            lookbacks.append(pipeline.stats['lookback_ms'])
        output=np.concatenate(results)
        observed=int(np.argmax(np.abs(output)))
        lookback=lookbacks[observed//pipeline.block]
        for schedule in (160,320):
            observed_latency=(observed-impulse)/48+schedule+54
            self.assertAlmostEqual(estimate_latency_ms(schedule,lookback,54),observed_latency,delta=.25)
        self.assertIsNone(estimate_latency_ms(160,65,float('nan')))

    def test_explicit_gpu_index_is_used_and_failure_does_not_switch_devices(self):
        with patch('torch.cuda.is_available',return_value=True), patch('torch.ones',return_value=torch.ones((16,16))) as probe:
            self.assertEqual(str(select_device('cuda:1')),'cuda:1')
            self.assertEqual(probe.call_args.kwargs['device'],'cuda:1')
        with patch('torch.cuda.is_available',return_value=True), patch('torch.ones',side_effect=RuntimeError('missing GPU')):
            with self.assertRaisesRegex(RuntimeError,'選択したGPU'):select_device('cuda:1')
            self.assertEqual(select_device('auto').type,'cpu')
        for value in ('cuda:-1','cuda:01','cuda:1.5','cuda:999999'):
            with self.subTest(value=value),self.assertRaises(ValueError):select_device(value)

    def test_auto_falls_back_to_cpu_when_no_gpu_is_available(self):
        with patch('torch.cuda.is_available',return_value=False):
            self.assertEqual(select_device().type,'cpu')
            self.assertEqual(select_device('cpu').type,'cpu')
            with self.assertRaisesRegex(RuntimeError,'GPU'):select_device('cuda')

    def test_stop_during_model_loading_does_not_open_microphone(self):
        entered, release = threading.Event(), threading.Event()
        class LoadingPipeline:
            def __init__(self, *args):
                entered.set()
                release.wait(3)
        events = []
        engine = Realtime(events.append)
        with patch('backend.direct_gpu.BeatricePipeline', LoadingPipeline), patch('sounddevice.Stream') as stream:
            engine.start({})
            self.assertTrue(entered.wait(3))
            engine.stop()
            release.set()
            engine.thread.join(3)
            self.assertFalse(engine.thread.is_alive())
            stream.assert_not_called()
        self.assertEqual(events[-1], {'type':'state', 'state':'stopped'})

    def test_inference_does_not_randomly_drop_attention(self):
        torch.manual_seed(0)
        attention = CrossAttention(qk_channels=128, vo_channels=128, num_heads=4,
            in_q_channels=256, in_kv_channels=128, out_channels=256, dropout=.1)
        q, kv = torch.randn(1, 8, 256), torch.randn(1, 384, 128)
        with torch.inference_mode():
            attention.eval()
            torch.manual_seed(1); first = attention(q, kv)
            torch.manual_seed(2); second = attention(q, kv)
            torch.testing.assert_close(first, second, rtol=0, atol=0)
            attention.train()
            torch.manual_seed(1); first = attention(q, kv)
            torch.manual_seed(2); second = attention(q, kv)
            self.assertGreater((first-second).abs().max().item(), .0001)

    def test_exported_and_rvc_models_are_not_mistaken_for_checkpoints(self):
        for name in ('voice.toml','voice.bin','voice.pth','voice.onnx',''):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, '学習チェックポイント'):
                checkpoint_path(name)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'声.pt.gz'
            with self.assertRaisesRegex(ValueError, '見つかりません'):
                checkpoint_path(str(path))
            path.touch()
            self.assertEqual(checkpoint_path(str(path)), path)

    def test_variable_job_completion_does_not_change_output_schedule(self):
        self.assertEqual(set(verify_scheduler().values()), {'passed'})

    def test_ring_wrap_and_partial_late_audio_preserve_absolute_positions(self):
        audio = ScheduledAudio(capacity=100)
        audio.take(90)
        audio.put(85, np.arange(30,dtype=np.float32))
        np.testing.assert_array_equal(audio.take(25),np.arange(5,30))
        self.assertEqual(audio.late_blocks,1)
        audio.put(120,np.full(20,.5,np.float32))
        np.testing.assert_array_equal(audio.take(25),np.r_[np.zeros(5),np.full(20,.5)])
