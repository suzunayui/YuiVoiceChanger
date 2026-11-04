import unittest
import numpy as np
import torch

from backend.streaming_excitation import StreamingExcitation
from backend.beatrice_model import generate_noise
from backend.direct_gpu import BeatricePipeline
from backend.singing import output_schedule


class StreamingExcitationTests(unittest.TestCase):
    def test_sliding_pitch_phase_matches_same_absolute_samples(self):
        for advance in (1920, 7680, 15360):
            with self.subTest(advance=advance):
                state = StreamingExcitation(advance, advance + 1200)
                time = torch.arange(76800 + 3*advance, dtype=torch.float64) / 24000
                frequency = (173 + 8*torch.sin(2*torch.pi*5*time)) / 24000
                previous = None
                for offset in range(0, 3*advance, advance):
                    phase = state.phase(frequency[offset:offset+76800][None])
                    if previous is not None:
                        difference = phase[:, :-advance] - previous[:, advance:]
                        circular_error = (difference + .5).remainder(1.) - .5
                        self.assertLess(circular_error.abs().max().item(), 2e-6)
                    previous = phase

    def test_noise_is_continuous_in_absolute_time_not_repeated_per_block(self):
        state = StreamingExcitation(1920, 3120)
        amplitude = torch.full((1, 240, 320), .1)
        previous = None
        for _ in range(4):
            noise, excitation = generate_noise(amplitude, excitation_state=state)
            self.assertEqual(noise.shape, (1, 76800))
            self.assertTrue(torch.isfinite(noise).all())
            if previous is not None:
                torch.testing.assert_close(noise[:, 240:-1920], previous[:, 2160:], rtol=0, atol=1e-7)
                self.assertFalse(torch.equal(excitation[:, -1920:], excitation[:, -3840:-1920]))
            previous = noise

    def test_fixed_pipeline_held_note_has_no_periodic_crossfade_dips(self):
        class ToneModel:
            device = torch.device('cpu')
            device_name = 'CPU'
            source_format = 'test held note'

            def infer(self, audio, excitation_state=None, **kwargs):
                normalized = torch.full((1, len(audio)*3//2), 173/24000)
                phase = excitation_state.phase(normalized) if excitation_state is not None else normalized.double().cumsum(1).float().remainder(1.)
                return (.2*torch.sin(2*torch.pi*phase))[0].numpy()

        pipeline = BeatricePipeline(dict(singing_enabled=True, input_gain=0, gain=0), model=ToneModel())
        parts = []
        for _ in range(30):
            parts.append(pipeline.convert(np.zeros(pipeline.block, np.float32)))
            self.assertEqual(pipeline.stats['lookback_ms'], 65)
            self.assertEqual(pipeline.stats['alignment_ms'], 5)
            self.assertEqual(len(parts[-1]), 3840)
        audio = np.concatenate(parts)[48000:]
        frames = np.lib.stride_tricks.sliding_window_view(audio, 960)[::120]
        envelope = np.sqrt(np.mean(frames*frames, axis=1))
        self.assertGreater(envelope.min(), .13)
        self.assertLess(envelope.max(), .151)
        for target in (380, 500, 1000):
            reservation = output_schedule(dict(singing_enabled=True, singing_latency_ms=target), 80, pipeline.fixed_lookback_ms, 20)
            self.assertEqual(reservation + pipeline.stats['lookback_ms'] + 20, target)

        old_state = pipeline.excitation_state
        pipeline.restore_budget(.32)
        self.assertIsNot(pipeline.excitation_state, old_state)
        self.assertIsNone(pipeline.excitation_state.previous_phase)
        pipeline.convert(np.zeros(pipeline.block, np.float32))
        self.assertEqual(pipeline.stats['lookback_ms'], 65)
        self.assertEqual(pipeline.excitation_state.advance, 7680)


if __name__ == '__main__':
    unittest.main()
