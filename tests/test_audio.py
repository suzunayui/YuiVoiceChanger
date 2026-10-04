import unittest
import numpy as np
from backend.realtime import AudioFIFO

class AudioTests(unittest.TestCase):
    def test_fifo_bounds_and_zero_underflow(self):
        fifo=AudioFIFO(10)
        fifo.put(np.ones(8));fifo.put(np.full(6,2))
        self.assertEqual(fifo.size,6)
        self.assertEqual(fifo.dropped,1)
        out,written=fifo.take(10)
        self.assertEqual(written,6)
        np.testing.assert_array_equal(out,np.array([2]*6+[0]*4))
        self.assertEqual(fifo.size,0)

    def test_fifo_partial_read_preserves_order(self):
        fifo=AudioFIFO(20)
        fifo.put(np.arange(7));fifo.put(np.arange(7,12))
        np.testing.assert_array_equal(fifo.take(5)[0],np.arange(5))
        np.testing.assert_array_equal(fifo.take(7)[0],np.arange(5,12))

    def test_oversized_block_remains_bounded(self):
        fifo=AudioFIFO(5);fifo.put(np.arange(20))
        self.assertEqual(fifo.size,5)
        np.testing.assert_array_equal(fifo.take(5)[0],np.arange(15,20))
