# YuiVoiceChanger

Windows向けのBeatrice専用リアルタイムボイスチェンジャーです。
Electron / Reactの画面とPythonの音声処理を組み合わせ、CPUで変換します。
RVC・VCClient・CUDAは不要です。

## インストールして使う

[Releases](https://github.com/suzunayui/YuiVoiceChanger/releases/latest)からインストーラーを取得します。

1. 起動後「必要な環境を自動セットアップ」を押します。Pythonやコマンドの知識は不要です。初回はネット接続が必要です。
2. 「VSTのダウンロード先」から公式Windows版ZIPを取得・展開し、フォルダを選びます。
3. 利用可能なBeatriceモデルを展開し、.tomlを選択します。マイクと出力先を選べば開始できます。

専用環境は `%USERPROFILE%\.YuiVoiceChanger\runtime` に保存します。既存のPythonやPATHは変更しません。失敗した場合は画面のエラーを確認して再試行できます。VSTとモデルは各配布元の条件に従って取得してください。

## 開発環境

Windows、Node.js 22以降、Python 3.11以降を使用します。
公式Beatrice 2.0.0-rc.3 VST3と、利用権のある2.0.0-rc.0形式のモデルが必要です。

```powershell
npm ci
python -m pip install -r requirements.txt
npm start
```

環境設定でPython、VST3、モデルの.tomlを指定してください。
モデルの隣には対応する.binファイル一式が必要です。
マイクと出力先を選ぶと変換を開始できます。Windows WASAPIの共有モードでサンプルレートを自動変換するため、通常はWindows側を48,000Hzに変更する必要はありません。[設定の詳細](docs/beatrice.md)。

## 設定

`%USERPROFILE%\.YuiVoiceChanger\desktop.json` に自動保存します。
新しい設定ファイルがない場合は旧AppData設定を読み込みます。
環境設定からJSONのインポート・エクスポートができます。
モデル本体は含まれません。別PCではパスと音声デバイスを確認してください。
Pythonやライブラリの場所を変更した場合は再起動してください。

## 検証とビルド

```powershell
python tests/run.py
npm run build
npm run test:ui
node tests/settings-transfer.cjs
node tests/onboarding.cjs
npm run dist
```

UIテスト前に通常のアプリを閉じてください。
実機テストは `node tests/desktop-audio.cjs <設定JSONのパス>` で実行できます。
テストとWindowsビルドはローカルで実行します。GitHub Actionsによる自動実行は行いません。
インストーラーは `release/` に生成します。
Python・依存ライブラリ・VST・モデルは同梱しません。

## 構成

- `src/`: 画面
- `electron/`: 起動、設定、Pythonとの通信
- `backend/`: Beatrice VSTホスト、音声入出力
- `tests/`: 音声バッファ、Beatrice、画面・設定のテスト
- `assets/`, `public/`: アイコン

独自コードはMITです。[第三者ライセンス表記](THIRD_PARTY_NOTICES.md)も参照してください。
モデル・録音・学習データはGitやインストーラーに含めません。
