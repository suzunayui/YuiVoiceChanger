import queue
import unittest

from backend.audio_diagnostics import AudioDiagnostics
from backend.realtime import catch_up_backlog

BLOCK, DELAY = 3840, 18000


def backlog(*sequences):
    incoming = queue.Queue(maxsize=4)
    for sequence in sequences:
        incoming.put((sequence, f'audio{sequence}'))
    return incoming


class CatchUpTests(unittest.TestCase):
    def test_on_time_block_is_converted_without_touching_the_queue(self):
        incoming = backlog(1, 2)
        result = catch_up_backlog(incoming, 0, 'audio0', BLOCK, DELAY, lambda: 0, 4800)
        self.assertEqual(result, (0, 'audio0', 0))
        self.assertEqual(incoming.qsize(), 2)

    def test_block_that_would_miss_its_slot_skips_to_the_first_one_that_can_make_it(self):
        incoming = backlog(1, 2, 3, 4)
        # Slots: seq 0 at 18000, 1 at 21840, 2 at 25680, 3 at 29520. Result takes 4800 samples.
        result = catch_up_backlog(incoming, 0, 'audio0', BLOCK, DELAY, lambda: 22000, 4800)
        # A result finishes at 26800, too late for seq 2 but in time for seq 3.
        self.assertEqual(result, (3, 'audio3', 3))
        self.assertEqual(incoming.qsize(), 1)

    def test_empty_queue_keeps_the_newest_block_even_if_late(self):
        incoming = backlog(1)
        result = catch_up_backlog(incoming, 0, 'audio0', BLOCK, DELAY, lambda: 100000, 4800)
        self.assertEqual(result, (1, 'audio1', 1))
        self.assertTrue(incoming.empty())

    def test_no_estimate_only_skips_blocks_already_past_their_slot(self):
        incoming = backlog(1)
        self.assertEqual(catch_up_backlog(incoming, 0, 'audio0', BLOCK, DELAY, lambda: 18000, 0)[2], 0)
        self.assertEqual(catch_up_backlog(incoming, 0, 'audio0', BLOCK, DELAY, lambda: 18001, 0)[2], 1)


class DetailedDiagnosticsTests(unittest.TestCase):
    def test_report_separates_average_budget_effects_queue_and_skips(self):
        lines = []
        diagnostics = AudioDiagnostics(lines.append, now=lambda: 0., stamp=lambda: 'now')
        diagnostics.observe(60, .1, .5, effects_ms=4, queue_depth=1, budget_ms=80)
        diagnostics.observe(100, .1, .5, effects_ms=9, queue_depth=3, budget_ms=80)
        diagnostics.report({'skipped_blocks': 5})
        line = lines[-1]
        for expected in ('skipped_blocks=5', 'convert_avg_ms=80', 'convert_max_ms=100', 'over_budget=1', 'effects_max_ms=9', 'queue_max=3'):
            self.assertIn(expected, line)
        diagnostics.report({'skipped_blocks': 5})
        for expected in ('skipped_blocks=0', 'convert_avg_ms=0', 'over_budget=0', 'effects_max_ms=0', 'queue_max=0'):
            self.assertIn(expected, lines[-1])


if __name__ == '__main__':
    unittest.main()
