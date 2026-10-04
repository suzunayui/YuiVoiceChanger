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
