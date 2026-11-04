"""JSON-lines IPC over private pipes. Never listens on a network port."""
import json
from pathlib import Path
import sys
import threading

ROOT = Path(__file__).resolve().parents[1]
for stream in (sys.stdin, sys.stdout, sys.stderr):
    stream.reconfigure(encoding='utf-8')
sys.path.insert(0,str(ROOT))
wire = sys.stdout
sys.stdout = sys.stderr
lock = threading.Lock()


def emit(event):
    with lock:
        wire.write(json.dumps(event,ensure_ascii=False,allow_nan=False)+'\n')
        wire.flush()


if not ((3, 15, 2) <= sys.version_info[:3] < (3, 16, 0)):
    emit({'type':'error','message':'Python 3.15.2以降の3.15系が必要です。環境をセットアップしてください。'})
    raise SystemExit(1)
from backend.realtime import Realtime, devices
engine = Realtime(emit)
emit({'type':'ready', 'python':sys.version.split()[0]})
for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        command = request['command']
        if command == 'devices': emit({'type':'devices','devices':devices()})
        elif command == 'mix-devices':
            from backend.wasapi_loopback import render_devices
            emit({'type':'mix-devices','devices':render_devices()})
        elif command == 'update-mix':engine.update_music_gain(request['gain'])
        elif command == 'start': engine.start(request['config'])
        elif command == 'update-controls':
            if 'effects' in request: engine.update_controls(request['controls'], request['effects'])
            else: engine.update_controls(request['controls'])
        elif command in ('passive-start','passive-snapshot','passive-stop'):
            try:
                if command=='passive-start':engine.start_passive_reference()
                elif command=='passive-stop':engine.stop_passive_reference()
                value=engine.passive_snapshot() if command=='passive-snapshot' else None
                emit({'type':'passive-reference','id':request.get('id'),'voice':value})
            except Exception as error:emit({'type':'passive-reference','id':request.get('id'),'error':str(error)})
        elif command == 'sync-test-start':
            try: engine.start_sync_test(request['id'], request.get('device_name', ''), request.get('silent', False))
            except Exception as error: emit({'type': 'sync-test', 'id': request.get('id'), 'phase': 'failed', 'message': str(error)})
        elif command == 'sync-test-cancel': engine.cancel_sync_test()
        elif command == 'sync-test-clock': engine.sync_test_clock(request['id'], request.get('token'))
        elif command == 'sync-test-align':
            try: engine.align_sync_test(request['id'], request['epoch'])
            except Exception as error:
                engine.cancel_sync_test()
                emit({'type': 'sync-test', 'id': request.get('id'), 'phase': 'failed', 'message': str(error)})
        elif command == 'stop': engine.stop()
        elif command == 'quit': break
        else: raise ValueError('不明なコマンドです。')
    except Exception as exc:
        emit({'type':'error','message':str(exc)})
        if request.get('command') == 'start':
            emit({'type':'state','state':'stopped'})
engine.stop()
if engine.thread: engine.thread.join(timeout=10)
