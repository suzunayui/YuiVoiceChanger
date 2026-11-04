"""Read-only Windows shared-render capture. No driver, playback or OBS plugin."""
import ctypes as C
import os
import time
import uuid
import numpy as np

class GUID(C.Structure):
    _fields_=[('data',C.c_ubyte*16)]
    def __init__(self,value):
        super().__init__();self.data[:]=uuid.UUID(value).bytes_le

class WaveFormat(C.Structure):
    _pack_=1
    _fields_=[('tag',C.c_ushort),('channels',C.c_ushort),('rate',C.c_ulong),('bytes',C.c_ulong),('align',C.c_ushort),('bits',C.c_ushort),('extra',C.c_ushort)]

def checked(result):
    if result<0:raise OSError(f'Windows音声の取得に失敗しました（0x{result & 0xffffffff:08X}）。')

def call(pointer,index,*signature):
    return C.WINFUNCTYPE(C.c_long,C.c_void_p,*signature)(C.cast(pointer,C.POINTER(C.POINTER(C.c_void_p))).contents[index])

def release(pointer):
    if pointer:call(pointer,2)(pointer)

def create_enumerator(ole):
    ole.CoCreateInstance.argtypes=[C.POINTER(GUID),C.c_void_p,C.c_ulong,C.POINTER(GUID),C.POINTER(C.c_void_p)]
    result=C.c_void_p();checked(ole.CoCreateInstance(C.byref(GUID('BCDE0395-E52F-467C-8E3D-C4579291692E')),None,1,C.byref(GUID('A95664D2-9614-4F35-A746-DE8DB63617E6')),C.byref(result)));return result

def device_info(device,ole):
    class Key(C.Structure):_fields_=[('guid',GUID),('pid',C.c_ulong)]
    class Variant(C.Structure):_fields_=[('vt',C.c_ushort),('reserved',C.c_ushort*3),('value',C.c_void_p),('padding',C.c_ulonglong)]
    text=C.c_void_p();store=C.c_void_p();value=Variant()
    ole.CoTaskMemFree.argtypes=[C.c_void_p]
    try:
        checked(call(device,5,C.POINTER(C.c_void_p))(device,C.byref(text)));identifier=C.wstring_at(text)
        checked(call(device,4,C.c_ulong,C.POINTER(C.c_void_p))(device,0,C.byref(store)))
        key=Key(GUID('A45C254E-DF1C-4EFD-8020-67D146A850E0'),14)
        checked(call(store,5,C.POINTER(Key),C.POINTER(Variant))(store,C.byref(key),C.byref(value)))
        if value.vt!=31:raise ValueError('音声デバイスの名前を取得できません。')
        return {'id':identifier,'name':C.wstring_at(value.value)}
    finally:
        ole.PropVariantClear(C.byref(value));release(store)
        if text:ole.CoTaskMemFree(text)

def render_devices():
    if os.name!='nt':return []
    ole=C.OleDLL('ole32')
    init=C.WinDLL('ole32').CoInitializeEx
    init.argtypes=[C.c_void_p,C.c_ulong];init.restype=C.c_long
    com_status=init(None,0)
    if com_status & 0xffffffff != 0x80010106:checked(com_status)
    enum=collection=default=None
    try:
        enum=create_enumerator(ole);default=C.c_void_p();checked(call(enum,4,C.c_int,C.c_int,C.POINTER(C.c_void_p))(enum,0,0,C.byref(default)))
        selected=device_info(default,ole)['id'];collection=C.c_void_p();checked(call(enum,3,C.c_int,C.c_ulong,C.POINTER(C.c_void_p))(enum,0,1,C.byref(collection)))
        count=C.c_uint();checked(call(collection,3,C.POINTER(C.c_uint))(collection,C.byref(count)))
        result=[]
        for index in range(count.value):
            device=C.c_void_p()
            try:
                checked(call(collection,4,C.c_uint,C.POINTER(C.c_void_p))(collection,index,C.byref(device)));info=device_info(device,ole)
                result.append({**info,'default':info['id']==selected})
            finally:release(device)
        return result
    finally:
        for item in [default,collection,enum]:release(item)
        if com_status>=0:ole.CoUninitialize()

class Loopback:
    def __init__(self,device_id='default',*,stereo=False,forbidden_name='',on_gap=None):
        self.device_id=device_id or 'default'
        self.stereo,self.forbidden_name,self.on_gap=stereo,forbidden_name,on_gap

    def run(self,stop,on_audio,on_ready=lambda:None):
        if os.name!='nt':raise ValueError('ずれの確認は現在Windowsに対応しています。')
        ole=C.OleDLL('ole32');enumerator=device=client=capture=None
        initialized=False;started=False
        try:
            ole.CoInitializeEx.argtypes=[C.c_void_p,C.c_ulong]
            checked(ole.CoInitializeEx(None,0));initialized=True
            enumerator=create_enumerator(ole)
            device=C.c_void_p()
            if self.device_id=='default':
                checked(call(enumerator,4,C.c_int,C.c_int,C.POINTER(C.c_void_p))(enumerator,0,0,C.byref(device)))
            else:
                checked(call(enumerator,5,C.c_wchar_p,C.POINTER(C.c_void_p))(enumerator,self.device_id,C.byref(device)))
            if self.forbidden_name and device_info(device,ole)['name'].casefold()==self.forbidden_name.casefold():raise ValueError('伴奏の再生先とMIXの出力先が同じです。MIXの出力先はCABLE Inputなど別のデバイスを選んでください。')
            client=C.c_void_p()
            checked(call(device,3,C.POINTER(GUID),C.c_ulong,C.c_void_p,C.POINTER(C.c_void_p))(device,C.byref(GUID('1CB9AD4C-DBFA-4c32-B178-C2F568A703B2')),23,None,C.byref(client)))
            fmt=WaveFormat(3,2,48000,384000,8,32,0)
            checked(call(client,3,C.c_int,C.c_ulong,C.c_longlong,C.c_longlong,C.POINTER(WaveFormat),C.c_void_p)(client,0,0x20000|0x80000000|0x08000000,1000000,0,C.byref(fmt),None))
            capture=C.c_void_p()
            checked(call(client,14,C.POINTER(GUID),C.POINTER(C.c_void_p))(client,C.byref(GUID('C8ADBD64-E71E-48a0-A4DE-185C395CD317')),C.byref(capture)))
            checked(call(client,10)(client));started=True;on_ready()
            first=True
            while not stop.wait(.01):
                count=C.c_uint();checked(call(capture,5,C.POINTER(C.c_uint))(capture,C.byref(count)))
                while count.value:
                    data=C.POINTER(C.c_ubyte)();frames=C.c_uint();flags=C.c_ulong();position=C.c_ulonglong();stamp=C.c_ulonglong()
                    checked(call(capture,3,C.POINTER(C.POINTER(C.c_ubyte)),C.POINTER(C.c_uint),C.POINTER(C.c_ulong),C.POINTER(C.c_ulonglong),C.POINTER(C.c_ulonglong))(capture,C.byref(data),C.byref(frames),C.byref(flags),C.byref(position),C.byref(stamp)))
                    try:
                        if flags.value&4 or not stamp.value:raise ValueError('伴奏の音声時刻を確認できません。')
                        if abs(stamp.value/10000000-time.monotonic())>2:raise ValueError('伴奏の音声時計が一致しないため確認できません。')
                        if flags.value&1 and not first:
                            if self.on_gap:self.on_gap()
                            else:raise ValueError('伴奏の音声が途切れました。確認を開始し直してください。')
                        samples=np.zeros((frames.value,2),np.float32) if flags.value&2 else np.frombuffer(C.string_at(data,frames.value*8),'<f4').reshape(-1,2).copy()
                        if not self.stereo:samples=samples.mean(axis=1)
                        on_audio(stamp.value/10000000,samples)
                        first=False
                    finally:checked(call(capture,4,C.c_uint)(capture,frames.value))
                    checked(call(capture,5,C.POINTER(C.c_uint))(capture,C.byref(count)))
        finally:
            if started:call(client,11)(client)
            for pointer in [capture,client,device,enumerator]:release(pointer)
            if initialized:ole.CoUninitialize()
