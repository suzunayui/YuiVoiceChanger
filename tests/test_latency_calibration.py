import json
from pathlib import Path
import subprocess
import sys
import threading
import types
import unittest
from unittest.mock import patch
import numpy as np
from backend.latency_calibration import CalibrationCancelled, calibrate, capture_sample, measure_sample, recommend_latency


class Pipeline:
    block = 3840
    config = {'block': .08}
    fixed_lookback_ms = 65.
    device_name = 'Test CPU'
    def __init__(self, config=None): self.resets = 0
    def warmup(self, cancel): pass
    def reset(self): self.resets += 1
    def convert(self, audio): return np.zeros(len(audio), np.float32)


class CalibrationTests(unittest.TestCase):
    def test_target_reserves_headroom_and_refuses_unsustainable_settings(self):
        self.assertEqual(recommend_latency([20, 30, 40], 80, 65, 20), 350)
        self.assertEqual(recommend_latency([400, 450, 500], 640, 65, 40), 1620)
        self.assertGreater(recommend_latency([20]*10+[200], 80, 65, 20), 350)
        self.assertEqual(recommend_latency([1], 10, 0, 0), 300)
        self.assertEqual(recommend_latency([100], 900, 100, 0), 2000)
        # Never silently trim away the promised headroom at the 2000ms limit.
        with self.assertRaisesRegex(ValueError, '2000ms'): recommend_latency([100], 900, 110, 0)
        for times in ([], [float('nan')], [-1], [78, 80, 90]):
            with self.assertRaises(ValueError): recommend_latency(times, 80, 65, 20)
        with self.assertRaisesRegex(ValueError, '2000ms'): recommend_latency([10]*100+[2000], 80, 65, 20)

    def test_capture_uses_only_input_and_closes_both_streams(self):
        self.exercise_capture()

    def test_cancel_and_device_error_close_streams(self):
        self.exercise_capture(cancel_midway=True)
        self.exercise_capture(device_error=True)

    def exercise_capture(self, cancel_midway=False, device_error=False):
        cancel = threading.Event()
        streams, notices = [], []
        class Input:
            latency = .01
            active = True
            def __init__(self, **kwargs): self.callback=kwargs['callback'];self.closed=self.aborted=False;streams.append(self)
            def start(self):
                for index in range(600):
                    self.callback(np.full((480, 1), .1, np.float32), 480, None, device_error)
                    if cancel_midway and index == 4: cancel.set();return
            def abort(self): self.aborted=True
            def close(self): self.closed=True
        class Output:
            latency = .02
            def __init__(self, **kwargs): self.closed=False;streams.append(self)
            def start(self): raise AssertionError('Calibration must never start output audio')
            def close(self): self.closed=True
        sd=types.SimpleNamespace(InputStream=Input, OutputStream=Output, query_devices=lambda device: {'max_output_channels':2})
        devices=[dict(id=1,name='mic',host='Windows WASAPI',inputs=1,outputs=0),dict(id=2,name='out',host='Windows WASAPI',inputs=0,outputs=2)]
        with patch('backend.realtime.devices',return_value=devices), patch('backend.realtime.audio_settings',return_value=(None,None)):
            if cancel_midway:
                with self.assertRaises(CalibrationCancelled): capture_sample(sd,{'input':1,'output':2},notices.append,cancel)
            elif device_error:
                with self.assertRaisesRegex(RuntimeError,'途切れ'): capture_sample(sd,{'input':1,'output':2},notices.append,cancel)
            else:
                audio,latency=capture_sample(sd,{'input':1,'output':2},notices.append,cancel)
                self.assertEqual(len(audio),288000);self.assertAlmostEqual(latency,30)
                self.assertTrue(np.all(audio==np.float32(.1)))
        self.assertTrue(all(stream.closed for stream in streams));self.assertTrue(streams[0].aborted)
        self.assertTrue(any(notice['phase']=='speaking' for notice in notices))

    def test_measurement_includes_effects_and_silence_does_not_apply(self):
        sample=np.full(48000,.05,np.float32);notices=[];pipeline=Pipeline()
        with patch('backend.vocal_effects.VocalEffects.process',side_effect=lambda audio,config: audio) as effects:
            result=measure_sample(pipeline,sample,{},notices.append,threading.Event(),20)
            self.assertEqual(result['recommended_ms'],350)
            self.assertEqual(effects.call_count,13)
        self.assertEqual(pipeline.resets,1)
        with self.assertRaisesRegex(ValueError,'声が小さい'): measure_sample(Pipeline(),np.zeros(48000,np.float32),{},notices.append,threading.Event(),20)
        cancel=threading.Event();cancel.set()
        with self.assertRaises(CalibrationCancelled): measure_sample(Pipeline(),sample,{},notices.append,cancel,20)

    def test_success_wipes_sample_and_cancel_during_warmup_never_opens_mic(self):
        sample=np.full(48000,.05,np.float32)
        with patch('backend.direct_gpu.BeatricePipeline',Pipeline),patch('backend.latency_calibration.capture_sample',return_value=(sample,20)):
            result=calibrate({},lambda event:None,threading.Event())
        self.assertEqual(result['recommended_ms'],350);self.assertTrue(np.all(sample==0))
        class CancelPipeline(Pipeline):
            def warmup(self,cancel): cancel.set()
        with patch('backend.direct_gpu.BeatricePipeline',CancelPipeline),patch('backend.latency_calibration.capture_sample',side_effect=AssertionError('microphone opened')):
            with self.assertRaises(CalibrationCancelled): calibrate({},lambda event:None,threading.Event())

    def test_private_pipe_worker_reports_results_and_cancellation(self):
        root=str(Path(__file__).resolve().parents[1])
        for cancelled in (False,True):
            code=f"""
import sys
sys.path.insert(0,{root!r})
import backend.latency_calibration as module
def run(config,notify,cancel):
    if {cancelled!r}:
        cancel.wait(1)
        module.check_cancel(cancel)
    return {{'recommended_ms':320}}
module.calibrate=run
module.main()
"""
            wire='{}\n'+('{"command":"cancel"}\n' if cancelled else '')
            result=subprocess.run([sys.executable,'-I','-c',code],input=wire,text=True,encoding='utf8',capture_output=True,timeout=5)
            self.assertEqual(result.returncode,0,result.stderr)
            event=json.loads(result.stdout.strip().splitlines()[-1]);self.assertEqual(event['phase'],'cancelled' if cancelled else 'completed')


if __name__=='__main__': unittest.main()
