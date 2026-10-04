"""JSON-lines IPC over private pipes. Never listens on a network port."""
import json
import os
from pathlib import Path
import sys
import threading

ROOT = Path(__file__).resolve().parents[1]
for stream in (sys.stdin, sys.stdout, sys.stderr):
    stream.reconfigure(encoding='utf-8')
sys.path.insert(0,str(ROOT))
if (ROOT/'.local/beatrice-libs').is_dir():
    sys.path.insert(0,str(ROOT/'.local/beatrice-libs'))
if os.environ.get('YVC_BEATRICE_LIBS'):
    sys.path.insert(0, os.environ['YVC_BEATRICE_LIBS'])
wire = sys.stdout
sys.stdout = sys.stderr
lock = threading.Lock()


def emit(event):
    with lock:
        wire.write(json.dumps(event,ensure_ascii=False,allow_nan=False)+'\n')
        wire.flush()


from backend.realtime import Realtime, devices
try:
    import pedalboard
except ImportError:
    pass
engine = Realtime(emit)
emit({'type':'ready'})
for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        command = request['command']
        if command == 'devices': emit({'type':'devices','devices':devices()})
        elif command == 'start': engine.start(request['config'])
        elif command == 'stop': engine.stop()
        elif command == 'quit': break
        else: raise ValueError('不明なコマンドです。')
    except Exception as exc:
        emit({'type':'error','message':str(exc)})
        if request.get('command') == 'start':
            emit({'type':'state','state':'stopped'})
engine.stop()
if engine.thread: engine.thread.join(timeout=10)
