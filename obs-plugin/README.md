# YuiVoiceChanger

Windows x64 の OBS Studio 33.0.1 用プラグインです。操作用のプレビューには最新の映像を表示し、配信・録画には遅延させた映像を送ります。

## 導入

YuiVoiceChanger 2026.1104.31以降では、環境設定の「OBSプラグインを導入する」から通常版OBSに導入できます。OBSを再起動し、「ツール」から「YuiVoiceChanger」を選びます。

ZIPから手動で導入する場合は以下の手順です。

1. OBSを終了します。
2. ZIPの `yui-live-preview` フォルダーを `%ProgramData%\obs-studio\plugins` にコピーします。ポータブル版の場合はOBSフォルダーの `plugins` にコピーします。
3. OBSを起動し、「ツール」から「YuiVoiceChanger」を選びます。もう一度選ぶと通常のプレビューに戻ります。
4. YuiVoiceChangerに自動で接続します。「歌枠用設定 → OBSプラグイン」で3Dモデルのソースを選びます。変換を開始すると、Yuiがプラグイン用の遅延フィルターを設定します。

OBS単体で試すときは、ソースのエフェクトフィルターに「YuiVoiceChanger 映像遅延」を追加して遅延を設定できます。1フィルターの上限は500msで、Yui連携時は必要に応じて分割します。同じソースに通常のレンダリング遅延を追加すると、その遅延は操作画面にも反映されます。

操作用プレビューは通常モードで使えます。ソースをドラッグして位置や大きさを変えるときは、通常のプレビューに戻します。操作用プレビューではシーン切り替えを即時表示し、配信と録画はOBSのトランジションを使います。

## ビルド

OBS Studio 33.0.1のソース、同リリースのQt SDK、Windows版OBSのDLL、Visual StudioのC++ツールが必要です。x64 Developer PowerShellで実行します。

```powershell
./build-windows.ps1 -ObsSource <OBSソース> -QtSdk <Qt SDK> -ObsBin <OBSのbin/64bit> -Output <ビルド出力先>
```

プラグインのソースはGPL-2.0-or-laterです。遅延フィルターはOBS Studioのgpu-delay.cを元にしています。
