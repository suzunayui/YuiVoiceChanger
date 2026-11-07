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
from backend.singing import latency_signature


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

    def test_mute_cuts_output_at_once_and_unmute_never_replays_muted_speech(self):
        output, positions = [], []
        pumped = threading.Event()
        class Pipeline:
            rate = 48000
            device_name = 'CPU'
            format = 'test'
            block = 3840
            config = {'block': .08}
            def __init__(self, config, notify): pass
            def warmup(self, stop): pass
            def reset(self): pass
            def set_controls(self, controls): pass
            def convert(self, audio):
                self.stats = {'ms': 1., 'lookback_ms': 65.}
                return np.full(self.block, .5, np.float32)
        class Stream:
            latency = (.01, .01)
            def __init__(self, **kwargs):
                self.callback = kwargs['callback']
                self.active = False
                self.done = threading.Event()
            def start(self):
                self.active = True
                def pump():
                    while not self.done.is_set():
                        out = np.zeros((480, 2), np.float32)
                        self.callback(np.zeros((480, 1), np.float32), out, 480, None, False)
                        output.append(float(np.abs(out).max()))
                        pumped.set()
                        self.done.wait(.002)
                self.thread = threading.Thread(target=pump, daemon=True)
                self.thread.start()
            def abort(self):
                self.active = False
                self.done.set()
                self.thread.join(1)
            def close(self): pass
        available = [dict(id=1, name='mic', host='Windows WASAPI', inputs=1, outputs=0), dict(id=2, name='out', host='Windows WASAPI', inputs=0, outputs=2)]
        def wait_for(condition):
            deadline = time.monotonic()+5
            while not condition() and time.monotonic() < deadline: time.sleep(.005)
            self.assertTrue(condition())
        events = []
        engine = Realtime(events.append)
        with self.assertRaises(ValueError): engine.set_muted('yes')
        with patch('backend.direct_gpu.BeatricePipeline', Pipeline), patch('backend.realtime.devices', return_value=available), patch('backend.realtime.audio_settings', return_value=(None, None)), patch('sounddevice.query_devices', return_value={'max_output_channels': 2}), patch('sounddevice.Stream', Stream):
            try:
                engine.start({'input': 1, 'output': 2})
                self.assertFalse(engine.muted)
                wait_for(lambda: output and max(output) > .4)
                engine.set_muted(True)
                # The queued voice is still scheduled; the next callback after the ramp is silent anyway.
                mark = len(output)
                wait_for(lambda: len(output) > mark+3)
                self.assertEqual(max(output[mark+2:]), 0.)
                with self.assertRaises(ValueError): engine.start_sync_test('0'*36)
                with self.assertRaises(ValueError): engine.start_passive_reference()
                # Hold the mute past the schedule so only muted conversions remain queued.
                mark = len(output)
                wait_for(lambda: len(output) > mark+120)
                engine.set_muted(False)
                mark = len(output)
                wait_for(lambda: max(output[mark:], default=0) > .4)
                self.assertGreaterEqual(len(output)-mark, 2, 'unmuting waits for audio converted after the mute ended')
            finally:
                engine.stop()
                engine.thread.join(3)
        self.assertFalse(any(event['type'] == 'error' for event in events), events)

    def test_start_can_begin_muted_for_preset_restarts(self):
        engine = Realtime(lambda event: None)
        with patch.object(threading.Thread, 'start', lambda self: None):
            engine.start({'muted': True})
        self.assertTrue(engine.muted)
        with patch.object(threading.Thread, 'start', lambda self: None):
            engine.thread = None
            engine.start({})
        self.assertFalse(engine.muted)

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

    def test_manual_total_reserves_processing_time_without_changing_total(self):
        self.exercise_stream(True, manual=True)

    def test_calibrated_stream_reserves_voice_arrival_at_obs_target(self):
        self.exercise_stream(True, manual=True, path_delay=139)

    def test_legacy_gpu_start_repairs_old_timing_before_stream_start(self):
        self.exercise_stream(True, legacy=True)

    def test_test_voice_replaces_and_restores_microphone_without_restarting(self):
        self.exercise_stream(False, inject=True)

    def exercise_stream(self, singing, manual=False, path_delay=0, legacy=False, inject=False):
        first, changed = threading.Event(), threading.Event()
        probe_seen, mic_restored = threading.Event(), threading.Event()
        pipelines, streams, positions, events = [], [], [], []
        target = normalize_controls({'beatrice_pitch': 3, 'beatrice_formant': .5, 'input_gain': 4, 'gain': -4})
        class Pipeline:
            rate = 48000
            device_name = 'GPU · Fixture' if legacy else 'CPU'
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
                if inject:
                    if np.all(audio == .125): probe_seen.set()
                    elif probe_seen.is_set() and np.all(audio == .25): mic_restored.set()
                first.set()
                if self.controls == target: changed.set()
                return np.zeros(self.block, np.float32)
        class Schedule(ScheduledAudio):
            def put(self, position, output):
                positions.append(position)
                return super().put(position, output)
        class Stream:
            latency = (.01, .045) if legacy else (.01, .01)
            def __init__(self, **kwargs):
                self.callback = kwargs['callback']
                self.active = False
                self.done = threading.Event()
                streams.append(self)
            def start(self):
                self.active = True
                def pump():
                    while not self.done.is_set():
                        self.callback(np.full((3840, 1), .25 if inject else 0., np.float32), np.zeros((3840, 2), np.float32), 3840, None, False)
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
                config = {'input': 1, 'output': 2, 'singing_enabled': singing, 'singing_latency_ms': 200 if manual else 400,
                          'obs_correction_ms': 300 if manual else 0, 'obs_delay_manual': manual}
                if legacy:
                    config.update(singing_latency_ms=200, obs_correction_ms=690, compute='cuda:0')
                if path_delay:
                    config.update(obs_path_delay_ms=path_delay, obs_path_signature=latency_signature(config))
                engine.start(config)
                self.assertTrue(first.wait(3), events)
                if inject:
                    class Probe:
                        def input(self, frames, timing, status): return np.full(frames, .125, np.float32)
                        def stop(self): pass
                        thread = type('Thread', (), {'join': lambda self, timeout=None: None})()
                    probe = Probe();engine.sync_probe = probe
                    self.assertTrue(probe_seen.wait(3), events)
                    engine._probe_closed(probe)
                    self.assertTrue(mic_restored.wait(3), events)
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
        schedule = 260 if legacy else 415-path_delay if manual else 315 if singing else 160
        self.assertEqual((running['budget_ms'], running['schedule_ms']), (80, schedule))
        self.assertEqual(positions[0], schedule*48)
        if manual:
            self.assertEqual(running['manual_timing'], dict(previous_base_ms=200, previous_correction_ms=300,
                                                          singing_latency_ms=500-path_delay, obs_correction_ms=path_delay))
            self.assertEqual(running['schedule_ms']+65+running['io_latency_ms']+path_delay, 500)
        if legacy:
            self.assertEqual(running['manual_timing'], dict(legacy_timing=True, previous_base_ms=200,
                                                          previous_correction_ms=690, singing_latency_ms=380, obs_correction_ms=0))
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
