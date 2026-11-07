"""Timestamped log lines that place a dropout: the PC, conversion, capture or after this app."""
from datetime import datetime
import math
import time

INTERVAL_SECONDS = 10
FLOOR_DB = -90.
# Counters that only grow; each report shows the change since the previous one.
COUNTERS = ('callback_late', 'voice_late_blocks', 'voice_missing_ms', 'dropped', 'device_errors', 'skipped_blocks')


def to_db(value):
    return 20*math.log10(value) if value > 10**(FLOOR_DB/20) else FLOOR_DB


class AudioDiagnostics:
    def __init__(self, write, now=time.monotonic, stamp=lambda: datetime.now().strftime('%Y-%m-%d %H:%M:%S')):
        self.write, self.now, self.stamp = write, now, stamp
        self.last_report = now()
        self.previous = {}
        self.clear_levels()

    def clear_levels(self):
        self.convert_max_ms = self.input_rms = self.voice_peak = self.convert_total_ms = self.effects_max_ms = 0.
        self.convert_count = self.over_budget = self.queue_max = 0

    def event(self, text):
        # Diagnostics must never interrupt audio, even when the log pipe has gone away.
        try:
            self.write(f'{self.stamp()} {text}')
        except (OSError, ValueError):
            pass

    def start(self, **values):
        self.event('Audio start: '+' '.join(f'{key}={value}' for key, value in values.items()))

    def observe(self, convert_ms, input_rms, voice_peak, effects_ms=0., queue_depth=0, budget_ms=None):
        self.convert_max_ms = max(self.convert_max_ms, convert_ms)
        self.convert_total_ms += convert_ms
        self.convert_count += 1
        self.over_budget += int(budget_ms is not None and convert_ms > budget_ms)
        self.effects_max_ms = max(self.effects_max_ms, effects_ms)
        self.queue_max = max(self.queue_max, queue_depth)
        self.input_rms = max(self.input_rms, input_rms)
        self.voice_peak = max(self.voice_peak, voice_peak)

    def due(self):
        return self.now()-self.last_report >= INTERVAL_SECONDS

    def delta(self, values, key):
        change = values.get(key, 0)-self.previous.get(key, 0)
        self.previous[key] = values.get(key, 0)
        return change

    def report(self, values, music_db=None):
        self.last_report = self.now()
        parts = [f'{key}={self.delta(values, key):.0f}' for key in COUNTERS[:1]]
        parts.append(f"largest_gap_ms={values.get('largest_gap_ms', 0):.0f}")
        parts += [f'{key}={self.delta(values, key):.0f}' for key in COUNTERS[1:]]
        average = self.convert_total_ms/self.convert_count if self.convert_count else 0.
        parts += [f'convert_avg_ms={average:.0f}', f'convert_max_ms={self.convert_max_ms:.0f}', f'over_budget={self.over_budget}',
                  f'effects_max_ms={self.effects_max_ms:.0f}', f'queue_max={self.queue_max}', f'input_peak_rms_db={to_db(self.input_rms):.0f}', f'voice_peak_db={to_db(self.voice_peak):.0f}']
        if music_db is not None:
            parts += [f"music_gaps={self.delta(values, 'music_gaps'):.0f}",
                      f"music_missing_ms={self.delta(values, 'music_missing_samples')/48:.0f}",
                      f"limited_ms={self.delta(values, 'limited_samples')/48:.0f}",
                      f'music_peak_db={music_db:.0f}']
        self.clear_levels()
        self.event('Audio report: '+' '.join(parts))
