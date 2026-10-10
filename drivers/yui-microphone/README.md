# Yui Microphone — Windows 試作

状態: **ソース試作。SYSドライバーは未ビルド・未署名・未インストール。Windowsのマイクとしてはまだ使えません。** アプリの既存のVB-Cable経路は変更していません。

目標の経路:

`物理マイク → YuiVoiceChanger（Beatrice）→ Yui Voice Input（再生デバイス）→ Yui Microphone（録音デバイス）→ Discord等`

再生デバイスは48kHz/PCM16/ステレオ、録音デバイスは48kHz/PCM16/モノラル。Windows共有モードの変換を使います。完成後はYuiVoiceChangerの出力先でYui Voice Inputを選択する構成です。現在のアプリはWASAPI共有出力に対応しており、架空のデバイスをUIに表示しません。

## 実装

Microsoft SysVADを固定コミット `2dc3fd3a0cc84a2933f2194e7ec0871584979071` から再構成します。サンプルの複数端点をSPDIF再生/MicIn録音の1組へ絞り、テスト用正弦波の代わりにPCM転送を接続。サンプルの音声ファイル保存とBluetooth/USBサイドバンドを無効化。名称・ハードウェアID・サービスをYui専用に変更します。Microsoft由来部分のMITライセンスは生成先へコピーします。

転送処理は非ページメモリの最大40msリング。ステレオをモノラルへ平均化し、あふれたら古い音を破棄、不足時は無音、100ms以上止まった送信の残音は破棄します。レンダーストリーム停止時はクリアします。コールバック中のメモリ確保・ディスク書き込みは行いません。

**40msは追加遅延の実測値ではなくキューの上限です。** 単一アダプター・単一KSホストストリームの試作であり、複数の独立KSキャプチャ、長時間のクロックずれ、電源復帰、同時起動、再接続、ドライバーVerifier/HLK、実機の音声品質・遅延は未検証です。Windows共有エンジン経由の複数通話クライアントも実機確認が必要です。

## ローカル確認

MSVC C++とWindows SDKが必要です。管理者権限は不要。

```powershell
powershell -NoProfile -File drivers/yui-microphone/test.ps1
```

転送コアの実際のC++コードをコンパイルし、無音、平均化、最大振幅、周回、オーバーフロー、残音の期限、停止リセットを検査します。これはドライバー実機検証の代わりにはなりません。

## ドライバービルド

MicrosoftのWindows SDK/WDKおよび対応するVisual Studio C++ツールセットを用意します。現在のPCはSDK/MSVCのみで、WDKツールセットがありません。

[WDK導入資料](https://learn.microsoft.com/en-us/windows-hardware/drivers/download-the-wdk)

固定版の取得例（既存フォルダへの上書きは禁止）:

```powershell
git clone --filter=blob:none --no-checkout https://github.com/microsoft/Windows-driver-samples.git .local/sysvad-source
git -C .local/sysvad-source sparse-checkout set audio/sysvad
git -C .local/sysvad-source checkout 2dc3fd3a0cc84a2933f2194e7ec0871584979071
powershell -NoProfile -File drivers/yui-microphone/build.ps1 -SourceRoot .local/sysvad-source -Python python
```

準備スクリプトは固定版を確認し、新規出力ディレクトリだけへコピー・パッチします。生成した `.inx` はWDKでINFへ変換し、InfVerif、Inf2Cat、署名とテスト環境での検証が必要です。ビルドスクリプトは自動インストールしません。

## インストールと配布の未完了部分

現時点でインストーラーやGitHub Releaseへ組み込んではいけません。root-enumeratedデバイスの登録、署名済みパッケージの導入、正確なデバイス/サービスに限定したアンインストール、再起動の扱いは未実装です。一般利用PCへの導入にはWindowsが信頼するドライバー署名が必要です。

[Microsoftの署名資料](https://learn.microsoft.com/en-us/windows-hardware/drivers/dashboard/driver-signing-offerings)

試作のために利用中PCのSecure Boot・メモリ整合性・署名強制を変更するスクリプトは提供しません。まず専用の検証環境でドライバーを検証し、配布署名を整えます。
