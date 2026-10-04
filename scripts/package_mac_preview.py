"""Preserve official Electron's Unix permissions and framework symlinks in a preview ZIP."""
import copy
import json
import plistlib
from pathlib import Path
import sys
import zipfile

root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'package.json').read_text(encoding='utf8'))['version']
destination = root / 'release' / f'YuiVoiceChanger-{version}-mac-arm64-preview.zip'
prefix = 'YuiVoiceChanger.app/Contents/'


def add(z, name, data, mode=0o100644):
    info = zipfile.ZipInfo(name)
    info.create_system = 3
    info.external_attr = mode << 16
    info.compress_type = zipfile.ZIP_DEFLATED
    z.writestr(info, data)


with zipfile.ZipFile(sys.argv[1]) as upstream, zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as out:
    for original in upstream.infolist():
        info = copy.copy(original)
        if info.filename == 'LICENSE':
            info.filename = 'ELECTRON-LICENSE.txt'
        info.filename = info.filename.replace('Electron.app/', 'YuiVoiceChanger.app/', 1)
        if info.filename == prefix + 'Resources/default_app.asar':
            continue
        data = upstream.read(original)
        if info.filename == prefix + 'Info.plist':
            metadata = plistlib.loads(data)
            metadata.update(CFBundleIdentifier='com.suzunayui.yuivoicechanger',
                            CFBundleName='YuiVoiceChanger', CFBundleDisplayName='YuiVoiceChanger',
                            CFBundleVersion=version.split('-')[0], CFBundleShortVersionString=version.split('-')[0],
                            NSMicrophoneUsageDescription='声をリアルタイムで変換するためにマイクを使用します。')
            data = plistlib.dumps(metadata)
        if info.filename == prefix + 'Resources/electron.icns':
            data = (root / 'assets/icon.icns').read_bytes()
        out.writestr(info, data)
    add(out, prefix + 'Resources/app.asar', Path(sys.argv[2]).read_bytes())
    for name in ('worker.py', 'realtime.py', 'beatrice.py', 'singing.py', '__init__.py'):
        add(out, prefix + 'Resources/backend/' + name, (root / 'backend' / name).read_bytes())
    add(out, '起動準備.command', (root / 'scripts/mac-first-launch.command').read_bytes().replace(b'\r\n', b'\n'), 0o100755)
    add(out, 'Mac版の使い方.txt', (root / 'docs/mac-preview.md').read_bytes())
    add(out, 'THIRD_PARTY_NOTICES.md', (root / 'THIRD_PARTY_NOTICES.md').read_bytes())
    add(out, 'LICENSE', (root / 'LICENSE').read_bytes())

with zipfile.ZipFile(destination) as check:
    main = check.getinfo(prefix + 'MacOS/Electron')
    assert (main.external_attr >> 16) & 0o111, 'Main executable lost its Unix permissions'
    links = [x for x in check.infolist() if (x.external_attr >> 16) & 0o170000 == 0o120000]
    assert links, 'Framework symlinks were lost'
    assert check.read(prefix + 'Resources/app.asar') == Path(sys.argv[2]).read_bytes()
    assert plistlib.loads(check.read(prefix + 'Info.plist'))['NSMicrophoneUsageDescription']
print(f'Created {destination} (preserved {len(links)} framework symlinks).')
