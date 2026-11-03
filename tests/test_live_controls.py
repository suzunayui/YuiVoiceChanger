import json
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import torch
from backend.audio_controls import normalize_controls, apply_gain
from backend.direct_gpu import BeatricePipeline
from backend.realtime import Realtime
from backend.scheduled_audio import ScheduledAudio


class LiveControlsTests(unittest.TestCase):
    def test_validation_and_partial_updates_are_atomic(self):
        engine = Realtime(lambda event: None)
        engine.update_controls({'beatrice_pitch': 3, 'beatrice_formant': .5, 'gain': -3})
        expected = dict(engine.controls)
        self.assertEqual(expected['input_gain'], 12)
        for changes in ({'gain': 19}, {'beatrice_formant': .3}, {'gain': float('nan')}, {'gain': True}, {'beatrice_model': 'other.pt'}, {'gain': 0, 'compute': 'cpu'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                engine.update_controls(changes)
            self.assertEqual(engine.controls, expected)
        with self.assertRaises(ValueError): engine.update_controls({'gain': 2}, {'fx_echo_ms': -1})
        self.assertEqual(engine.controls, expected)

    def test_gain_transition_is_short_and_constant_gain_is_unchanged(self):
        source = np.ones(3840, np.float32)
        np.testing.assert_array_equal(apply_gain(source, 2., 2.), source * 2.)
        output = apply_gain(source, 1., 2.)
        self.assertEqual(output[0], 1.)
        self.assertEqual(output[479], 2.)
        np.testing.assert_array_equal(output[480:], np.full(3360, 2., np.float32))
        self.assertTrue(np.all(np.diff(output[:480]) >= 0))
        np.testing.assert_array_equal(source, np.ones(3840, np.float32))

    def test_pipeline_changes_controls_without_reloading_or_resetting_history(self):
        class Model:
            device = torch.device('cpu')
            device_name = 'CPU'
            source_format = 'test'
            def infer(self, source, **controls):
                self.last = controls
                return np.full(round(len(source)*1.5), .1, np.float32)
        model = Model()
        pipeline = BeatricePipeline({'input_gain': 0, 'gain': 0}, model=model)
        reference = BeatricePipeline({'input_gain': 0, 'gain': 0}, model=Model())
        audio = np.full(pipeline.block, .25, np.float32)
        pipeline.convert(audio)
        reference.convert(audio)
        history = pipeline.history.copy()
        tail = pipeline.joiner.tail.copy()
        joiner = pipeline.joiner
        pipeline.set_controls({'beatrice_pitch': 3, 'beatrice_formant': .5, 'input_gain': 6, 'gain': 6})
        np.testing.assert_array_equal(pipeline.history, history)
        np.testing.assert_array_equal(pipeline.joiner.tail, tail)
        output = pipeline.convert(audio)
        baseline = reference.convert(audio)
        self.assertIs(pipeline.model, model)
        self.assertIs(pipeline.joiner, joiner)
        self.assertEqual(pipeline.block, 3840)
        self.assertEqual(model.last, {'shift': 3., 'formant': .5})
        self.assertAlmostEqual(float(pipeline.history[-pipeline.block]), .25, places=6)
        self.assertAlmostEqual(float(pipeline.history[-1]), .25*10**(6/20), places=6)
        np.testing.assert_allclose(output, apply_gain(baseline, 1., 10**(6/20)), atol=1e-7, rtol=0)
        self.assertTrue(np.isfinite(output).all())

    def test_running_stream_takes_next_snapshot_without_reopening_or_rescheduling(self):
        self.exercise_stream(False)

    def test_singing_stream_holds_target_and_accepts_live_effects(self):
        self.exercise_stream(True)

    def exercise_stream(self, singing):
        first, changed = threading.Event(), threading.Event()
        pipelines, streams, positions, events = [], [], [], []
        target = normalize_controls({'beatrice_pitch': 3, 'beatrice_formant': .5, 'input_gain': 4, 'gain': -4})
        class Pipeline:
            rate = 48000
            device_name = 'CPU'
            format = 'test'
            block = 3840
            config = {'block': .08}
            def __init__(self, config, notify):
                self.resets = 0
                pipelines.append(self)
            def warmup(self, stop): pass
            def reset(self): self.resets += 1
            def set_controls(self, controls): self.controls = dict(controls)
            def convert(self, audio):
                self.stats = {'ms': 1., 'lookback_ms': 65.}
                first.set()
                if self.controls == target: changed.set()
                return np.zeros(self.block, np.float32)
        class Schedule(ScheduledAudio):
            def put(self, position, output):
                positions.append(position)
                return super().put(position, output)
        class Stream:
            latency = (.01, .01)
            def __init__(self, **kwargs):
                self.callback = kwargs['callback']
                self.active = False
                self.done = threading.Event()
                streams.append(self)
            def start(self):
                self.active = True
                def pump():
                    while not self.done.is_set():
                        self.callback(np.zeros((3840, 1), np.float32), np.zeros((3840, 2), np.float32), 3840, None, False)
                        self.done.wait(.02)
                self.thread = threading.Thread(target=pump, daemon=True)
                self.thread.start()
            def abort(self):
                self.active = False
                self.done.set()
                self.thread.join(1)
            def close(self): pass
        available = [dict(id=1, name='mic', host='Windows WASAPI', inputs=1, outputs=0), dict(id=2, name='out', host='Windows WASAPI', inputs=0, outputs=2)]
        engine = Realtime(events.append)
        with patch('backend.direct_gpu.BeatricePipeline', Pipeline), patch('backend.realtime.ScheduledAudio', Schedule), patch('backend.realtime.devices', return_value=available), patch('backend.realtime.audio_settings', return_value=(None, None)), patch('sounddevice.query_devices', return_value={'max_output_channels': 2}), patch('sounddevice.Stream', Stream):
            try:
                engine.start({'input': 1, 'output': 2, 'singing_enabled': singing, 'singing_latency_ms': 400})
                self.assertTrue(first.wait(3), events)
                engine.update_controls(target, {'fx_enabled': singing, 'fx_compressor': 25, 'fx_reverb': 10})
                self.assertTrue(changed.wait(3), events)
                time.sleep(.03)
            finally:
                engine.stop()
                engine.thread.join(3)
        self.assertFalse(engine.thread.is_alive())
        self.assertEqual(len(pipelines), 1)
        self.assertEqual(len(streams), 1)
        self.assertEqual(pipelines[0].resets, 0)
        self.assertEqual(pipelines[0].controls, target)
        self.assertGreaterEqual(len(positions), 2)
        self.assertTrue(all(b-a == 3840 for a, b in zip(positions, positions[1:])), positions)
        running = next(event for event in events if event.get('state') == 'running')
        self.assertEqual((running['budget_ms'], running['schedule_ms']), (80, 315 if singing else 160))
        self.assertEqual(positions[0], (315 if singing else 160)*48)
        self.assertFalse(any(event['type'] == 'error' for event in events), events)

    def test_worker_routes_live_controls_over_json_pipe(self):
        worker = Path(__file__).resolve().parents[1]/'backend'/'worker.py'
        code = f"""
import sys, types, runpy
module = types.ModuleType('backend.realtime')
class Engine:
    thread = None
    def __init__(self, notify): self.notify = notify
    def update_controls(self, controls, effects=None): self.notify({{'type': 'applied', 'controls': controls, **({{'effects': effects}} if effects is not None else {{}})}})
    def stop(self): pass
module.Realtime = Engine
module.devices = lambda: []
sys.modules['backend.realtime'] = module
runpy.run_path({str(worker)!r}, run_name='__main__')
"""
        controls = {'beatrice_pitch': 2, 'beatrice_formant': -.5, 'input_gain': 4, 'gain': -6}
        effects = {'fx_enabled': True, 'fx_echo': 20}
        wire = '\n'.join(json.dumps(request) for request in ({'command': 'update-controls', 'controls': controls}, {'command': 'update-controls', 'controls': controls, 'effects': effects}, {'command': 'quit'}))+'\n'
        result = subprocess.run([sys.executable, '-I', '-c', code], input=wire, text=True, capture_output=True, encoding='utf8', timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        events = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(events[-2], {'type': 'applied', 'controls': controls})
        self.assertEqual(events[-1], {'type': 'applied', 'controls': controls, 'effects': effects})


if __name__ == '__main__':
    unittest.main()
