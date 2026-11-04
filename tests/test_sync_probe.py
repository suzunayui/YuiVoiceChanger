import threading
import types
import unittest
import json
import shutil
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path
from unittest.mock import patch
import numpy as np
from backend.sync_probe import RATE, ONSETS, SampleClock, SyncProbe, test_signals, read_samples
from backend.obs_sync import analyze_probe, voice_onsets


def move(signal, seconds):
    amount = round(seconds*16000)
    return np.r_[np.zeros(amount), signal[:-amount]] if amount else signal.copy()


class SyncProbeTests(unittest.TestCase):
    def test_silent_probe_never_opens_a_playback_device(self):
        events, closed, ready = [], [], threading.Event()
        class NoAudioDevice:
            def __getattr__(self, name):
                raise AssertionError('silent measurement accessed an audio playback device: '+name)
        def notify(event):
            events.append(event)
            if event['phase']=='ready': ready.set()
        probe=SyncProbe('silent','',notify,closed.append,sd=NoAudioDevice(),silent=True)
        with patch('backend.sync_probe.DURATION',.08):
            probe.start();self.assertTrue(ready.wait(2))
            probe.align(time.monotonic())
            probe.input(480,types.SimpleNamespace(inputBufferAdcTime=5.,currentTime=5.),False)
            probe.thread.join(2)
        self.assertFalse(probe.thread.is_alive());self.assertEqual(closed,[probe])
        self.assertEqual(events[-1]['phase'],'completed')
        self.assertIsNone(probe.output_clock.origin)

    def test_silent_probe_cancel_waits_for_input_restoration(self):
        events,closed,ready=[],[],threading.Event()
        def notify(event):
            events.append(event)
            if event['phase']=='ready':ready.set()
        probe=SyncProbe('silent','',notify,closed.append,silent=True)
        probe.start();self.assertTrue(ready.wait(2));probe.stop();probe.thread.join(2)
        self.assertFalse(probe.thread.is_alive());self.assertEqual(closed,[probe])
        self.assertEqual(events[-1]['phase'],'cancelled')
        self.assertIsNone(probe.epoch)

    def test_silent_probe_rejects_stale_or_invalid_alignment(self):
        for epoch in (float('nan'),float('inf'),time.monotonic()-3,time.monotonic()+6):
            with self.subTest(epoch=epoch):
                probe=SyncProbe('silent','',lambda event:None,lambda probe:None,silent=True)
                with self.assertRaises(ValueError):probe.align(epoch)
                self.assertIsNone(probe.epoch)

    @unittest.skipUnless(shutil.which('ffmpeg'), 'ffmpeg is optional on test hosts')
    def test_isolated_analysis_decodes_a_real_two_track_aac_recording(self):
        voice, reference = test_signals(16000)
        with tempfile.TemporaryDirectory() as home:
            files = []
            for index, signal in enumerate((move(reference, .38), move(voice, .48))):
                file = Path(home)/f'{index}.wav';files.append(file)
                with wave.open(str(file), 'wb') as output:
                    output.setnchannels(1);output.setsampwidth(2);output.setframerate(16000)
                    output.writeframes(np.round(signal*32767).astype('<i2').tobytes())
            recording = Path(home)/'test.mkv'
            command = [shutil.which('ffmpeg'), '-nostdin', '-v', 'error', '-i', str(files[0]), '-i', str(files[1]), '-map', '0:a', '-map', '1:a', '-ar', '48000', '-c:a', 'aac', str(recording)]
            subprocess.run(command, check=True, capture_output=True, timeout=20)
            request = dict(mode='analyze-probe', ffmpeg=shutil.which('ffmpeg'), recording=str(recording), music_offset_ms=380, fixed_ms=380, correction_ms=0)
            script = Path(__file__).resolve().parents[1]/'backend'/'obs_sync.py'
            result = subprocess.run([sys.executable, '-I', '-u', str(script)], input=json.dumps(request)+'\n', text=True, capture_output=True, encoding='utf8', timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            event = json.loads(result.stdout)
            self.assertEqual(event['phase'], 'completed', event)
            self.assertEqual(event['matched'], 8)
            self.assertAlmostEqual(event['correction_ms'], 100, delta=12)

    @unittest.skipUnless(shutil.which('ffmpeg'), 'ffmpeg is optional on test hosts')
    def test_isolated_analysis_decodes_private_stereo_aac_track(self):
        voice,reference=test_signals(16000)
        with tempfile.TemporaryDirectory() as home:
            source=Path(home)/'stereo.wav';recording=Path(home)/'private.mkv'
            stereo=np.column_stack((move(reference,.44),move(voice,.48)))
            with wave.open(str(source),'wb') as output:
                output.setnchannels(2);output.setsampwidth(2);output.setframerate(16000)
                output.writeframes(np.round(stereo*32767).astype('<i2').tobytes())
            subprocess.run([shutil.which('ffmpeg'),'-nostdin','-v','error','-i',str(source),'-c:a','aac','-ar','48000',str(recording)],check=True,capture_output=True,timeout=20)
            request=dict(mode='analyze-stereo-probe',ffmpeg=shutil.which('ffmpeg'),recording=str(recording),music_offset_ms=440,fixed_ms=380,correction_ms=0)
            script=Path(__file__).resolve().parents[1]/'backend'/'obs_sync.py'
            result=subprocess.run([sys.executable,'-I','-u',str(script)],input=json.dumps(request)+'\n',text=True,capture_output=True,encoding='utf8',timeout=20)
            self.assertEqual(result.returncode,0,result.stderr)
            event=json.loads(result.stdout);self.assertEqual(event['phase'],'completed',event)
            self.assertEqual(event['matched'],8);self.assertAlmostEqual(event['correction_ms'],100,delta=12)

    def test_generated_voice_is_deterministic_bounded_and_nonperiodic(self):
        voice, reference = test_signals(16000)
        again, _ = test_signals(16000)
        np.testing.assert_array_equal(voice, again)
        self.assertLessEqual(float(np.max(np.abs(voice))), .081)
        self.assertLessEqual(float(np.max(np.abs(reference))), .121)
        self.assertEqual(len(voice_onsets(voice)), 8)
        self.assertGreater(np.ptp(np.diff(ONSETS)), .4)

    def test_analysis_aligns_injected_voice_across_obs_offsets_and_record_start(self):
        voice, reference = test_signals(16000)
        for delay, fixed, offset, recording_start in ((.48, 380, 380, 0), (.48, 380, 500, 1.1), (1.65, 1500, 1500, .2), (.25, 380, 380, .4)):
            beep = move(reference, offset/1000+recording_start)
            wet = move(voice, delay+recording_start)
            result = analyze_probe(beep, wet, offset, fixed, 0)
            self.assertEqual(result['method'], 'injected-voice')
            self.assertEqual(result['matched'], 8)
            self.assertAlmostEqual(result['voice_delay_ms'], delay*1000, delta=8)
            self.assertAlmostEqual(result['correction_ms'], delay*1000-fixed, delta=8)
            self.assertLess(result['spread_ms'], 6)

    def test_missing_noisy_or_wrong_sources_do_not_change_correction(self):
        voice, reference = test_signals(16000)
        for beep, wet in ((reference*0, move(voice, .48)), (move(reference, .38), voice*0), (move(reference, .38), voice), (move(reference, .38), np.ones_like(voice))):
            with self.subTest(case=id(wet)), self.assertRaises(ValueError):
                analyze_probe(beep, wet, 380 if np.any(beep) else 0, 380, 0)
        missing = voice.copy()
        for onset in ONSETS[:3]:
            missing[round(onset*16000):round((onset+.4)*16000)] = 0
        with self.assertRaises(ValueError):
            analyze_probe(move(reference, .38), move(missing, .48), 380, 380, 0)

    def test_adc_and_dac_clocks_use_same_epoch_with_different_host_origins(self):
        adc = SampleClock('inputBufferAdcTime', now=lambda: 100.)
        dac = SampleClock('outputBufferDacTime', now=lambda: 100.1)
        a = types.SimpleNamespace(inputBufferAdcTime=499.98, currentTime=500.)
        b = types.SimpleNamespace(outputBufferDacTime=900.02, currentTime=900.)
        self.assertEqual(adc.index(a, 480, 100.5), round(-.52*RATE))
        self.assertEqual(dac.index(b, 480, 100.5), round(-.38*RATE))
        a.inputBufferAdcTime += .01
        self.assertEqual(adc.index(a, 480, 100.5), round(-.51*RATE))
        with self.assertRaises(ValueError):
            adc.index(types.SimpleNamespace(inputBufferAdcTime=0, currentTime=500), 480, 100.5)
        np.testing.assert_array_equal(read_samples(np.ones(10), -4, 8), [0, 0, 0, 0, 1, 1, 1, 1])

    def test_injection_never_uses_microphone_and_cancel_silences_it(self):
        closed, events = [], []
        probe = SyncProbe('test', '', events.append, closed.append)
        probe.epoch = 100.
        probe.input_clock = SampleClock('inputBufferAdcTime', now=lambda: 101.8)
        timing = types.SimpleNamespace(inputBufferAdcTime=5., currentTime=5.)
        block = probe.input(4800, timing, False)
        self.assertTrue(np.any(block))
        probe.stop()
        np.testing.assert_array_equal(probe.input(4800, timing, False), np.zeros(4800))

    def test_output_failure_closes_stream_and_restores_input(self):
        class Output:
            latency = .01
            def __init__(self, **kwargs): self.closed = False
            def start(self): raise RuntimeError('fixture output unavailable')
            def abort(self): pass
            def close(self): self.closed = True
        output = Output()
        sd = types.SimpleNamespace(query_hostapis=lambda: [{'name': 'Windows WASAPI', 'default_output_device': 0}],
            query_devices=lambda index=None: [{'hostapi': 0, 'name': 'Output', 'max_output_channels': 2}] if index is None else {'max_output_channels': 2},
            WasapiSettings=lambda **kwargs: kwargs, OutputStream=lambda **kwargs: output)
        closed, events = [], []
        probe = SyncProbe('test', '', events.append, closed.append, sd=sd)
        probe.run()
        self.assertTrue(output.closed)
        self.assertEqual(closed, [probe])
        self.assertEqual(events[-1]['phase'], 'failed')
        self.assertIn('fixture', events[-1]['message'])

    def test_automatic_playback_feeds_both_clocks_then_restores_input(self):
        events, closed, captured = [], [], []
        probe = SyncProbe('test', '', events.append, closed.append)
        probe.input_clock = SampleClock('inputBufferAdcTime', now=lambda: 100.)
        probe.output_clock = SampleClock('outputBufferDacTime', now=lambda: 100.)
        class Output:
            latency = .01
            def __init__(self, **kwargs): self.callback = kwargs['callback'];self.closed = False
            def start(self):
                for frame in range(0, 16*RATE, 480):
                    t = frame/RATE
                    timing = types.SimpleNamespace(inputBufferAdcTime=200+t-.02, currentTime=200+t)
                    captured.append(probe.input(480, timing, False))
                    self.callback(np.zeros((480, 2), np.float32), 480,
                                  types.SimpleNamespace(outputBufferDacTime=500+t, currentTime=500+t), False)
            def abort(self): pass
            def close(self): self.closed = True
        outputs = []
        def create(**kwargs):
            output = Output(**kwargs);outputs.append(output);return output
        sd = types.SimpleNamespace(query_hostapis=lambda: [{'name': 'Windows WASAPI', 'default_output_device': 0}],
            query_devices=lambda index=None: [{'hostapi': 0, 'name': 'Output', 'max_output_channels': 2}] if index is None else {'max_output_channels': 2},
            WasapiSettings=lambda **kwargs: kwargs, OutputStream=create)
        probe.sd = sd
        with patch('backend.sync_probe.time.monotonic', return_value=100.):
            probe.run()
        self.assertEqual(events[-1]['phase'], 'completed')
        self.assertEqual(closed, [probe]);self.assertTrue(outputs[0].closed)
        self.assertGreater(float(np.max(np.abs(np.concatenate(captured)))), .01)


if __name__ == '__main__':
    unittest.main()
