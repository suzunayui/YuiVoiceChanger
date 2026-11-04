# Third-party notices

Original application code is MIT licensed, copyright 2026 YUI.
Electron and React are MIT licensed. Retain Electron's LICENSE.electron.txt and LICENSES.chromium.html in packaged distributions.

The in-app help viewer uses react-markdown (MIT, copyright Espen Hovlandsdal), remark-gfm (MIT, copyright Titus Wormer), and their unified/remark/rehype dependencies. Their package license files are retained with the production dependencies in the packaged application.

## Beatrice model definitions

`backend/beatrice_model.py` is extracted and adapted from `beatrice_trainer/__main__.py` in https://github.com/fierce-cats/beatrice-trainer.
Copyright (c) 2024 Project Beatrice, MIT License. The complete notice is retained in `backend/BEATRICE_LICENSE.txt` and included in packaged resources.
`backend/model_provenance.json` records the source SHA256 and inference-only changes, including disabling attention dropout in evaluation.
No learned weights are bundled or modified. The model's own terms remain separate.

The initial setup can download Beatrice 2.0.0-rc.0 Official Model 1 directly from https://storage.prj-beatrice.com/ after the user's explicit consent click. Its files are not part of this repository or installer and must not be redistributed with the application. The original README, portraits and metadata are retained in the user's local installation. Terms: https://prj-beatrice.com/2.0.0-rc.0-official-model-1-terms . The selected voice is つくよみちゃん（コーパス）/ voice 1; applicable character/converted-audio terms remain in effect. The consent receipt records the terms URL and timestamp locally.

## Isolated runtime

The Windows setup downloads uv 0.13.6 (Astral, MIT/Apache-2.0) from its official GitHub release, verifies its SHA256 and uses it to install CPython 3.15.2 from python-build-standalone.
Python uses the PSF License; notices for Python and bundled libraries remain in the installed runtime.
GPU PyTorch 2.15.0 / CUDA 13.2 is downloaded from the official PyTorch wheel host. Its BSD-style and NVIDIA component notices remain in the environment.
TorchAudio, NumPy, python-sounddevice, SoundFile, CFFI and transitive dependencies retain their license notices in package/dist-info directories. NumPy and TorchAudio use BSD-style licenses; python-sounddevice and CFFI use MIT licenses. PortAudio has an MIT-style license.
Exact runtime requirements are in `requirements.txt`. No Python runtime, CUDA runtime, audio libraries or learned weights are embedded in the application installer.

The Apple Silicon preview uses the same uv version, verified against the upstream aarch64-apple-darwin archive SHA256. It installs CPython 3.15.2 and the macOS ARM64 CPU PyTorch wheel listed in `requirements-mac.txt`. The runtime's third-party notices stay in that isolated environment. No Apple GPU inference or RVC training support is claimed for this preview.

The current runtime does not load Pedalboard, a VST plugin or the official Beatrice inference library. Exported Beatrice FP16 weights are read using the public trainer's serialization order; no proprietary inference library is extracted.

## RVC teacher and model training

`backend/rvc/` vendors the MIT-licensed RVC v1/v2 synthesizer and RMVPE implementation from RVC-Project, with imports adapted for this app and unused library dependencies removed. See `backend/rvc/LICENSE.txt` and `provenance.json`. Learned RVC weights are not bundled.
HuBERT/ContentVec is loaded into TorchAudio's native Wav2Vec2 model using the public Hugging Face-format weights. No Transformers or Fairseq runtime is required.
`backend/training_support.py` retains the Beatrice trainer's adversarial losses/discriminators. Its upstream GradBalancer is adapted from Meta EnCodec; the full Meta MIT notice is retained as `backend/ENCODEC_LICENSE.txt`.
The optional ONNX helper uses CPython 3.14.10, ONNX Runtime GPU 1.31.1 (MIT), NumPy and their dependencies. ONNX (Apache-2.0), Protobuf and ml-dtypes notices remain in their installed distributions.
Optional common training assets are fetched from the fixed upstream model revisions recorded in `electron/model-assets.cjs`, with hashes checked for weight files. Models and generated training audio are local user content, excluded from the repository and installer. Their terms remain separate from application code.

## Experimental Yui Microphone driver

The optional source preparation tool uses Microsoft Windows-driver-samples/SysVAD at commit 2dc3fd3a0cc84a2933f2194e7ec0871584979071 (MIT, Microsoft Corporation).
Upstream sources are fetched separately and their LICENSE is copied to generated build trees as MICROSOFT-LICENSE.txt. No driver binary is bundled. The independent PCM bridge and preparation scripts are MIT licensed.
The application does not build, sign or install the experimental driver during normal use.

## YuiVoiceChanger OBS plugin (Windows)

The optional OBS plugin in `obs-plugin/` is distributed with its source and GPL-2.0-or-later license. Its delay filter is based on OBS Studio 33.0.1. OBS provides the libobs and Qt libraries used at runtime.
