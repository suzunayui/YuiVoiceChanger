import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import torch
from backend.realtime import Realtime, model_cache_key
from backend.direct_gpu import BeatricePipeline


class ModelReuseTests(unittest.TestCase):
    def test_talk_singing_and_device_changes_keep_weights_and_measured_cpu_budget(self):
        models, warmups, streams, events = [], [], [], []
        running = threading.Event()

        class Model:
            device = torch.device('cpu')
            device_name = 'CPU'
            source_format = 'fixture'
            def __init__(self, *args): models.append(self)

        class Stream:
            latency = (.01, .01)
            def __init__(self, **kwargs): self.active=False;self.closed=False;streams.append(self)
            def start(self): self.active=True
            def abort(self): self.active=False
            def close(self): self.closed=True

        def warmup(pipeline, stop):
            warmups.append(pipeline.model)
            pipeline.restore_budget(.32)

        def notify(event):
            events.append(event)
            if event.get('state') == 'running': running.set()

        available = [dict(id=1,name='mic',host='Windows WASAPI',inputs=1,outputs=0),
            dict(id=2,name='out',host='Windows WASAPI',inputs=0,outputs=2),
            dict(id=3,name='other out',host='Windows WASAPI',inputs=0,outputs=2)]
        engine=Realtime(notify)
        with tempfile.TemporaryDirectory() as home, patch('backend.direct_gpu.DirectModel',Model), patch.object(BeatricePipeline,'warmup',warmup), patch('backend.realtime.devices',return_value=available), patch('backend.realtime.audio_settings',return_value=(None,None)), patch('sounddevice.query_devices',return_value={'max_output_channels':2}), patch('sounddevice.Stream',Stream):
            file=Path(home)/'voice.pt.gz';file.write_bytes(b'fixture')
            base=dict(beatrice_model=str(file),input=1,output=2,input_name='mic',output_name='out')

            def run(config, reused, expected_schedule):
                running.clear()
                beginning=len(events)
                try:
                    engine.start(config)
                    self.assertTrue(running.wait(3),events)
                finally:
                    engine.stop();engine.thread.join(3)
                self.assertFalse(engine.thread.is_alive())
                state=next(event for event in reversed(events) if event.get('state')=='running')
                self.assertEqual(state['model_reused'],reused)
                self.assertEqual(state['budget_ms'],320)
                self.assertEqual(state['schedule_ms'],expected_schedule)
                self.assertIs(engine.cached_model[1],models[-1])
                self.assertFalse(any(event['type']=='error' for event in events[beginning:]),events[beginning:])

            run(base,False,640)
            first_model=models[0]
            run({**base,'singing_enabled':True,'singing_latency_ms':1000,'beatrice_pitch':12,'beatrice_model_alias':'歌枠'},True,915)
            run({**base,'singing_enabled':False,'beatrice_pitch':1},True,640)
            run({**base,'output':3,'output_name':'other out'},True,640)
            self.assertEqual(len(models),1);self.assertEqual(len(warmups),1)
            self.assertIs(engine.cached_model[1],first_model)
            beginning=len(events)
            engine.start({**base,'singing_enabled':True,'singing_latency_ms':400});engine.thread.join(3)
            self.assertFalse(engine.thread.is_alive())
            self.assertTrue(any('固定遅延を' in event.get('message','') for event in events[beginning:]))
            run(base,True,640)
            self.assertEqual(len(models),1);self.assertEqual(len(warmups),1)
            file.write_bytes(b'new weights, same path')
            run(base,False,640)
            run({**base,'compute':'cpu'},False,640)
            run({**base,'compute':'cpu','beatrice_voice':1},False,640)
            self.assertEqual(len(models),4);self.assertEqual(len(warmups),4)
            self.assertTrue(all(stream.closed for stream in streams))

    def test_exported_weight_changes_invalidate_model_identity(self):
        with tempfile.TemporaryDirectory() as home:
            source=Path(home)/'voice.toml';source.write_text('fixture')
            weight=Path(home)/'net.bin';weight.write_bytes(b'old')
            config={'beatrice_model':str(source)}
            initial=model_cache_key(config)
            self.assertIsNotNone(initial)
            weight.write_bytes(b'changed weights')
            self.assertNotEqual(model_cache_key(config),initial)
            self.assertIsNone(model_cache_key({'beatrice_model':str(source.with_name('missing.pt.gz'))}))


if __name__=='__main__': unittest.main()
