"""Read bounded, complete portions of an ongoing OBS MKV/Hybrid MP4 recording."""
import os
import re
import struct
import subprocess
import tempfile
from pathlib import Path
import numpy as np

MAX_TAIL=64*1024*1024
CLUSTER=b'\x1f\x43\xb6\x75'

def vint(data,offset):
    if offset>=len(data):raise ValueError('incomplete EBML')
    first=data[offset];width=next((n for n in range(1,9) if first&(1<<(8-n))),None)
    if width is None or offset+width>len(data):raise ValueError('incomplete EBML')
    return int.from_bytes(data[offset:offset+width],'big')&((1<<(7*width))-1),width

def mkv_snapshot(head,tail,tail_origin):
    first=head.find(CLUSTER)
    if first<0:raise ValueError('録画の音声ヘッダーがまだ書き出されていません。')
    positions=[];p=0
    while True:
        p=tail.find(CLUSTER,p)
        if p<0:break
        try:
            size,width=vint(tail,p+4);payload=p+4+width
            # A cluster must start with its timecode or optional CRC32, not a hit in video data.
            q=payload
            if tail[q:q+1]==b'\xbf':
                n,w=vint(tail,q+1);q+=1+w+n
            if tail[q:q+1]==b'\xe7':
                n,w=vint(tail,q+1)
                if 1<=n<=8 and q+1+w+n<=len(tail):positions.append((p,int.from_bytes(tail[q+1+w:q+1+w+n],'big')))
        except (ValueError,IndexError):pass
        p+=4
    if not positions:raise ValueError('録画の音声データを待っています。')
    scale=1000000;mark=head[:first].find(b'\x2a\xd7\xb1')
    if mark>=0:
        n,w=vint(head,mark+3)
        if 1<=n<=8:scale=int.from_bytes(head[mark+3+w:mark+3+w+n],'big')
    if not 1000<=scale<=1000000000:raise ValueError('録画の時刻単位を確認できません。')
    earliest=positions[-1][1]-40*1000000000/scale
    begin=next(p for p,stamp in positions if stamp>=earliest)
    return head[:first]+tail[begin:]

def boxes(data,start=0,end=None):
    end=len(data) if end is None else end;p=start
    while p+8<=end:
        size=int.from_bytes(data[p:p+4],'big');header=8
        if size==1:
            if p+16>end:return
            size=int.from_bytes(data[p+8:p+16],'big');header=16
        if size<header or p+size>end:return
        yield p,size,data[p+4:p+8],header
        p+=size

def rebase_moof(fragment,delta):
    data=bytearray(fragment)
    for p,n,k,h in boxes(data):
        if k!=b'moof':continue
        for t,tn,tk,th in boxes(data,p+h,p+n):
            if tk!=b'traf':continue
            for q,qn,qk,qh in boxes(data,t+th,t+tn):
                if qk==b'tfhd':
                    flags=int.from_bytes(data[q+qh:q+qh+4],'big')&0xffffff
                    if flags&1:
                        b=q+qh+8;old=int.from_bytes(data[b:b+8],'big');new=old+delta
                        if not 0<=new<2**64:raise ValueError('録画の断片位置を確認できません。')
                        data[b:b+8]=new.to_bytes(8,'big')
    return bytes(data)

def track_scales(init):
    result={}
    for p,n,k,h in boxes(init):
        if k!=b'moov':continue
        for t,tn,tk,th in boxes(init,p+h,p+n):
            if tk!=b'trak':continue
            identifier=scale=None
            for q,qn,qk,qh in boxes(init,t+th,t+tn):
                if qk==b'tkhd':
                    b=q+qh+(20 if init[q+qh]==1 else 12);identifier=int.from_bytes(init[b:b+4],'big')
                if qk==b'mdia':
                    for m,mn,mk,mh in boxes(init,q+qh,q+qn):
                        if mk==b'mdhd':
                            b=m+mh+(20 if init[m+mh]==1 else 12);scale=int.from_bytes(init[b:b+4],'big')
            if identifier and scale:result[identifier]=scale
    return result

def fragment_time(fragment,scales):
    for p,n,k,h in boxes(fragment):
        if k!=b'moof':continue
        for t,tn,tk,th in boxes(fragment,p+h,p+n):
            if tk!=b'traf':continue
            identifier=stamp=None
            for q,qn,qk,qh in boxes(fragment,t+th,t+tn):
                if qk==b'tfhd':identifier=int.from_bytes(fragment[q+qh+4:q+qh+8],'big')
                if qk==b'tfdt':stamp=int.from_bytes(fragment[q+qh+4:q+qh+(12 if fragment[q+qh]==1 else 8)],'big')
            if stamp is not None and identifier in scales:return stamp/scales[identifier]
    raise ValueError('録画断片の時刻を確認できません。')

def mp4_snapshot(head,tail,tail_origin):
    init=b''.join(head[p:p+n] for p,n,k,h in boxes(head) if k in (b'ftyp',b'moov'))
    if b'moov' not in init:raise ValueError('録画途中の解析にはMKVまたはHybrid MP4を使用してください。')
    fragments=[];p=0
    while True:
        marker=tail.find(b'moof',p+4)
        if marker<0:break
        p=marker
        begin=marker-4;n=int.from_bytes(tail[begin:marker],'big')
        if n<16 or n>4*1024*1024 or begin+n+8>len(tail):continue
        end=begin+n
        if tail[end+4:end+8]!=b'mdat':continue
        m=int.from_bytes(tail[end:end+4],'big')
        if m<8 or end+m>len(tail):continue
        stamp=fragment_time(tail[begin:end],track_scales(init))
        fragments.append((begin,end+m,stamp));p=end+m-4
    if not fragments:raise ValueError('完成した録画断片の書き出しを待っています。')
    result=init
    earliest=fragments[-1][2]-40
    for begin,end,stamp in fragments:
        if stamp>=earliest:result+=rebase_moof(tail[begin:end],len(result)-(tail_origin+begin))
    return result

def snapshot(file):
    path=Path(file)
    with path.open('rb') as source:
        size=os.fstat(source.fileno()).st_size
        if not size:raise ValueError('録画ファイルの書き出しを待っています。')
        head=source.read(min(size,2*1024*1024));origin=max(0,size-MAX_TAIL)
        source.seek(origin);tail=source.read(min(size,MAX_TAIL))
    if head.startswith(b'\x1a\x45\xdf\xa3'):return mkv_snapshot(head,tail,origin),'.mkv'
    if head[4:8] in (b'ftyp',b'free'):return mp4_snapshot(head,tail,origin),'.mp4'
    raise ValueError('ずれの確認はMKVまたはHybrid MP4の録画に対応しています。')

def decode_recording(ffmpeg,file,track=0):
    data,suffix=snapshot(file)
    # Scratch copy contains only the recent bounded compressed fragments, never the full recording.
    with tempfile.TemporaryDirectory(prefix='yui-passive-') as folder:
        temp=Path(folder)/('recent'+suffix);temp.write_bytes(data)
        result=subprocess.run([ffmpeg,'-nostdin','-v','info','-copyts','-i',str(temp),'-map',f'0:a:{track}','-vn','-t','50','-af','aresample=16000,asetpts=PTS-STARTPTS,ashowinfo','-ac','1','-f','f32le','pipe:1'],capture_output=True,timeout=12)
    if not result.stdout:raise ValueError('録画の音声を待っています。声と伴奏を同じ録画トラックに入れてください。')
    # Correlation only uses relative positions within this one mix, so a common PTS origin cancels.
    frames=re.findall(rb'ashowinfo.*?pts_time:([-\d.]+).*?rate:(\d+).*?nb_samples:(\d+)',result.stderr)
    if not frames:raise ValueError('録画の音声時刻を確認できませんでした。')
    previous=None
    for pts,rate,n in frames:
        begin=float(pts);end=begin+int(n)/int(rate)
        if previous is not None and abs(begin-previous)>.025:raise ValueError('録画内の音声時刻が途切れています。次の区間を待っています。')
        previous=end
    audio=np.frombuffer(result.stdout,'<f4').astype(np.float64)
    if len(audio)>16000*51 or not np.isfinite(audio).all():raise ValueError('録画の音声を解析できませんでした。')
    return audio
