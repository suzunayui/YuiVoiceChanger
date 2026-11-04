"""Continuous vocoder excitation for overlapping, fixed-position inference windows."""
import torch


class StreamingExcitation:
    def __init__(self, advance, anchor_from_end):
        self.advance = int(advance)
        self.anchor_from_end = int(anchor_from_end)
        self.previous_phase = None
        self.previous_noise = None
        self.generator = None

    def phase(self, normalized_frequency):
        # Match oscillator phase at the middle of the audible overlap. Only the
        # phase origin changes; pitch, frame positions and sample counts do not.
        phase = normalized_frequency.double().cumsum(1)
        anchor = phase.shape[1] - self.anchor_from_end
        if not 0 <= anchor < anchor + self.advance < phase.shape[1]:
            raise ValueError('Invalid streaming excitation anchor.')
        previous = self.previous_phase
        if previous is not None:
            if previous.shape != phase.shape or previous.device != phase.device:
                raise ValueError('Streaming excitation must be reset after a format change.')
            phase += previous[:, anchor + self.advance:anchor + self.advance + 1] - phase[:, anchor:anchor + 1]
        phase = phase.remainder(1.).float()
        self.previous_phase = phase.detach()
        return phase

    def noise(self, batch_size, length, device):
        # The same absolute sample receives the same noise in both inference
        # windows, avoiding a periodic energy dip during the crossfade.
        if self.generator is None:
            self.generator = torch.Generator(device=device).manual_seed(42)
        previous = self.previous_noise
        count = self.advance if previous is not None else length
        fresh = torch.rand(batch_size, count, device=device, generator=self.generator) - .5
        if previous is not None:
            if previous.shape != (batch_size, length) or previous.device != fresh.device or self.advance > length:
                raise ValueError('Streaming excitation must be reset after a format change.')
            fresh = torch.cat((previous[:, self.advance:], fresh), dim=1)
        self.previous_noise = fresh.detach()
        return fresh
