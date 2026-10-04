import struct
import unittest

import numpy as np

from backend.beatrice import BeatricePipeline, component_state, preset_bytes


class BeatriceTests(unittest.TestCase):
    def test_vst_preset_chunk_bounds_and_unicode_model(self):
        component = component_state('声/milk.toml', 12, 72.5)
        data = preset_bytes(component)
        self.assertEqual(data[:4], b'VST3')
        offset = struct.unpack_from('<q', data, 40)[0]
        self.assertEqual(data[offset:offset+4], b'List')
        count, tag, start, size = struct.unpack_from('<i4sqq', data, offset+4)
        self.assertEqual((count, tag, start, size), (1, b'Comp', 48, len(component)))
        self.assertEqual(struct.unpack_from('<i', component)[0], len(component)-4)
        self.assertIn('声'.encode('utf-8'), data)

    def test_silence_is_processed_without_reset_or_gate(self):
        class Plugin:
            def process(self, audio, rate, **kwargs):
                self.call = (audio, rate, kwargs)
                return np.full_like(audio, .02)
        p = BeatricePipeline.__new__(BeatricePipeline)
        p.plugin = Plugin()
        p.gain = 1
        result = p.convert(np.zeros(1920, np.float32))
        self.assertEqual(p.plugin.call[1], 48000)
        self.assertFalse(p.plugin.call[2]['reset'])
        np.testing.assert_allclose(result, .02)
        self.assertTrue(p.stats['silent'])

    def test_clarity_precedes_gate_and_output_clipping(self):
        class Plugin:
            def process(self, audio, rate, **kwargs):
                return np.full_like(audio, .4)
        class EQ:
            def process(self, audio, rate, **kwargs):
                self.reset_requested = kwargs['reset']
                return audio * 2
        class Gate:
            def process(self, output, source):
                np.testing.assert_allclose(output, .8)
                return output * .5
        p = BeatricePipeline.__new__(BeatricePipeline)
        p.plugin, p.clarity, p.envelope = Plugin(), EQ(), Gate()
        p.noise_filter, p.gain = True, 3
        result = p.convert(np.zeros(480, np.float32))
        self.assertFalse(p.clarity.reset_requested)
        self.assertEqual(p.stats['clip'], 1)
        np.testing.assert_allclose(result, 1)
