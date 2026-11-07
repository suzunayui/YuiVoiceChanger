import types
import unittest
import numpy as np
from backend.program_mix import InputClock, MusicLevel, ProgramMix, settings
from backend.scheduled_audio import ScheduledAudio


class MusicLevelTests(unittest.TestCase):
    def fill(self,level,peak,seconds=10):
        for _ in range(seconds*100):level.record(peak)

    def test_reads_the_peak_since_the_last_read_in_db(self):
        level=MusicLevel()
        level.record(.1);level.record(.5);level.record(.25)
        self.assertAlmostEqual(level.take_db(),-6.02,places=1)
        level.record(.1)
        self.assertAlmostEqual(level.take_db(),-20,places=1)

    def test_quiet_music_is_low_only_after_a_full_window(self):
        level=MusicLevel()
        self.fill(level,.03,seconds=5)
        self.assertFalse(level.low)
        self.fill(level,.03,seconds=5)
        self.assertTrue(level.low)

    def test_silence_and_normal_music_are_not_low(self):
        for peak in (0.,.0005,.5):
            level=MusicLevel()
            self.fill(level,peak)
            self.assertFalse(level.low,peak)

    def test_one_loud_moment_clears_low_until_it_leaves_the_window(self):
        level=MusicLevel()
        self.fill(level,.03)
        level.record(.5)
        self.fill(level,.03,seconds=1)
        self.assertFalse(level.low)
        self.fill(level,.03,seconds=10)
        self.assertTrue(level.low)

    def test_level_is_measured_before_the_accompaniment_gain(self):
        mixer=ProgramMix('test','test',6,loopback=object())
        mixer.clock.now=lambda:1000.0
        for block in range(40):
            samples=np.full((480,2),.05,np.float32)
            mixer.music.append(1000+block*.01,samples)
            stamp=1000+block*.01
            timing=types.SimpleNamespace(inputBufferAdcTime=stamp,currentTime=stamp)
            mixer.render(np.zeros(480,np.float32),block*480,timing,False,480*5)
        self.assertAlmostEqual(mixer.level.take_db(),-26,delta=1)


def timing_at(stamp):
    return types.SimpleNamespace(inputBufferAdcTime=stamp,currentTime=stamp)


def feed(clock,first_block,stamps):
    for offset,stamp in enumerate(stamps):
        clock.feed((first_block+offset)*480,480,timing_at(stamp),False)


class InputClockRecoveryTests(unittest.TestCase):
    def clock(self,blocks=10):
        clock=InputClock(now=lambda:1000.0)
        feed(clock,0,[20+block*.01 for block in range(blocks)])
        return clock

    def test_late_callback_burst_keeps_the_sample_timeline(self):
        clock=self.clock()
        # The callback stalls 120 ms and catches up; the audio samples themselves stay continuous.
        feed(clock,10,[20.22+max(0,block-12)*.01 for block in range(20)])
        self.assertEqual((clock.outliers,clock.resyncs),(1,0))
        spacing=np.diff(clock.times(10*480+240,480))
        self.assertLess(float(np.max(np.abs(spacing-1/48000))),1e-6)
        self.assertAlmostEqual(clock.anchors[10*480],1000.10,delta=.002)

    def test_lasting_jump_resyncs_once_and_silences_only_the_spanning_block(self):
        clock=self.clock()
        feed(clock,10,[20.3+block*.01 for block in range(60)])
        self.assertEqual(clock.resyncs,1)
        boundary=(10+49)*480
        self.assertAlmostEqual(clock.anchors[boundary],1000.79,delta=.002)
        self.assertIsNone(clock.times(boundary-480,480))
        self.assertIsNotNone(clock.times(boundary-960,480))
        self.assertIsNotNone(clock.times(boundary,480))

    def jump(self,clock,first_block,stamp):
        feed(clock,first_block,[stamp+block*.01 for block in range(50)])
        return first_block+50,stamp+.5

    def test_repeated_jumps_stop_instead_of_streaming_a_drifting_mix(self):
        clock=self.clock();block,stamp=10,20.1
        for _ in range(3):block,stamp=self.jump(clock,block,stamp+.2)
        self.assertEqual(clock.resyncs,3)
        with self.assertRaisesRegex(ValueError,'マイクの時刻が変化'):self.jump(clock,block,stamp+.2)

    def test_old_resyncs_expire_after_a_minute(self):
        clock=self.clock();block,stamp=10,20.1
        for _ in range(3):
            block,stamp=self.jump(clock,block,stamp+.2)
            feed(clock,block,[stamp+index*.01 for index in range(3000)])
            block+=3000;stamp+=30
        block,stamp=self.jump(clock,block,stamp+.2)
        self.assertEqual(clock.resyncs,4)

    def test_mix_output_continues_through_a_stall(self):
        mixer=ProgramMix('test','test',0,loopback=object())
        mixer.clock.now=lambda:1000.0
        voice=np.full(480,.1,np.float32)
        for block in range(30):
            stamp=20+block*.01+(.12 if block==15 else 0)
            output=mixer.render(voice,block*480,timing_at(stamp),False,480*5)
            self.assertAlmostEqual(float(output[0,0]),.1,places=5)
        self.assertEqual(mixer.clock.outliers,1)


class ProgramMixTests(unittest.TestCase):
    def test_stereo_music_and_voice_share_source_position_despite_late_jobs_and_clock_drift(self):
        mixer=ProgramMix('test','test',0,loopback=object())
        mixer.clock.now=lambda:1000.0
        scheduled=ScheduledAudio()
        delay=480*40
        lookback=480*7
        output=[]
        for block in range(180):
            frame=block*480
            music=np.zeros((480,2),np.float32)
            if block in (20,60,100):music[240]=(.2,-.1)
            mixer.music.append(1000+block*.01*1.00008,music)
            # The second inference misses its reservation. The third keeps its original slot.
            if block in (27,110,109):
                source={27:20,110:60,109:100}[block]
                voice=np.zeros(480,np.float32);voice[240]=.3
                scheduled.put(source*480+lookback+delay,voice)
            voice=scheduled.take(480)
            timing=types.SimpleNamespace(inputBufferAdcTime=20+block*.01,currentTime=20+block*.01)
            output.append(mixer.render(voice,frame,timing,False,delay+lookback))
        output=np.concatenate(output)
        for source,voice_present in [(20,True),(60,False),(100,True)]:
            expected=(source+47)*480+240
            piece=output[expected-12:expected+12]
            difference=piece[:,0]-piece[:,1]
            self.assertGreater(difference.max(),.1)
            if voice_present:
                self.assertAlmostEqual(float(piece[12,0]-difference[12]*2/3),.3,places=5)
            else:self.assertLess(float(np.max(np.abs(piece[:,0]-difference*2/3))),1e-6)
        self.assertEqual(scheduled.late_blocks,1)

    def test_mix_buffer_ignores_old_obs_correction_and_enforces_processing_headroom(self):
        self.assertEqual(settings({'mix_latency_ms':500,'obs_path_delay_ms':139},80,65,20),415)
        with self.assertRaisesRegex(ValueError,'730ms'):settings({'mix_latency_ms':500},320,65,20)

if __name__=='__main__':unittest.main()
