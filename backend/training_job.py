"""Resumable RVC teacher generation and Beatrice fine-tuning subprocess."""
from pathlib import Path
import gzip
import hashlib
import json
import math
import os
import random
import sys
import threading
import time
import traceback

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import numpy as np
import soundfile as sf
import torch
import torchaudio
from backend import beatrice_model as m
from backend.model_tools import gpu_info,inspect_model

CANCEL=threading.Event()


def emit(**value):
    print(json.dumps(value,ensure_ascii=False,allow_nan=False),flush=True)


def atomic_json(path, value):
    temporary=path.with_suffix(path.suffix+'.tmp')
    temporary.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')
    temporary.replace(path)


def control():
    for line in sys.stdin:
        try:
            if json.loads(line).get('command')=='cancel':CANCEL.set()
        except (ValueError,TypeError):pass
    CANCEL.set()


def audio_files(folder):
    root=Path(folder)
    if not root.is_dir():raise ValueError('学習素材の音声フォルダを選んでください。')
    files=sorted(p for p in root.rglob('*') if p.is_file() and p.suffix.lower() in ('.wav','.flac','.ogg','.mp3'))
    if not files:raise ValueError('音声フォルダにWAV/FLAC/OGG/MP3がありません。')
    if len(files)>5000:raise ValueError('学習素材は5000ファイル以内にしてください。')
    return files


def fingerprint(files):
    result=[]
    for file in files:
        stat=file.stat()
        result.append(dict(path=str(file.resolve()),size=stat.st_size,mtime=stat.st_mtime_ns))
    return result


def prepare_data(config, job):
    from backend.rvc_teacher import RvcTeacher
    files=audio_files(config['audio'])
    info=inspect_model(config['source'])
    signature={'source':fingerprint([Path(config['source'])]),'audio':fingerprint(files),'pitch':config['pitch']}
    manifest=job/'dataset.json'
    if manifest.exists() and json.loads(manifest.read_text(encoding='utf-8'))['signature']!=signature:
        raise ValueError('モデルまたは素材が変更されています。新しい学習を開始してください。')
    data={'signature':signature,'files':[]}
    if manifest.exists():data=json.loads(manifest.read_text(encoding='utf-8'))
    outputs={row['id']:row for row in data['files']}
    teacher=RvcTeacher(config['source'],config['assets'],helper_python=config.get('helper'),work=job/'onnx-cache')
    try:
        for index,file in enumerate(files):
            if CANCEL.is_set():return None
            source,rate=sf.read(file,dtype='float32',always_2d=True)
            source=source.mean(axis=1)
            source=torchaudio.functional.resample(torch.from_numpy(source),rate,16000).numpy()
            for piece,start in enumerate(range(0,len(source),16000*12)):
                if CANCEL.is_set():return None
                identity=f'{index:05d}_{piece:03d}'
                output=job/'teacher'/f'{identity}.wav'
                if identity in outputs and output.is_file():continue
                x=source[start:start+16000*12].copy()
                if len(x)<16000:continue
                if not np.isfinite(x).all():raise ValueError('素材に不正な音声があります: '+file.name)
                peak=float(np.max(np.abs(x)))
                if peak<1e-5:continue
                x*=min(4,.8/peak)
                pad=8000
                padded=np.pad(x,(pad,pad),mode='reflect')
                padded=np.pad(padded,(0,-len(padded)%320))
                converted,out_rate=teacher.convert(padded,shift=config['pitch'])
                offset=round(pad*out_rate/16000)
                converted=converted[offset:offset+round(len(x)*out_rate/16000)]
                if len(converted)<out_rate or not np.isfinite(converted).all():raise RuntimeError('教材音声の生成に失敗しました: '+file.name)
                peak=float(np.max(np.abs(converted)))
                if peak<1e-5:raise RuntimeError('RVCの生成結果が無音です: '+file.name)
                converted*=min(4,.8/peak)
                converted=torchaudio.functional.resample(torch.from_numpy(converted),out_rate,24000).numpy()
                output.parent.mkdir(parents=True,exist_ok=True)
                sf.write(output,converted,24000,subtype='PCM_24')
                row=dict(id=identity,path=str(output),seconds=len(converted)/24000,
                         split='holdout' if index%10==9 and len(files)>=10 else 'train')
                data['files'].append(row);outputs[identity]=row
                atomic_json(manifest,data)
            emit(phase='generating',current=index+1,total=len(files),message=f'教材音声を生成中: {index+1}/{len(files)}')
    finally:teacher.close()
    if sum(x['seconds'] for x in data['files'] if x['split']=='train')<10:
        raise ValueError('有効な教材音声が足りません。10秒以上、品質のためには数分以上の素材を用意してください。')
    return data


def load_torch(path):
    with gzip.open(path,'rb') as file:return torch.load(file,map_location='cpu',weights_only=True)


def train(config, job, dataset):
    from backend.training_support import MultiPeriodDiscriminator,GradBalancer
    torch.manual_seed(42);rng=random.Random(42)
    assets=Path(config['assets'])/'beatrice'
    state_path=job/'training-state.pt.gz'
    resume=state_path.is_file()
    base=load_torch(state_path if resume else assets/'base.pt.gz')
    h=base.get('h',dict(m.dict_default_hparams))
    phone,pitch=m.PhoneExtractor(),m.PitchEstimator()
    phone.load_state_dict(base['phone_extractor'] if resume else torch.load(assets/'phone.pt',map_location='cpu',weights_only=True)['phone_extractor'])
    pitch.load_state_dict(base['pitch_estimator'] if resume else torch.load(assets/'pitch.pt',map_location='cpu',weights_only=True)['pitch_estimator'])
    phone.eval().requires_grad_(False).cuda();pitch.eval().requires_grad_(False).cuda()
    net=m.ConverterNetwork(phone,pitch,1,h['pitch_bins'],h['hidden_channels'],h['vq_topk'],
                           h['training_time_vq'],h['phone_noise_ratio'],h['floor_noise_level']).cuda()
    weights=base['net_g']
    for key in ('embed_speaker.weight','key_value_speaker_embedding.weight','vq.codebooks'):weights[key]=weights[key][:1]
    net.load_state_dict(weights)
    discriminator=MultiPeriodDiscriminator(san=False).cuda()
    discriminator.load_state_dict(base['net_d'])
    optimizer_g=torch.optim.AdamW(net.parameters(),lr=5e-5,betas=(.8,.99),eps=1e-6)
    optimizer_d=torch.optim.AdamW(discriminator.parameters(),lr=5e-5,betas=(.8,.99),eps=1e-6)
    scaler=torch.amp.GradScaler('cuda')
    balancer=GradBalancer(dict(loss_loudness=1.,loss_mel=50.,loss_adv=150.,loss_fm=150.))
    iteration=0
    if resume:
        optimizer_g.load_state_dict(base['optimizer_g']);optimizer_d.load_state_dict(base['optimizer_d'])
        scaler.load_state_dict(base['scaler']);balancer.load_state_dict(base['balancer'])
        iteration=base['iteration']
    del base
    files=[Path(row['path']) for row in dataset['files'] if row['split']=='train']
    if not resume:
        emit(phase='codebooks',message='生成した声の特徴を学習準備中')
        def items():
            for file in files:
                if CANCEL.is_set():return
                audio,sr=sf.read(file,dtype='float32')
                x=torchaudio.functional.resample(torch.from_numpy(audio[:24000*8]),24000,16000)
                x=F_pad(x,(-len(x))%160)
                yield x[None,None]
        net.initialize_vq([items()])
    net.train();discriminator.train()
    started=time.monotonic()
    output=job/'model.pt.gz'
    def save(progress):
        emit(phase='saving',current=progress,total=config['steps'],message='学習状態を保存しています')
        data=dict(h=h,net_g={k:v.detach().cpu() for k,v in net.state_dict().items()},
                  phone_extractor={k:v.detach().cpu() for k,v in phone.state_dict().items()},
                  pitch_estimator={k:v.detach().cpu() for k,v in pitch.state_dict().items()},iteration=progress)
        def write(path,value):
            temporary=path.with_name(path.name+'.tmp')
            with gzip.open(temporary,'wb',compresslevel=1) as stream:torch.save(value,stream)
            temporary.replace(path)
        write(output,data)
        data.update(net_d={k:v.detach().cpu() for k,v in discriminator.state_dict().items()},
                    optimizer_g=optimizer_g.state_dict(),optimizer_d=optimizer_d.state_dict(),
                    scaler=scaler.state_dict(),balancer=balancer.state_dict())
        write(state_path,data)
        atomic_json(job/'model.json',dict(name=Path(config['source']).stem,source=config['source'],steps=progress,
                     model=str(output),training_method='RVC teacher audio + Beatrice adversarial fine-tuning',
                     quality='Requires listening evaluation; matching source quality is not guaranteed.'))
    initial=iteration
    try:
        while iteration<config['steps'] and not CANCEL.is_set():
            audio,sr=sf.read(rng.choice(files),dtype='float32')
            samples=24000*4
            start=rng.randrange(max(1,len(audio)-samples+1))
            target=audio[start:start+samples]
            target=np.pad(target,(0,samples-len(target)))
            clean=torch.from_numpy(target)[None,None].cuda()
            source=torchaudio.functional.resample(torch.from_numpy(target),24000,16000)
            source=(source+torch.randn_like(source)*rng.uniform(0,.003))[None,None].cuda()
            sid=torch.zeros(1,dtype=torch.long,device='cuda')
            formant=torch.zeros(1,device='cuda')
            slice_start=torch.tensor([rng.randrange(0,300)],device='cuda')
            optimizer_g.zero_grad(set_to_none=True);optimizer_d.zero_grad(set_to_none=True)
            with torch.amp.autocast('cuda',dtype=torch.float16):
                y,y_hat,y_all,loss_loudness,loss_mel,_,_=net.forward_and_compute_loss(source,sid,formant,slice_start,100,clean,enable_loss_ap=False)
                loss_d,loss_adv,loss_fm,_=discriminator.forward_and_compute_loss(y,y_hat)
            losses=dict(loss_loudness=loss_loudness,loss_mel=loss_mel,loss_adv=loss_adv,loss_fm=loss_fm)
            if not all(torch.isfinite(x).item() for x in [loss_d,*losses.values()]):raise RuntimeError('学習の損失が非有限値になりました。素材を確認してください。')
            scaler.scale(loss_d).backward(retain_graph=True,inputs=list(discriminator.parameters()))
            balancer.backward(losses,y_all,scaler)
            scaler.step(optimizer_g);scaler.step(optimizer_d);scaler.update()
            iteration+=1
            if iteration==initial+1 or iteration%10==0 or iteration==config['steps']:
                seconds=(time.monotonic()-started)/(iteration-initial)
                emit(phase='training',current=iteration,total=config['steps'],eta_seconds=round(seconds*(config['steps']-iteration)),
                     loss_mel=float(loss_mel.detach()),message=f'学習中: {iteration}/{config["steps"]}')
            if iteration%500==0:save(iteration)
    finally:
        if iteration>initial:save(iteration)
    return output if output.exists() else None


def F_pad(x,count):
    return torch.nn.functional.pad(x,(0,count))


def main(config):
    torch.set_num_threads(2)
    info=gpu_info()
    if not info['eligible']:raise RuntimeError(info['reason'])
    job=Path(config['job']);job.mkdir(parents=True,exist_ok=True)
    emit(phase='generating',message='RVCで学習用の音声を生成しています')
    data=prepare_data(config,job)
    if data is None or CANCEL.is_set():return None
    torch.cuda.empty_cache()
    return train(config,job,data)


if __name__=='__main__':
    for stream in (sys.stdin,sys.stdout,sys.stderr):stream.reconfigure(encoding='utf-8')
    config=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    threading.Thread(target=control,daemon=True).start()
    try:
        model=main(config)
        emit(phase='cancelled' if CANCEL.is_set() else 'completed',model=str(model) if model else None,
             message='中断しました。保存した状態から再開できます。' if CANCEL.is_set() else '学習モデルを作成しました。試聴して確認してください。')
    except Exception as exc:
        traceback.print_exc()
        if CANCEL.is_set():emit(phase='cancelled',message='中断しました。前回の学習を再開できます。')
        else:
            message='GPUメモリが不足しました。他のGPUアプリを閉じてから再開してください。' if isinstance(exc,torch.cuda.OutOfMemoryError) else str(exc)
            emit(phase='failed',message=message)
        raise SystemExit(1)
