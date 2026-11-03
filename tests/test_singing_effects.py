import math
import copy
import unittest
import numpy as np
from backend.vocal_effects import VocalEffects, EFFECT_DEFAULTS, normalize_effects
from backend.singing import singing_settings, output_schedule
from backend.direct_gpu import AlignedOverlap
from backend.scheduled_audio import ScheduledAudio


def render(audio, settings, sizes=(3840,)):
    processor = VocalEffects()
    config = {**EFFECT_DEFAULTS, 'fx_enabled': True, 'fx_lowcut': 0, 'fx_limiter': False, **settings}
    processor.process(np.zeros(480, np.float32), config)
    parts, offset, index = [], 0, 0
    while offset < len(audio):
        count = sizes[index % len(sizes)]
        parts.append(processor.process(audio[offset:offset+count], config))
        offset += count
        index += 1
    return np.concatenate(parts)


class SingingEffectsTests(unittest.TestCase):
    def test_disabled_is_bit_exact_and_validation_is_strict(self):
        source = np.random.default_rng(2).uniform(-1, 1, 3840).astype(np.float32)
        np.testing.assert_array_equal(VocalEffects().process(source, EFFECT_DEFAULTS), source)
        for change in ({'fx_enabled': 1}, {'fx_lowcut': -1}, {'fx_echo_ms': 0}, {'fx_reverb': 51}, {'fx_brightness': float('nan')}, {'fx_compressor': True}, {'fx_echo': .5}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                normalize_effects(change)
        for config in ({'singing_enabled': 1}, {'singing_latency_ms': 199}, {'singing_latency_ms': float('inf')}, {'singing_latency_ms': 400.5}):
            with self.assertRaises(ValueError): singing_settings(config)

    def test_fixed_clock_accounts_for_latency_and_rejects_impossible_targets(self):
        config = dict(singing_enabled=True, singing_latency_ms=400)
        schedule = output_schedule(config, 80, 65, 20)
        self.assertEqual(schedule, 315)
        self.assertEqual(schedule+65+20, 400)
        self.assertEqual(output_schedule({}, 320, 65, 20), 640)
        with self.assertRaisesRegex(ValueError, '730ms以上'):
            output_schedule(config, 320, 65, 20)
        buffer = ScheduledAudio()
        block, delay = 3840, round(schedule*48)
        expected = np.zeros(40000, np.float32)
        jobs = []
        for seq, duration in enumerate((5, 120, 30, 150, 10)):
            audio = np.full(block, .1*(seq+1), np.float32)
            jobs.append(((seq+1)*block+duration*48, seq*block+delay, audio))
            expected[seq*block+delay:seq*block+delay+block] = audio
        jobs.sort(key=lambda item: item[0])
        actual = []
        for now in range(0, 40000, 400):
            while jobs and jobs[0][0] <= now:
                _, position, audio = jobs.pop(0)
                buffer.put(position, audio)
            actual.append(buffer.take(400))
        np.testing.assert_array_equal(np.concatenate(actual), expected)

    def test_fixed_alignment_keeps_same_source_position(self):
        align = AlignedOverlap(3840, fixed=True)
        random = np.random.default_rng(4)
        for _ in range(15):
            align.join(random.normal(0, .1, 5280).astype(np.float32))
            self.assertEqual(align.last_shift, 240)

    def test_filters_compressor_and_deesser_have_expected_effect(self):
        t = np.arange(48000, dtype=np.float32)/48000
        rms = lambda data: float(np.sqrt(np.mean(data[24000:]**2)))
        low = .2*np.sin(2*math.pi*30*t)
        high = .2*np.sin(2*math.pi*9000*t)
        mid = .2*np.sin(2*math.pi*800*t)
        self.assertLess(rms(render(low, {'fx_lowcut': 120})), rms(low)*.15)
        self.assertGreater(rms(render(high, {'fx_brightness': 6})), rms(high)*1.6)
        loud = .8*np.sin(2*math.pi*800*t)
        self.assertLess(rms(render(loud, {'fx_compressor': 100})), rms(loud)*.5)
        self.assertLess(rms(render(high, {'fx_deesser': 100})), rms(high)*.7)
        self.assertGreater(rms(render(mid, {'fx_deesser': 100})), rms(mid)*.9)

    def test_echo_timing_tails_and_chunk_boundaries(self):
        impulse = np.zeros(96000, np.float32)
        impulse[0] = .5
        settings = {'fx_echo': 40, 'fx_echo_ms': 125}
        one = render(impulse, settings, (96000,))
        split = render(impulse, settings, (480, 3840, 30720, 173))
        np.testing.assert_allclose(one, split, atol=1e-7)
        self.assertEqual(one[0], .5)
        self.assertAlmostEqual(float(one[6000]), .2)
        self.assertAlmostEqual(float(one[12000]), .064)
        reverb = render(impulse, {'fx_reverb': 50})
        self.assertGreater(float(np.sum(reverb[1000:24000]**2)), .001)
        self.assertLess(float(np.sum(reverb[72000:]**2)), float(np.sum(reverb[24000:48000]**2)))

    def test_full_chain_is_finite_bounded_and_streaming(self):
        source = np.random.default_rng(3).normal(0, .7, 96000).astype(np.float32)
        settings = dict(fx_lowcut=200, fx_brightness=6, fx_compressor=100, fx_deesser=100, fx_reverb=50, fx_echo=50, fx_echo_ms=80, fx_limiter=True)
        one = render(source, settings, (96000,))
        split = render(source, settings, (480, 3840, 30720, 173))
        self.assertTrue(np.isfinite(split).all())
        self.assertLessEqual(float(np.max(np.abs(split))), .981)
        np.testing.assert_allclose(one, split, atol=1e-6)
        processor = VocalEffects()
        config = {**EFFECT_DEFAULTS, **settings, 'fx_enabled': True}
        processor.process(source[:3840], config)
        processor.process(source[:3840], {**config, 'fx_enabled': False})
        np.testing.assert_array_equal(processor.process(source[:3840], EFFECT_DEFAULTS), source[:3840])

    def test_live_parameter_edits_crossfade_the_same_input_without_shifting_it(self):
        processor = VocalEffects()
        t = np.arange(3840, dtype=np.float32)/48000
        source = .1*np.sin(2*math.pi*1000*t)
        initial = {**EFFECT_DEFAULTS, 'fx_enabled': True, 'fx_lowcut': 0, 'fx_limiter': False}
        processor.process(source, initial)
        previous, changed = copy.deepcopy(processor), copy.deepcopy(processor)
        next_config = {**initial, 'fx_brightness': 6, 'fx_reverb': 20, 'fx_echo_ms': 375}
        expected_old = previous._process(source, initial)
        expected_new = changed._process(source, next_config)
        output = processor.process(source, next_config)
        self.assertEqual(len(output), len(source))
        self.assertEqual(output[0], expected_old[0])
        np.testing.assert_allclose(output[480:], expected_new[480:], atol=1e-7)


if __name__ == '__main__': unittest.main()
