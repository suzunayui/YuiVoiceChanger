import types
import unittest
import numpy as np
from backend.direct_gpu import BeatricePipeline


class FakeModel:
    """Returns silence of the right length at 24 kHz; cost does not matter here."""
    def __init__(self, device='cuda'):
        self.device = types.SimpleNamespace(type=device)
        self.device_name = device
        self.source_format = 'fake'

    def infer(self, audio16k, shift=14., formant=0., seed=42, excitation_state=None):
        return np.zeros(len(audio16k)*3//2, np.float32)


class Stop:
    def is_set(self):
        return False


def pipeline(device='cuda', **config):
    return BeatricePipeline({'beatrice_model': 'x', **config}, model=FakeModel(device))


class SingingBlockTests(unittest.TestCase):
    def test_singing_uses_the_chosen_interval_on_gpu(self):
        for block_ms in (80, 160, 240, 320, 400):
            converter = pipeline(singing_enabled=True, singing_block_ms=block_ms)
            converter.warmup(Stop())
            self.assertEqual((converter.config['block'], converter.block), (block_ms/1000, block_ms*48))
            self.assertEqual(len(converter.convert(np.zeros(converter.block, np.float32))), block_ms*48)
            self.assertEqual(converter.measured_block, .08, 'the cache keeps what the hardware needs')

    def test_normal_mode_ignores_the_singing_interval(self):
        converter = pipeline(singing_enabled=False, singing_block_ms=320)
        converter.warmup(Stop())
        self.assertEqual(converter.block, 3840)

    def test_a_reused_model_still_follows_the_current_interval(self):
        converter = pipeline(singing_enabled=True, singing_block_ms=240)
        converter.restore_budget(.08)
        self.assertEqual(converter.block, 240*48)
        self.assertEqual(converter.measured_block, .08)
        slower = pipeline(singing_enabled=True, singing_block_ms=160)
        slower.restore_budget(.32)
        self.assertEqual(slower.block, 320*48, 'a slow CPU keeps the longer interval it needs')

    def test_cpu_keeps_the_longer_of_its_own_and_the_chosen_interval(self):
        converter = pipeline('cpu', singing_enabled=True, singing_block_ms=400)
        converter.warmup(Stop())
        self.assertEqual(converter.block, 400*48)
        self.assertLessEqual(converter.measured_block, .4)

    def test_invalid_intervals_are_refused(self):
        for value in (0, 40, 100, 480, 160.5, '160', True):
            with self.assertRaises(ValueError, msg=value):
                pipeline(singing_enabled=True, singing_block_ms=value)


if __name__ == '__main__':
    unittest.main()
