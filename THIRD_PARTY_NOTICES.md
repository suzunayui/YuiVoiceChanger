# Third-party notices

Original application code is MIT licensed, copyright 2026 YUI.
Electron and React are MIT licensed. NumPy is BSD-3-Clause licensed.
python-sounddevice is MIT licensed; PortAudio has its own MIT-style license.
Retain LICENSE.electron.txt and LICENSES.chromium.html from packaged Electron.

## Beatrice VST host

The Beatrice adapter hosts a separately installed official Beatrice 2.0.0-rc.3
VST3 through Pedalboard 0.9.25 (Spotify, GPLv3). Pedalboard is an external local
dependency, not a bundled MIT component. Distribution of the combined program
requires compliance with its applicable GPL conditions; installing it externally
does not itself resolve distribution obligations.

The preset format was implemented using the public interface in
https://github.com/prj-beatrice/beatrice-vst (MIT, Project Beatrice and
Contributors). The official VST and its inference library and model licenses
remain separate; they are not relicensed by this repository. The VST archive,
proprietary milk models, images and test recordings remain local and excluded
from Git. No inference library is extracted or called directly.

## Historical sources

The RVC WebUI and w-okada/voice-changer integrations and submodules were removed.
Their notices remain in Git history alongside the old sources. The current
runtime does not import either project. Models and recordings are not bundled.

自動セットアップは公式python.orgからPython 3.12.10（PSF License）を、PyPIからNumPy、sounddevice、pedalboard、cffi（MIT）、pycparser（BSD）を個人PCへ取得します。ライセンス文書は取得したランタイムと各パッケージのdist-info内に保持します。VST・モデルはこの処理に含めません。

Macの自動セットアップはAstralのpython-build-standalone（CPython 3.12.11、Apple Silicon）を公式GitHub Releasesから取得します。Pythonと同梱ライブラリの各ライセンスは取得物に含まれる表記を参照してください。Mac版もVST・音声モデルは同梱しません。配布用ZIPには公式Electronのライセンス・Chromium等の表記を保持します。

## Experimental Yui Microphone driver

The optional source preparation tool uses Microsoft Windows-driver-samples/SysVAD at commit 2dc3fd3a0cc84a2933f2194e7ec0871584979071 (MIT, Microsoft Corporation). Upstream sources are fetched separately and their LICENSE is copied to each generated build tree as MICROSOFT-LICENSE.txt. No driver binary is bundled. The independent PCM bridge and preparation scripts are MIT licensed. The prototype is not built, signed, installed or verified as a Windows audio device.
