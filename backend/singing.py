"""Small CPU pitch detector and hysteresis for automatic talking/singing shifts."""
import math
import numpy as np


class SingingSwitch:
    def __init__(self, talking_shift, threshold=300):
        self.talking_shift = float(talking_shift)
        self.threshold = float(threshold)
        if not math.isfinite(self.threshold) or not 150 <= self.threshold <= 900:
            raise ValueError('歌唱モードの切り替え音高は150〜900Hzです。')
        self.reset()

    def reset(self, preserve_mode=False):
        mode = getattr(self, 'mode', 'talking') if preserve_mode else 'talking'
        shift = getattr(self, 'shift', self.talking_shift) if preserve_mode else self.talking_shift
        self.history = np.zeros(384, np.float32)  # 48 ms of existing audio; no output buffering.
        self.mode = mode
        self.shift = shift
        self.high = self.low = self.unvoiced = 0.
        self.hz = None

    def detect(self, audio):
        samples = audio[::6]  # Transport blocks are multiples of 480 at 48k.
        self.history = np.concatenate((self.history, samples))[-384:]
        if len(samples) == 0 or np.sqrt(np.mean(samples*samples)) < .001:
            return None
        x = self.history.astype(np.float64)
        x -= np.mean(x)
        spectrum = np.fft.rfft(x, 1024)
        correlation = np.fft.irfft(spectrum * spectrum.conj(), 1024)[:len(x)]
        energy = np.concatenate(([0.], np.cumsum(x*x)))
        lags = np.arange(5, 124)  # ~65 to 1600 Hz.
        denom = np.sqrt((energy[len(x)-lags]) * (energy[-1]-energy[lags]))
        score = correlation[lags]/np.maximum(denom, 1e-12)
        peaks = np.flatnonzero((score[1:-1] > score[:-2]) & (score[1:-1] >= score[2:]))+1
        if not len(peaks) or np.max(score[peaks]) < .75:
            return None
        best = peaks[score[peaks] >= max(.75, .92*np.max(score[peaks]))][0]
        lag = float(lags[best])
        a, b, c = score[best-1:best+2]
        if abs(a-2*b+c) > 1e-12:
            lag += float(np.clip(.5*(a-c)/(a-2*b+c), -.5, .5))
        return 8000/lag

    def process(self, audio):
        seconds = len(audio)/48000
        self.hz = self.detect(audio)
        if self.hz is None:
            self.high = self.low = 0.
            previous_unvoiced = self.unvoiced
            self.unvoiced += seconds
            if previous_unvoiced < .4 <= self.unvoiced:
                self.history.fill(0)
        else:
            self.unvoiced = 0.
            self.high = self.high+seconds if self.hz >= self.threshold else 0.
            self.low = self.low+seconds if self.hz <= self.threshold*.8 else 0.
            if self.mode == 'talking' and self.high >= .08:
                self.mode = 'singing'
            elif self.mode == 'singing' and self.low >= .18:
                self.mode = 'talking'
        target = 0. if self.mode == 'singing' else self.talking_shift
        # A short ramp avoids a 14-semitone instantaneous jump.
        self.shift += float(np.clip(target-self.shift, -120*seconds, 120*seconds))
        return round(self.shift*8)/8
