import unittest
import numpy as np
from backend.direct_gpu import AlignedOverlap

OVERLAP, SEARCH = 960, 480


def candidates(block, count, slope_db=0., level=.1, silent=()):
    """Model output for each block: louder at its start than its end, as a long window gives.

    Consecutive candidates cover the same moment in their overlap, like real inference windows.
    """
    length = block+OVERLAP+SEARCH
    for index in range(count):
        t = (index*block+np.arange(length)-SEARCH//2)/48000
        gain = 10**(np.linspace(slope_db, 0, length)/20)
        # 1 kHz fits ten whole periods in each 10 ms frame, so frame levels measure the gain, not the phase.
        wave = level*np.sin(2*np.pi*1000*t)*gain
        yield (np.zeros(length) if index in silent else wave).astype(np.float32)


def block_shape(out, block):
    """Level at each 10 ms of a block, averaged over blocks: a swing at every seam shows here."""
    frames = out[block*4:][:len(out[block*4:])//480*480].reshape(-1, 480)
    level = 20*np.log10(np.sqrt(np.mean(frames**2, axis=1))+1e-12)
    per = block//480
    folded = level[:len(level)//per*per].reshape(-1, per).mean(axis=0)
    return folded.max()-folded.min()


def run(block, match=True, **options):
    joiner = AlignedOverlap(block, OVERLAP, SEARCH, fixed=True)
    joiner.match_level = match
    out = np.concatenate([joiner.join(candidate) for candidate in candidates(block, 24, **options)])
    return block_shape(out, block), out


class SeamLevelTests(unittest.TestCase):
    def test_longer_blocks_no_longer_swing_in_level_at_every_seam(self):
        for block in (7680, 11520, 19200):
            self.assertGreater(run(block, match=False, slope_db=1.5)[0], .8, block)
            self.assertLess(run(block, slope_db=1.5)[0], .2, block)

    def test_eighty_ms_keeps_its_sound(self):
        matched = AlignedOverlap(3840, OVERLAP, SEARCH, fixed=True)
        self.assertFalse(matched.match_level)

    def test_silence_and_extremes_do_not_pull_the_level(self):
        _, out = run(7680, slope_db=1.5, silent=(10,))
        self.assertTrue(np.isfinite(out).all())
        self.assertLess(float(np.max(np.abs(out))), .1*10**(3/20))
        joiner = AlignedOverlap(7680, OVERLAP, SEARCH, fixed=True)
        loud, quiet = next(candidates(7680, 1)), next(candidates(7680, 1))*.01
        joiner.join(loud)
        joiner.join(quiet)
        self.assertLessEqual(joiner.ratio, 2.)

    def test_reset_forgets_the_correction(self):
        joiner = AlignedOverlap(7680, OVERLAP, SEARCH, fixed=True)
        for candidate in candidates(7680, 6, slope_db=1.5):
            joiner.join(candidate)
        self.assertNotEqual(joiner.ratio, 1.)
        joiner.reset()
        self.assertEqual(joiner.ratio, 1.)


if __name__ == '__main__':
    unittest.main()
