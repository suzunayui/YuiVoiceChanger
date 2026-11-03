"""Offline OBS stem analysis and user-started WASAPI beep playback."""
import json
import math
import subprocess
import sys
import threading
import time
import wave
import numpy as np

RATE = 16000


def tone_envelope(audio, rate=RATE):
    audio = np.asarray(audio, np.float64)
    size, hop = round(rate*.04), round(rate*.005)
    if len(audio) < size: raise ValueError('録音が短すぎます。')
    windows = np.lib.stride_tricks.sliding_window_view(audio, size)[::hop]
    phase = np.arange(size)*2*np.pi*1000/rate
    window = np.hanning(size)
    return np.abs(windows @ (window*np.exp(-1j*phase)))*2/window.sum(), hop/rate


def runs(active):
    edges = np.diff(np.r_[False, active, False].astype(np.int8))
    return list(zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)))


def voice_onsets(audio, rate=RATE):
    audio = np.asarray(audio, np.float64)
    size, hop = round(rate*.02), round(rate*.005)
    if len(audio) < size: return np.array([])
    energy = np.sqrt(np.convolve(audio*audio, np.ones(size)/size, 'valid')[::hop])
    noise, peak = np.percentile(energy, 20), np.percentile(energy, 98)
    if peak < max(.0015, noise*3): raise ValueError('声が小さいか、周囲の音が大きすぎます。静かな場所でもう一度測定してください。')
    threshold = max(.001, noise*3.5, peak*.13)
    segments = runs(energy > threshold)
    merged = []
    for start, end in segments:
        if merged and (start-merged[-1][1])*hop/rate < .10: merged[-1][1] = end
        else: merged.append([start, end])
    return np.array([start*hop/rate for start, end in merged if .035 <= (end-start)*hop/rate <= .80])


def analyze_stems(beep, dry, wet, music_offset_ms, fixed_ms, correction_ms, dry_offset_ms=0, dry_is_local=False):
    signals = [np.asarray(signal, np.float64) for signal in (beep, dry, wet)]
    if any(signal.ndim != 1 or not np.isfinite(signal).all() for signal in signals): raise ValueError('録音に不正な音声があります。')
    if min(map(len, signals)) < RATE*10: raise ValueError('テスト録音が短すぎます。')
    if any(np.mean(np.abs(signal) >= .999) > .005 for signal in signals): raise ValueError('録音が音割れしています。音量を下げて再測定してください。')
    level, hop = tone_envelope(signals[0])
    threshold = max(.008, float(np.max(level))*.30)
    # Projection windows are indexed by their start. Use the pulse centre to
    # remove the analysis-window offset before estimating the known 80ms onset.
    beeps = np.array([((start+end)/2)*hop-.02 for start, end in runs(level > threshold) if .025 <= (end-start)*hop <= .16])
    if len(beeps) != 8 or np.max(np.abs(np.diff(beeps)-1)) > .07:
        raise ValueError('8回のビープを録音できませんでした。伴奏のソース・再生先を確認し、他の音楽を止めてください。')
    dry_starts, wet_starts = voice_onsets(signals[1]), voice_onsets(signals[2])
    dry_starts = dry_starts-dry_offset_ms/1000
    if dry_is_local:
        # Local microphone samples use the first beep output DAC time as zero.
        # Locate that zero on OBS's timeline using the first target at 4 seconds.
        dry_starts = dry_starts+beeps[0]-music_offset_ms/1000-4.0
    # The OBS reference already includes its sync offset. Undo it to locate the
    # beats the user actually heard, rather than asking them to follow delayed audio.
    heard = beeps-music_offset_ms/1000
    paired_dry, paired_beeps = [], []
    used = set()
    for beat, audible in zip(beeps, heard):
        candidates = [(abs(value-audible), index, value) for index, value in enumerate(dry_starts) if index not in used and abs(value-audible) <= .35]
        if candidates:
            _, index, value = min(candidates);used.add(index);paired_dry.append(value);paired_beeps.append(beat)
    if len(paired_dry) < 6: raise ValueError('拍に合う発声が足りません。カウントの後、8回の拍に合わせて短く「た」と発声してください。')
    dry_values = np.array(paired_dry);beep_values = np.array(paired_beeps)
    rhythm = (dry_values-(beep_values-music_offset_ms/1000))*1000
    rhythm_spread = float(np.median(np.abs(rhythm-np.median(rhythm))))
    if rhythm_spread > 45 or np.ptp(rhythm) > 220:
        raise ValueError('発声タイミングのばらつきが大きいため補正しません。一定の拍に合わせて再測定してください。')
    # Match the same utterances on both voice tracks. Full phrase coverage breaks
    # the one-second ambiguity of a regular metronome; tied hypotheses are rejected.
    candidates = []
    for lag in np.unique(np.round((wet_starts[:, None]-dry_values).ravel(), 3)):
        if not 0 <= lag <= 2.7: continue
        pairs=[];used=set()
        for index, value in enumerate(dry_values):
            matches=[(abs(wet-value-lag), j, wet) for j, wet in enumerate(wet_starts) if j not in used and abs(wet-value-lag) <= .12]
            if matches:
                _, j, wet=min(matches);used.add(j);pairs.append((index,wet))
        if len(pairs) < 6: continue
        delta=np.array([(wet-dry_values[index])*1000 for index,wet in pairs])
        spread=float(np.median(np.abs(delta-np.median(delta))))
        if spread <= 35 and np.ptp(delta) <= 160: candidates.append((len(pairs),spread,float(np.median(delta)),pairs))
    if not candidates: raise ValueError('生声と変換後の声を安定して対応付けられませんでした。声のソースと変換状態を確認してください。')
    candidates.sort(key=lambda item:(-item[0],item[1]))
    best=candidates[0]
    if best[2] < 30: raise ValueError('生声と変換後が同じ音声の可能性があります。CABLE Outputを取り込む声ソースを確認してください。')
    if any(count == best[0] and abs(lag-best[2]) > 150 for count,_,lag,_ in candidates[1:]):
        raise ValueError('発声の対応が曖昧なため補正しません。8回とも短く発声して再測定してください。')
    residual=np.array([(wet-beep_values[index])*1000 for index,wet in best[3]])
    residual_spread=float(np.median(np.abs(residual-np.median(residual))))
    if residual_spread > 55: raise ValueError('録音のずれが安定していないため補正しません。処理落ちや発声タイミングを確認してください。')
    adjustment=int(round(float(np.median(residual))))
    result=int(round(music_offset_ms+adjustment-fixed_ms))
    if not -1000 <= result <= 1000: raise ValueError('必要な補正が±1000msを超えました。音声ルートを確認してください。')
    return dict(correction_ms=result,previous_correction_ms=correction_ms,residual_ms=adjustment,
        voice_delay_ms=round(best[2]),spread_ms=round(residual_spread),matched=best[0])


def decode(ffmpeg, recording, index):
    result=subprocess.run([ffmpeg,'-nostdin','-v','error','-copyts','-start_at_zero','-i',recording,
        '-map',f'0:a:{index}','-t','30','-af','aresample=async=1:first_pts=0','-ac','1','-ar',str(RATE),'-f','f32le','pipe:1'],
        stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    if result.returncode or len(result.stdout) > RATE*30*4: raise ValueError('測定音声を解析できませんでした。録画形式・音声トラックを確認してください。')
    return np.frombuffer(result.stdout,dtype='<f4')


def play(config, emit, cancel):
    if cancel.is_set(): raise InterruptedError('測定を中止しました。')
    import sounddevice as sd
    hosts=sd.query_hostapis()
    host_name='Core Audio' if any(h['name']=='Core Audio' for h in hosts) else 'Windows WASAPI'
    host=next((i for i,h in enumerate(hosts) if h['name']==host_name),None)
    if host is None: raise ValueError(f'{host_name}の再生先を確認できませんでした。')
    name=config.get('device_name','')
    options=[i for i,d in enumerate(sd.query_devices()) if d['hostapi']==host and d['max_output_channels']>0 and (d['name']==name if name else i==hosts[host]['default_output_device'])]
    if len(options)!=1: raise ValueError('伴奏ソースと同じ音声再生先が見つかりません。OBSのデスクトップ音声のデバイスを確認してください。')
    devices=sd.query_devices();mic_name=config.get('input_name','');mic_id=config.get('input',-1)
    microphones=[i for i,d in enumerate(devices) if d['hostapi']==host and d['max_input_channels']>0 and (d['name']==mic_name if mic_name else i==mic_id)]
    if len(microphones)!=1: raise ValueError('アプリで選択中のマイクが見つかりません。音声のルートを確認してください。')
    channels=min(2,sd.query_devices(options[0])['max_output_channels'])
    rate=48000;signal=np.zeros(round(14.5*rate),np.float32)
    for index in range(11):
        freq=650 if index<3 else 1000
        t=np.arange(round(.08*rate))/rate
        sound=.18*np.sin(2*np.pi*freq*t)*np.sin(np.linspace(0,np.pi,len(t)))**2
        start=(index+1)*rate;signal[start:start+len(t)]=sound
    raw=np.zeros_like(signal);cursor=0;errors=0;offset=None;fallback=0;done=threading.Event();stream=None
    def callback(indata,outdata,frames,timing,status):
        nonlocal cursor,errors,offset
        if offset is None:
            adc,dac=timing.inputBufferAdcTime,timing.outputBufferDacTime
            offset=round((adc-dac)*rate) if math.isfinite(adc) and math.isfinite(dac) and adc>0 and dac>0 and abs(adc-dac)<2 else fallback
        errors+=int(bool(status));count=min(frames,len(signal)-cursor);outdata.fill(0)
        outdata[:count]=signal[cursor:cursor+count,None]
        start=cursor+offset;left=max(0,start);right=min(len(raw),start+count)
        if right>left:raw[left:right]=indata[left-start:right-start,0]
        cursor+=count
        if cursor>=len(signal):done.set()
    try:
        settings=sd.CoreAudioSettings(change_device_parameters=False,fail_if_conversion_required=False,conversion_quality='max') if host_name=='Core Audio' else sd.WasapiSettings(exclusive=False,auto_convert=True)
        stream=sd.Stream(device=(microphones[0],options[0]),samplerate=rate,channels=(1,channels),dtype='float32',blocksize=480,latency='low',extra_settings=(settings,settings),callback=callback)
        fallback=-round(sum(stream.latency)*rate)
        stream.start();last=-1;deadline=time.monotonic()+20
        while not done.wait(.03):
            if cancel.is_set(): raise InterruptedError('測定を中止しました。')
            if time.monotonic()>deadline: raise ValueError('ビープの再生・マイク録音が時間切れになりました。')
            beat=int(cursor/rate)-1
            if beat!=last:
                last=beat;emit(dict(phase='speaking',beat=beat-2,count=8,progress=min(.9,cursor/len(signal))))
        stream.stop()
        if cancel.is_set(): raise InterruptedError('測定を中止しました。')
        if errors: raise ValueError('ビープの再生またはマイク録音が途切れました。音声デバイスを確認してください。')
        with wave.open(config['dry_file'],'wb') as output:
            output.setnchannels(1);output.setsampwidth(2);output.setframerate(rate)
            output.writeframes(np.round(np.clip(raw,-1,1)*32767).astype('<i2').tobytes())
    finally:
        if stream:stream.close()
        signal.fill(0);raw.fill(0)


def main():
    for stream in (sys.stdin,sys.stdout,sys.stderr): stream.reconfigure(encoding='utf-8')
    request=json.loads(sys.stdin.readline());cancel=threading.Event()
    def listen():
        for line in sys.stdin:
            try:
                if json.loads(line).get('command')=='cancel':cancel.set()
            except ValueError: pass
    listener=threading.Thread(target=listen,daemon=True);listener.start()
    def emit(event): print(json.dumps(event,ensure_ascii=False,allow_nan=False),flush=True)
    try:
        if request['mode']=='play':
            import ctypes
            com=None
            try:
                if sys.platform=='win32':
                    ole32=ctypes.OleDLL('ole32')
                    try:ole32.CoInitializeEx(None,0)
                    except OSError as error:
                        if getattr(error,'winerror',0)&0xffffffff!=0x80010106:raise
                    else:com=ole32
                play(request,emit,cancel);emit(dict(phase='completed'))
            finally:
                if com:com.CoUninitialize()
        else:
            beep=decode(request['ffmpeg'],request['recording'],0)
            dry=decode(request['ffmpeg'],request['dry_file'],0)
            wet=decode(request['ffmpeg'],request['recording'],1)
            if cancel.is_set():raise InterruptedError('測定を中止しました。')
            emit(dict(phase='completed',**analyze_stems(beep,dry,wet,request['music_offset_ms'],request['fixed_ms'],request['correction_ms'],dry_is_local=True)))
    except Exception as error:emit(dict(phase='cancelled' if isinstance(error,InterruptedError) else 'failed',message=str(error)))
    finally:listener.join(timeout=1)


if __name__=='__main__':main()
