import unittest

from backend.audio_diagnostics import AudioDiagnostics


class AudioDiagnosticsTests(unittest.TestCase):
    def make(self):
        self.lines = []
        self.time = 100.
        return AudioDiagnostics(self.lines.append, now=lambda: self.time, stamp=lambda: '2026-11-07 20:00:00')

    def test_start_line_records_the_settings_needed_to_read_the_log(self):
        self.make().start(input='MOTU', output='CABLE Input', singing=True, mix=True, input_gain=12, gain=0, music_gain=-6, buffer_ms=230, timing_io_ms=54, target_ms=500)
        self.assertEqual(self.lines, ['2026-11-07 20:00:00 Audio start: input=MOTU output=CABLE Input singing=True mix=True input_gain=12 gain=0 music_gain=-6 buffer_ms=230 timing_io_ms=54 target_ms=500'])

    def test_report_is_due_every_ten_seconds(self):
        diagnostics = self.make()
        self.assertFalse(diagnostics.due())
        self.time += 9.9
        self.assertFalse(diagnostics.due())
        self.time += .2
        self.assertTrue(diagnostics.due())
        diagnostics.report({})
        self.assertFalse(diagnostics.due())

    def test_counters_are_per_report_and_levels_reset(self):
        diagnostics = self.make()
        diagnostics.observe(20, .1, .5)
        diagnostics.observe(45.4, .01, .25)
        diagnostics.report(dict(callback_late=3, largest_gap_ms=44.6, voice_late_blocks=1, voice_missing_ms=80, dropped=0, device_errors=0))
        line = self.lines[-1]
        self.assertIn('Audio report: callback_late=3 largest_gap_ms=45 voice_late_blocks=1 voice_missing_ms=80 dropped=0 device_errors=0', line)
        self.assertIn('convert_max_ms=45', line)
        self.assertIn('input_peak_rms_db=-20', line)
        self.assertIn('voice_peak_db=-6', line)
        diagnostics.report(dict(callback_late=3, largest_gap_ms=0, voice_late_blocks=4, voice_missing_ms=80, dropped=0, device_errors=0))
        line = self.lines[-1]
        self.assertIn('callback_late=0 largest_gap_ms=0 voice_late_blocks=3 voice_missing_ms=0', line)
        self.assertIn('convert_max_ms=0', line)
        self.assertIn('input_peak_rms_db=-90', line)

    def test_mix_values_appear_only_during_mix(self):
        diagnostics = self.make()
        diagnostics.report({'callback_late': 0})
        self.assertNotIn('music_', self.lines[-1])
        diagnostics.report({'callback_late': 0, 'music_gaps': 2, 'music_missing_samples': 4800, 'limited_samples': 480}, music_db=-24.4)
        self.assertIn('music_gaps=2 music_missing_ms=100 limited_ms=10 music_peak_db=-24', self.lines[-1])
        diagnostics.report({'callback_late': 0, 'music_gaps': 2, 'music_missing_samples': 4800, 'limited_samples': 480}, music_db=-90.)
        self.assertIn('music_gaps=0 music_missing_ms=0 limited_ms=0 music_peak_db=-90', self.lines[-1])

    def test_a_broken_log_never_stops_the_audio(self):
        def broken(line):
            raise OSError('closed')
        diagnostics = AudioDiagnostics(broken)
        diagnostics.start(input='mic')
        diagnostics.report({})
        diagnostics.event('MIX clock: jumps=1')


if __name__ == '__main__':
    unittest.main()
