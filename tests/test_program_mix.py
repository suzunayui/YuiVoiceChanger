import types
import unittest
import numpy as np
from backend.program_mix import ProgramMix, settings
from backend.scheduled_audio import ScheduledAudio


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
