import unittest
import numpy as np
from backend.singing import SingingSwitch


class SingingTests(unittest.TestCase):
    def feed(self, switch, hz, seconds=.5):
        for start in range(0, round(seconds*48000), 480):
            t=(np.arange(480)+start)/48000
            # Include strong overtones, as real voice is not a pure sine.
            audio=(.15*np.sin(2*np.pi*hz*t)+.07*np.sin(4*np.pi*hz*t)).astype(np.float32)
            switch.process(audio)

    def test_high_and_low_voice_switch_and_keep_original_talking_shift(self):
        s=SingingSwitch(14)
        self.feed(s,150)
        self.assertEqual((s.mode,s.shift),('talking',14))
        self.feed(s,500)
        self.assertEqual((s.mode,s.shift),('singing',0))
        self.assertAlmostEqual(s.hz,500,delta=8)
        self.feed(s,150)
        self.assertEqual((s.mode,s.shift),('talking',14))

    def test_boundary_silence_and_noise_hold_singing_until_low_voice(self):
        s=SingingSwitch(14)
        self.feed(s,500)
        self.feed(s,270)
        self.assertEqual(s.mode,'singing')
        for _ in range(200):s.process(np.zeros(480,np.float32))
        rng=np.random.default_rng(42)
        for _ in range(100):s.process(rng.normal(0,.05,480).astype(np.float32))
        self.assertEqual((s.mode,s.shift),('singing',0))
        self.feed(s,150,.08)
        self.assertEqual(s.mode,'singing')
        self.feed(s,150,.5)
        self.assertEqual((s.mode,s.shift),('talking',14))

    def test_audio_discontinuity_reset_preserves_singing(self):
        s=SingingSwitch(14)
        self.feed(s,500)
        s.reset(preserve_mode=True)
        self.assertEqual((s.mode,s.shift),('singing',0))
        self.feed(s,150)
        self.assertEqual((s.mode,s.shift),('talking',14))

    def test_unvoiced_noise_does_not_activate_singing(self):
        s=SingingSwitch(14)
        rng=np.random.default_rng(42)
        for _ in range(100):s.process(rng.normal(0,.05,480).astype(np.float32))
        self.assertEqual(s.mode,'talking')

    def test_short_high_note_does_not_switch_and_changes_are_bounded(self):
        s=SingingSwitch(14)
        self.feed(s,500,.05)
        self.assertEqual(s.mode,'talking')
        old=s.shift
        for start in range(0,24000,480):
            s.process((.1*np.sin(2*np.pi*500*(np.arange(480)+start)/48000)).astype(np.float32))
            self.assertLessEqual(abs(s.shift-old),1.201)
            old=s.shift
        self.assertEqual(s.shift,0)
