"""Passive audio monitor process; private pipes in, numeric status out."""
import json
from pathlib import Path
import sys
import threading
import time

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from backend.passive_audio import ReferenceRing, unpack, measure
from backend.passive_recording import decode_recording
from backend.wasapi_loopback import Loopback

def main():
    for stream in (sys.stdin,sys.stdout,sys.stderr):stream.reconfigure(encoding='utf-8')
    def emit(event):print(json.dumps(event,ensure_ascii=False,allow_nan=False),flush=True)
    config=json.loads(sys.stdin.readline());stop=threading.Event();ring=ReferenceRing();failure=[]
    def capture():
        try:Loopback(config.get('device_id','default')).run(stop,ring.append,lambda:emit({'phase':'ready'}))
        except Exception as error:failure.append(str(error));emit({'phase':'failed','message':str(error)})
    thread=threading.Thread(target=capture,daemon=True);thread.start()
    try:
        for line in sys.stdin:
            request=json.loads(line)
            if request.get('command')=='stop':break
            if request.get('command')!='measure':continue
            if failure:break
            try:
                voice=unpack(request.get('voice'));music=unpack(ring.snapshot())
                if not voice or not music:emit({'phase':'waiting','message':'声と伴奏がそろうのを待っています。'});continue
                recording=decode_recording(config['ffmpeg'],request['recording'],request.get('track',0))
                emit(measure(voice,music,recording))
            except Exception as error:emit({'phase':'waiting','message':str(error)})
    finally:stop.set();thread.join(timeout=3)

if __name__=='__main__':main()
