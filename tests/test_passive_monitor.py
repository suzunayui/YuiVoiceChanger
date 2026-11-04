import base64
import tempfile
import shutil
import subprocess
import wave
import types
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
from backend.passive_audio import RATE, ReferenceRing, VoiceReference, match, measure, unpack
from backend.passive_recording import rebase_moof, snapshot, decode_recording

def fixture(seconds=28):
    rng=np.random.default_rng(813)
    voice=rng.normal(size=RATE*seconds)*.12
    music=rng.normal(size=RATE*seconds)*.1
    return voice,music

def reference(audio,origin=100):return origin,audio,np.ones(len(audio),bool)

def mixed(voice,music,v_ms,m_ms):
    result=np.zeros(max(len(voice),len(music))+RATE*3)
    for audio,delay in [(voice,v_ms),(music,m_ms)]:
        p=round(delay*RATE/1000);result[p:p+len(audio)]+=audio
    return result

class PassiveMonitorTests(unittest.TestCase):
    def test_early_late_and_zero_have_correct_sign_independent_of_file_origin(self):
        voice,music=fixture()
        for v,m,expected in [(437,89,348),(40,240,-200),(200,200,0)]:
            with self.subTest(expected=expected):
                result=measure(reference(voice),reference(music),mixed(voice,music,v,m),now=129)
                self.assertEqual(result['phase'],'measured');self.assertEqual(result['delta_ms'],expected)
                shifted=np.r_[np.zeros(RATE*2),mixed(voice,music,v,m)]
                self.assertEqual(measure(reference(voice),reference(music),shifted,now=129)['delta_ms'],expected)

    def test_ambiguous_silent_absent_and_stale_signals_never_report_zero(self):
        voice,music=fixture()
        tone=np.sin(2*np.pi*440*np.arange(len(voice))/RATE)*.1
        self.assertIsNone(match(reference(tone),np.r_[np.zeros(3000),tone],1))
        self.assertIsNone(match(reference(voice),music,1))
        self.assertIsNone(match(reference(np.zeros_like(voice)),music,1))
        result=measure(reference(voice),reference(music),mixed(voice,music,437,89),now=190)
        self.assertNotIn('delta_ms',result)
        self.assertNotIn('delta_ms',measure(None,None,music,now=129))

    def test_disagreeing_windows_wait_instead_of_averaging_a_delay_jump(self):
        voice,music=fixture(16);result=mixed(voice,music,437,89)
        # The two independent windows give different lags: no apparently precise result.
        with patch('backend.passive_audio.match',side_effect=[{'offset':1.,'score':.9,'record_position':1.,'reference_time':1.},{'offset':0.,'score':.9,'record_position':2.,'reference_time':1.},None,{'offset':.5,'score':.9},{'offset':0.,'score':.9}]*20):
            self.assertNotIn('delta_ms',measure(reference(voice),reference(music),result,now=117))

    def test_voice_in_accompaniment_is_rejected_instead_of_reporting_a_false_alignment(self):
        voice,music=fixture()
        contaminated=music+voice
        result=measure(reference(voice),reference(contaminated),mixed(voice,contaminated,437,89),now=129)
        self.assertNotIn('delta_ms',result)
        self.assertEqual(result['phase'],'waiting')

    def test_reference_ring_is_bounded_contiguous_and_keeps_sample_timing(self):
        ring=ReferenceRing(seconds=2)
        for i in range(400):ring.append(100+i*.01,np.ones(480,np.float32))
        stamp,audio,valid=unpack(ring.snapshot())
        self.assertLess(len(audio),RATE*2.1);self.assertGreater(valid.mean(),.99)
        self.assertAlmostEqual(stamp,101.9995,places=4)

    def test_worker_reference_clock_backdates_output_without_touching_audio(self):
        ref=VoiceReference();samples=np.linspace(-.1,.1,480,dtype=np.float32);original=samples.copy()
        try:
            with patch.object(ref.clock,'now',return_value=100):
                ref.timed(samples,types.SimpleNamespace(inputBufferAdcTime=10.,currentTime=10.),False,4800)
            import time
            for _ in range(30):
                value=ref.ring.snapshot()
                if value:break
                time.sleep(.01)
            self.assertAlmostEqual(value['time'],99.8995,places=4)
            np.testing.assert_array_equal(samples,original)
            ref.timed(samples,types.SimpleNamespace(inputBufferAdcTime=10.01,currentTime=10.01),True,4800)
            self.assertTrue(ref.failure)
        finally:ref.close()

    def test_mp4_absolute_fragment_offsets_are_rebased(self):
        def box(kind,content):return (len(content)+8).to_bytes(4,'big')+kind+content
        tfhd=box(b'tfhd',b'\0\0\0\1'+(1).to_bytes(4,'big')+(100000).to_bytes(8,'big'))
        moof=box(b'moof',box(b'traf',tfhd));rebased=rebase_moof(moof,-90000)
        p=rebased.find(b'tfhd')+12
        self.assertEqual(int.from_bytes(rebased[p:p+8],'big'),10000)

    def test_incomplete_recording_is_not_reported_as_measurement(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder)/'empty.mp4';p.write_bytes(b'')
            with self.assertRaisesRegex(ValueError,'待っています'):snapshot(p)

    @unittest.skipUnless(shutil.which('ffmpeg'),'ffmpeg required')
    def test_recent_fragments_of_long_recordings_decode_without_copying_the_whole_file(self):
        ffmpeg=shutil.which('ffmpeg')
        with tempfile.TemporaryDirectory() as folder:
            source=Path(folder)/'reference.wav'
            with wave.open(str(source),'wb') as output:
                output.setparams((1,2,RATE,0,'NONE','not compressed'))
                output.writeframes((np.random.default_rng(1).normal(size=RATE)*3000).astype('<i2').tobytes())
            for name,options in [('long.mkv',['-cluster_time_limit','5000']),('long.mp4',['-movflags','+frag_keyframe+empty_moov+default_base_moof','-frag_duration','2000000'])]:
                file=Path(folder)/name
                subprocess.run([ffmpeg,'-nostdin','-v','error','-y','-stream_loop','-1','-i',str(source),'-t','120','-c:a','aac',*options,str(file)],check=True,timeout=20)
                original=file.stat().st_size;data,_=snapshot(file)
                self.assertLess(len(data),original*.6)
                audio=decode_recording(ffmpeg,file)
                self.assertGreater(len(audio)/RATE,35);self.assertLess(len(audio)/RATE,50)
                self.assertEqual(file.stat().st_size,original)

if __name__=='__main__':unittest.main()
