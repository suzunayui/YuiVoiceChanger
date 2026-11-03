import unittest
import shutil
import subprocess
import tempfile
import wave
import json
import sys
import threading
import types
from unittest.mock import patch
from pathlib import Path
import numpy as np
from backend.obs_sync import RATE,analyze_stems,decode,play,tone_envelope,runs


def stems(delay=.48,jitter=None,missing=()):
    duration=16
    beep,dry,wet=[np.zeros(RATE*duration,np.float32) for _ in range(3)]
    def insert(output,start,freq,length,volume):
        t=np.arange(round(RATE*length))/RATE
        wave=volume*np.sin(2*np.pi*freq*t)*np.sin(np.linspace(0,np.pi,len(t)))**2
        offset=round(start*RATE);output[offset:offset+len(wave)]+=wave
    for index in range(11):insert(beep,index+1+.38,650 if index<3 else 1000,.08,.18)
    for index in range(8):
        onset=4+index+.02+(jitter[index] if jitter else 0)
        insert(dry,onset,230,.18,.22)
        if index not in missing:insert(wet,onset+delay,390,.18,.35)
    return beep,dry,wet


class ObsSyncTests(unittest.TestCase):
    def test_positive_negative_and_long_delays(self):
        for delay in (.25,.48,1.65):
            with self.subTest(delay=delay):
                signals=stems(delay);target=380
                if delay>1:
                    target=1500;shift=round((target-380)*RATE/1000)
                    signals=(np.r_[np.zeros(shift),signals[0][:-shift]],signals[1],signals[2])
                result=analyze_stems(*signals,target,target,0)
                self.assertEqual(result['matched'],8)
                self.assertAlmostEqual(result['voice_delay_ms'],delay*1000,delta=6)
                expected=(.02+delay)*1000-target
                self.assertAlmostEqual(result['correction_ms'],expected,delta=18)
                self.assertLess(result['spread_ms'],5)

    def test_small_jitter_and_missing_utterance_are_robust(self):
        result=analyze_stems(*stems(jitter=[0,.01,-.01,.015,0,-.005,.005,0],missing=(2,)),380,380,0)
        self.assertEqual(result['matched'],7)
        self.assertAlmostEqual(result['correction_ms'],120,delta=20)

    def test_bad_inputs_do_not_produce_a_correction(self):
        beep,dry,wet=stems()
        for signals in [(beep,dry,dry),(np.zeros_like(beep),dry,wet),(beep,np.zeros_like(dry),wet),stems(missing=(0,1,2,3))]:
            with self.subTest(case=id(signals)),self.assertRaises(ValueError):analyze_stems(*signals,380,380,0)
        with self.assertRaises(ValueError):analyze_stems(*stems(jitter=[-.2,.15,-.15,.15,-.2,.15,-.15,.15]),380,380,0)
        with self.assertRaises(ValueError):analyze_stems(*stems(delay=1.65),380,380,0)
        wet[0]=float('nan')
        with self.assertRaises(ValueError):analyze_stems(beep,dry,wet,380,380,0)

    def test_existing_music_and_dry_offsets_are_accounted_for(self):
        beep,dry,wet=stems()
        # Same measured recording with a 100ms existing correction: its beep
        # track is 100ms later and the result must be absolute, not double added.
        shift=RATE//10;beep=np.r_[np.zeros(shift),beep[:-shift]]
        dry=np.r_[np.zeros(shift),dry[:-shift]]
        result=analyze_stems(beep,dry,wet,480,380,100,dry_offset_ms=100)
        self.assertAlmostEqual(result['correction_ms'],120,delta=18)
        self.assertAlmostEqual(result['voice_delay_ms'],480,delta=6)

    def test_direct_mic_is_aligned_to_obs_recording_start(self):
        beep,dry,wet=stems()
        for shift in (-2,1.25):
            def move(audio):
                count=round(abs(shift)*RATE)
                return np.r_[audio[count:],np.zeros(count)] if shift<0 else np.r_[np.zeros(count),audio[:-count]]
            result=analyze_stems(move(beep),dry,move(wet),380,380,0,dry_is_local=True)
            self.assertEqual(result['matched'],8)
            self.assertAlmostEqual(result['correction_ms'],120,delta=20)
            self.assertAlmostEqual(result['voice_delay_ms'],480,delta=20)

    @unittest.skipUnless(shutil.which('ffmpeg'),'ffmpeg is optional on test hosts')
    def test_aac_multitrack_recording_decodes_on_a_common_time_axis(self):
        ffmpeg=shutil.which('ffmpeg')
        with tempfile.TemporaryDirectory() as home:
            files=[]
            for index,audio in enumerate(stems()):
                file=Path(home)/f'{index}.wav';files.append(file)
                with wave.open(str(file),'wb') as output:
                    output.setnchannels(1);output.setsampwidth(2);output.setframerate(RATE)
                    output.writeframes(np.round(audio*32767).astype('<i2').tobytes())
            recording=Path(home)/'test.mkv'
            command=[ffmpeg,'-nostdin','-v','error']
            for file in files:command+=['-i',str(file)]
            command+=['-map','0:a','-map','2:a','-ar','48000','-c:a','aac',str(recording)]
            subprocess.run(command,check=True,capture_output=True,timeout=20)
            beep,wet=[decode(ffmpeg,str(recording),index) for index in range(2)]
            dry=decode(ffmpeg,str(files[1]),0)
            result=analyze_stems(beep,dry,wet,380,380,0,dry_is_local=True)
            self.assertEqual(result['matched'],8)
            self.assertAlmostEqual(result['correction_ms'],120,delta=20)
            request=dict(mode='analyze',ffmpeg=ffmpeg,recording=str(recording),dry_file=str(files[1]),music_offset_ms=380,fixed_ms=380,correction_ms=0)
            script=Path(__file__).resolve().parents[1]/'backend'/'obs_sync.py'
            process=subprocess.run([sys.executable,'-I','-u',str(script)],input=json.dumps(request)+'\n',text=True,capture_output=True,encoding='utf8',timeout=20)
            self.assertEqual(process.returncode,0,process.stderr)
            event=json.loads(process.stdout.strip());self.assertEqual(event['phase'],'completed')
            self.assertAlmostEqual(event['correction_ms'],120,delta=20)

    def test_player_records_selected_mic_on_output_clock_with_three_count_in_and_eight_beats(self):
        outputs=[]
        class Duplex:
            latency=(.01,.02)
            def __init__(self,**options):
                self.options=options
                assert options['device']==(1,0) and options['channels']==(1,2)
            def start(self):
                data=np.zeros((round(14.5*48000),2),np.float32)
                for cursor in range(0,len(data),480):
                    incoming=np.zeros((480,1),np.float32)
                    if cursor==5*48000:incoming[0,0]=.5
                    timing=types.SimpleNamespace(inputBufferAdcTime=100+cursor/48000-.03,outputBufferDacTime=100+cursor/48000)
                    self.options['callback'](incoming,data[cursor:cursor+480],480,timing,False)
                outputs.append(data)
            def stop(self): pass
            def close(self): pass
        devices=[{'hostapi':0,'name':'Test output','max_output_channels':2,'max_input_channels':0},{'hostapi':0,'name':'Test mic','max_output_channels':0,'max_input_channels':1}]
        sd=types.SimpleNamespace(query_hostapis=lambda:[{'name':'Windows WASAPI','default_output_device':0}],query_devices=lambda index=None:devices if index is None else devices[index],Stream=Duplex,WasapiSettings=lambda **options:options)
        with tempfile.TemporaryDirectory() as home,patch.dict(sys.modules,{'sounddevice':sd}):
            raw=Path(home)/'raw.wav';config=dict(input_name='Test mic',input=1,dry_file=str(raw))
            play(config,lambda event:None,threading.Event())
            with wave.open(str(raw)) as recorded:
                self.assertEqual(recorded.getframerate(),48000);self.assertEqual(recorded.getnchannels(),1)
                samples=np.frombuffer(recorded.readframes(recorded.getnframes()),'<i2')
            self.assertEqual(np.argmax(samples),round(4.97*48000))
            self.assertAlmostEqual(max(samples)/32767,.5,delta=.001)
            raw.unlink();cancelled=threading.Event();cancelled.set()
            with self.assertRaises(InterruptedError):play(config,lambda event:None,cancelled)
            self.assertFalse(raw.exists())
        self.assertEqual(outputs[0].shape[1],2);np.testing.assert_array_equal(outputs[0][:,0],outputs[0][:,1])
        self.assertLessEqual(float(np.max(np.abs(outputs[0]))),.181)
        sound=outputs[0][::3,0];level,hop=tone_envelope(sound)
        beats=[start*hop for start,end in runs(level>.05) if (end-start)*hop>.025]
        self.assertEqual(len(beats),8);self.assertAlmostEqual(beats[0],4,delta=.02)


if __name__=='__main__':unittest.main()
