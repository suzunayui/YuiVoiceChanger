from pathlib import Path
import re,shutil,sys,json,subprocess
PIN='2dc3fd3a0cc84a2933f2194e7ec0871584979071'
source=Path(sys.argv[1]).resolve();dest=Path(sys.argv[2]).resolve();overlay=Path(__file__).resolve().parent
if dest.is_relative_to(source):raise SystemExit('Output must be outside the upstream checkout')
if dest.exists():raise SystemExit('Use a fresh output directory; existing work is never overwritten.')
if subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()!=PIN:raise SystemExit('Unexpected upstream revision')
shutil.copytree(source/'audio/sysvad',dest)
shutil.copy2(source/'LICENSE',dest/'MICROSOFT-LICENSE.txt')
def edit(name,fn):
 p=dest/name;s=p.read_text(encoding='utf-8-sig');p.write_text(fn(s),encoding='utf8')
def exact(s,old,new):
 if s.count(old)!=1:raise ValueError('Patch anchor mismatch: '+old[:70])
 return s.replace(old,new)
edit('TabletAudioSample/minipairs.h',lambda s:re.sub(r'(g_RenderEndpoints\[\]\s*=\s*\{).*?(\};)',r'\1\n    &SpdifMiniports,\n\2',re.sub(r'(g_CaptureEndpoints\[\]\s*=\s*\{).*?(\};)',r'\1\n    &MicInMiniports,\n\2',s,flags=re.S),flags=re.S))
# One fixed PCM format per endpoint; shared WASAPI handles client rate/channel conversion.
def format_table(ch):
 return '''{ { { sizeof(KSDATAFORMAT_WAVEFORMATEXTENSIBLE),0,0,0,
 STATICGUIDOF(KSDATAFORMAT_TYPE_AUDIO),STATICGUIDOF(KSDATAFORMAT_SUBTYPE_PCM),
 STATICGUIDOF(KSDATAFORMAT_SPECIFIER_WAVEFORMATEX) },
 { { WAVE_FORMAT_EXTENSIBLE,%d,48000,%d,%d,16,sizeof(WAVEFORMATEXTENSIBLE)-sizeof(WAVEFORMATEX) },
 16,%s,STATICGUIDOF(KSDATAFORMAT_SUBTYPE_PCM) } } };'''%(ch,48000*ch*2,ch*2,'KSAUDIO_SPEAKER_MONO' if ch==1 else 'KSAUDIO_SPEAKER_STEREO')
def formats(s,ch,prefix):
 s=re.sub(r'(KSDATAFORMAT_WAVEFORMATEXTENSIBLE\s+\w+\[\]\s*=)\s*\{.*?\n\};',lambda m:m[1]+format_table(ch),s,flags=re.S)
 s=re.sub(r'(PinSupportedDeviceFormats|HostPinSupportedDeviceFormats|OffloadPinSupportedDeviceFormats)\[[^\]]+\]',r'\1[0]',s)
 # Previous regex must not change array declarations [] (nonempty matcher).
 s=re.sub(r'(#define\s+\w+(?:MIN|MAX)_SAMPLE_RATE\s+)\d+',r'\g<1>48000',s)
 if prefix=='MICIN':s=re.sub(r'(#define MICIN_MAX_INPUT_STREAMS\s+)\d+',r'\g<1>1',s)
 else:
  s=re.sub(r'(#define SPDIF_MAX_INPUT_SYSTEM_STREAMS\s+)\w+',r'\g<1>1',s)
  s=re.sub(r'(#define SPDIF_MAX_(?:INPUT_OFFLOAD|OUTPUT_LOOPBACK)_STREAMS\s+)\w+',r'\g<1>0',s)
 return s
edit('TabletAudioSample/micinwavtable.h',lambda s:formats(s,1,'MICIN'))
edit('TabletAudioSample/spdifwavtable.h',lambda s:formats(s,2,'SPDIF'))
for name in ['bridge_ring.h','bridge_kernel.h','bridge_kernel.inc']:shutil.copy2(overlay/name,dest/'EndpointsCommon'/name)
def stream(s):
 s=exact(s,'m_ToneGenerator.GenerateSine(m_pDmaBuffer + bufferOffset, runWrite);','''if (m_pMiniport->IsLoopbackPin(m_ulPin)) RtlZeroMemory(m_pDmaBuffer+bufferOffset,runWrite);
            else YuiBridgeCapture(m_pDmaBuffer+bufferOffset,runWrite);''')
 s=exact(s,'m_SaveData.WriteData(m_pDmaBuffer + bufferOffset, runWrite);','YuiBridgeRender(m_pDmaBuffer+bufferOffset,runWrite);')
 def remove_block(text,marker):
  start=text.index(marker);brace=text.index('{',start);depth=1;end=brace+1
  while depth:
   depth+=(text[end]=='{')-(text[end]=='}');end+=1
  return text[:start]+text[end:]
 s=remove_block(s,'else if (!g_DoNotCreateDataFiles)')
 s=remove_block(s,'if (!m_bCapture && !g_DoNotCreateDataFiles)')
 s=exact(s,'''        if (!g_DoNotCreateDataFiles)
        {
            // Read from buffer and write to a file.
            ReadBytes(ByteDisplacement);
        }''','''        // Forward rendered PCM to the capture endpoint without file I/O.
        ReadBytes(ByteDisplacement);''')
 s=exact(s,'    switch (State_)\n','    if (!m_bCapture && State_ != KSSTATE_RUN) YuiBridgeReset();\n    switch (State_)\n')
 s=exact(s, '    m_pMiniport = reinterpret_cast<CMiniportWaveRT*>(Miniport_);', '''    if (pWfEx->nSamplesPerSec != 48000 || pWfEx->wBitsPerSample != 16 ||
        pWfEx->nChannels != (Capture_ ? 1 : 2) ||
        pWfEx->nBlockAlign != (Capture_ ? 2 : 4)) return STATUS_NOT_SUPPORTED;
    m_pMiniport = reinterpret_cast<CMiniportWaveRT*>(Miniport_);''')
 s='#include "bridge_kernel.h"\n'+s+'\n#pragma code_seg()\n#include "bridge_kernel.inc"\n'
 return s
edit('EndpointsCommon/minwavertstream.cpp',stream)
edit('adapter.cpp',lambda s:'#include "bridge_kernel.h"\n'+exact(s,'    DPF(D_TERSE, ("[DriverEntry]"));','    YuiBridgeInitialize();\n    DPF(D_TERSE, ("[DriverEntry]"));'))
# No Bluetooth/USB bypass or dynamic endpoints in this single-adapter prototype.
for name in ['TabletAudioSample/TabletAudioSample.vcxproj','EndpointsCommon/EndpointsCommon.vcxproj']:
 edit(name,lambda s:s.replace(';SYSVAD_BTH_BYPASS','').replace(';SYSVAD_USB_SIDEBAND',''))
project=dest/'TabletAudioSample/TabletAudioSample.vcxproj';s=project.read_text();s=s.replace('<Import Project="$(VCTargetsPath)\\Microsoft.Cpp.props" />','<Import Project="$(VCTargetsPath)\\Microsoft.Cpp.props" />\n<PropertyGroup><TargetName>YuiMicrophone</TargetName></PropertyGroup>');project.write_text(s)
original=(dest/'TabletAudioSample/ComponentizedAudioSample.inx').read_text(encoding='utf-16')
sections=dict(re.findall(r'^\[([^\]]+)\]\s*\n(.*?)(?=^\[|\Z)',original,flags=re.M|re.S))
strings=sections['Strings']
for key,value in [('ProviderName','YUI'),('MfgName','YUI'),('MicInCustomName','Yui Microphone'),('SYSVAD.WaveMicIn.szPname','Yui Microphone'),('SYSVAD.TopologyMicIn.szPname','Yui Microphone'),('SYSVAD.WaveSpdif.szPname','Yui Voice Input'),('SYSVAD.TopologySpdif.szPname','Yui Voice Input')]:
 strings=re.sub(r'(?m)^'+re.escape(key)+r'\s*=.*$',key+'="'+value+'"',strings)
inf='''; Yui Microphone prototype. Microsoft SysVAD-derived topology sections.
[Version]
Signature="$Windows NT$"
Class=MEDIA
ClassGUID={4d36e96c-e325-11ce-bfc1-08002be10318}
Provider=%ProviderName%
DriverVer=10/10/2026,0.1.0.0
CatalogFile=YuiMicrophone.cat
PnpLockDown=1
[Manufacturer]
%MfgName%=Yui,NT$ARCH$.10.0...22621
[Yui.NT$ARCH$.10.0...22621]
"Yui Microphone"=Yui,ROOT\\YuiMicrophone
[SourceDisksNames]
1="Yui Microphone"
[SourceDisksFiles]
YuiMicrophone.sys=1
[DestinationDirs]
Yui.Copy=13
[Yui.Copy]
YuiMicrophone.sys
[Yui.NT]
Include=ks.inf,wdmaudio.inf
Needs=KS.Registration,WDMAUDIO.Registration
CopyFiles=Yui.Copy
AddReg=Yui.AddReg
[Yui.AddReg]
HKR,,AssociatedFilters,,"wdmaud"
HKR,,Driver,,YuiMicrophone.sys
HKR,Drivers,SubClasses,,"wave,mixer"
HKR,Drivers\\wave\\wdmaud.drv,Driver,,wdmaud.drv
HKR,Drivers\\wave\\wdmaud.drv,Description,,"Yui Microphone"
HKR,%MEDIA_CATEGORIES%\\%MicInCustomNameGUID%,Name,,%MicInCustomName%
[Yui.NT.Services]
AddService=YuiMicrophone,0x00000002,Yui.Service
[Yui.Service]
DisplayName="Yui Microphone"
ServiceType=1
StartType=3
ErrorControl=1
ServiceBinary=%13%\\YuiMicrophone.sys
[Yui.NT.Wdf]
KmdfService=YuiMicrophone,Yui.Wdf
[Yui.Wdf]
KmdfLibraryVersion=$KMDFVERSION$
[Yui.NT.Interfaces]
'''
for endpoint,category in [('Spdif','RENDER'),('MicIn','CAPTURE')]:
 for cat in ['AUDIO',category,'REALTIME']:inf+=f'AddInterface=%KSCATEGORY_{cat}%,"Wave{endpoint}",SYSVAD.I.Wave{endpoint}\n'
 for cat in ['AUDIO','TOPOLOGY']:inf+=f'AddInterface=%KSCATEGORY_{cat}%,"Topology{endpoint}",SYSVAD.I.Topology{endpoint}\n'
for section in ['SYSVAD.I.'+kind+ep+suffix for ep in ['Spdif','MicIn'] for kind in ['Wave','Topology'] for suffix in ['', '.AddReg']]:
 inf+='\n['+section+']\n'+sections[section]
inf+='\n[Strings]\n'+strings
for path in (dest/'TabletAudioSample').glob('*.inx'):path.unlink()
(dest/'TabletAudioSample/YuiMicrophone.inx').write_text(inf,encoding='utf8')
(dest/'yui-build-manifest.json').write_text(json.dumps({'upstream':PIN,'status':'unbuilt prototype','render':'Yui Voice Input: PCM16 stereo 48000','capture':'Yui Microphone: PCM16 mono 48000'}),encoding='utf8')
print(dest)
