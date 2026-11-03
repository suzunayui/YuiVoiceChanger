"""Stateful, causal vocal effects at 48 kHz. No plugin host or lookahead."""
import math
import copy
import numpy as np

EFFECT_DEFAULTS = dict(fx_enabled=False, fx_lowcut=80, fx_brightness=0,
    fx_compressor=0, fx_deesser=0, fx_reverb=0, fx_echo=0, fx_echo_ms=250, fx_limiter=True)
EFFECT_RANGES = dict(fx_lowcut=(0, 200), fx_brightness=(-6, 6), fx_compressor=(0, 100),
    fx_deesser=(0, 100), fx_reverb=(0, 50), fx_echo=(0, 50), fx_echo_ms=(80, 1000))


def normalize_effects(values):
    if not isinstance(values, dict):
        raise ValueError('エフェクト設定の形式が正しくありません。')
    result = {}
    for key, default in EFFECT_DEFAULTS.items():
        value = values.get(key, default)
        if type(default) is bool:
            valid = type(value) is bool
        else:
            low, high = EFFECT_RANGES[key]
            valid = type(value) in (int, float) and math.isfinite(value) and value == int(value) and low <= value <= high
        if not valid:
            raise ValueError(f'エフェクト設定の値が範囲外です: {key}')
        result[key] = value
    return result


class Biquad:
    def __init__(self):
        self.z1 = self.z2 = 0.

    def process(self, audio, frequency, gain=None):
        w = 2 * math.pi * frequency / 48000
        c, s = math.cos(w), math.sin(w)
        if gain is None:  # Butterworth high-pass
            alpha = s / math.sqrt(2)
            b0, b1, b2 = (1+c)/2, -(1+c), (1+c)/2
            a0, a1, a2 = 1+alpha, -2*c, 1-alpha
        else:  # high shelf, unity at DC
            a = 10**(gain/40)
            alpha = s / math.sqrt(2)
            t = 2 * math.sqrt(a) * alpha
            b0 = a*((a+1)+(a-1)*c+t)
            b1 = -2*a*((a-1)+(a+1)*c)
            b2 = a*((a+1)+(a-1)*c-t)
            a0 = (a+1)-(a-1)*c+t
            a1 = 2*((a-1)-(a+1)*c)
            a2 = (a+1)-(a-1)*c-t
        b0, b1, b2, a1, a2 = (v/a0 for v in (b0, b1, b2, a1, a2))
        output = np.empty(len(audio), np.float32)
        z1, z2 = self.z1, self.z2
        for i, sample in enumerate(audio.tolist()):
            y = b0*sample+z1
            z1, z2 = b1*sample-a1*y+z2, b2*sample-a2*y
            output[i] = y
        self.z1, self.z2 = z1, z2
        return output


class Delay:
    def __init__(self, length):
        self.buffer = np.zeros(length, np.float32)
        self.cursor = 0

    def process(self, audio, feedback, allpass=False):
        output = np.empty_like(audio)
        offset = 0
        while offset < len(audio):
            count = min(len(audio)-offset, len(self.buffer)-self.cursor)
            source = audio[offset:offset+count]
            slot = self.buffer[self.cursor:self.cursor+count]
            delayed = slot.copy()
            y = delayed-feedback*source if allpass else delayed
            slot[:] = source+feedback*y
            output[offset:offset+count] = y
            self.cursor = (self.cursor+count) % len(self.buffer)
            offset += count
        return output


class VocalEffects:
    def __init__(self):
        self.reset()
        self.last_config = None

    def reset(self):
        self.lowcut, self.shelf, self.sibilance = Biquad(), Biquad(), Biquad()
        self.compressor_envelope = self.deesser_envelope = 0.
        self.combs = [Delay(n) for n in (1499, 1999, 2381, 2797)]
        self.diffusers = [Delay(n) for n in (223, 557)]
        self.echo, self.echo_ms = None, None
        self.mix = 0.
        self.peak = 0.

    def process(self, audio, settings):
        config = normalize_effects(settings)
        dry = np.asarray(audio, np.float32).reshape(-1)
        if not np.isfinite(dry).all():
            raise ValueError('有限値の音声が必要です。')
        # Crossfade parameter edits using the previous state; do not splice delay
        # taps or filter coefficients abruptly in the middle of a held note.
        previous = copy.deepcopy(self) if self.last_config and config != self.last_config and config['fx_enabled'] and self.last_config['fx_enabled'] else None
        output = self._process(dry, config)
        if previous is not None:
            baseline = previous._process(dry, self.last_config)
            count = min(480, len(dry))
            blend = np.linspace(0, 1, count, dtype=np.float32)
            output[:count] = baseline[:count]*(1-blend)+output[:count]*blend
        self.last_config = config
        return output

    def _process(self, dry, config):
        if not config['fx_enabled'] and self.mix == 0:
            self.peak = float(np.max(np.abs(dry))) if len(dry) else 0.
            return dry
        output = dry.copy()
        if config['fx_lowcut']:
            output = self.lowcut.process(output, config['fx_lowcut'])
        if config['fx_brightness']:
            output = self.shelf.process(output, 3000, config['fx_brightness'])
        compressor, deesser = config['fx_compressor']/100, config['fx_deesser']/100
        if compressor or deesser:
            high = self.sibilance.process(output, 4500) if deesser else np.zeros_like(output)
            attack, release = math.exp(-1/(48000*.005)), math.exp(-1/(48000*.12))
            envelope, sibilance = self.compressor_envelope, self.deesser_envelope
            threshold, ratio = -12-18*compressor, 1+3*compressor
            for i, (sample, hiss) in enumerate(zip(output.tolist(), high.tolist())):
                peak = abs(sample)
                coefficient = attack if peak > envelope else release
                envelope = coefficient*envelope+(1-coefficient)*peak
                coefficient = attack if abs(hiss) > sibilance else release
                sibilance = coefficient*sibilance+(1-coefficient)*abs(hiss)
                reduction = max(0., 20*math.log10(max(envelope, 1e-9))-threshold)*(1-1/ratio)
                comp_gain = 10**((3*compressor-reduction)/20) if compressor else 1.
                hiss_gain = 1/(1+deesser*max(0., sibilance/.04-1)*4)
                output[i] = (sample-hiss*(1-hiss_gain))*comp_gain
            self.compressor_envelope, self.deesser_envelope = envelope, sibilance
        # Clear disabled delay lines so they never replay stale tails on re-enable.
        if config['fx_reverb']:
            wet = sum(line.process(output, .76+i*.01) for i, line in enumerate(self.combs))*.25
            for line in self.diffusers:
                wet = line.process(wet, .5, allpass=True)
            output = output+wet*(config['fx_reverb']/100)
        else:
            for line in [*self.combs, *self.diffusers]:
                line.buffer.fill(0)
        if self.echo_ms != config['fx_echo_ms']:
            self.echo_ms = config['fx_echo_ms']
            self.echo = Delay(round(self.echo_ms*48))
        if config['fx_echo']:
            output = output+self.echo.process(output, .32)*(config['fx_echo']/100)
        else:
            self.echo.buffer.fill(0)
        if config['fx_limiter']:
            magnitude = np.abs(output)
            output = np.sign(output)*np.where(magnitude<=.9, magnitude, .9+.08*np.tanh((magnitude-.9)/.08))
        target = float(config['fx_enabled'])
        if target != self.mix:
            blend = np.full(len(dry), target, np.float32)
            count = min(480, len(dry))
            blend[:count] = np.linspace(self.mix, target, count, dtype=np.float32)
            output = dry+(output-dry)*blend
            self.mix = target
        if not np.isfinite(output).all():
            raise RuntimeError('エフェクトの出力に非有限値があります。')
        peak = float(np.max(np.abs(output))) if len(output) else 0.
        if not config['fx_enabled']:
            self.reset()
        self.peak = peak
        return np.clip(output, -1, 1).astype(np.float32)
