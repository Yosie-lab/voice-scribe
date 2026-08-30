# VoiceScribe 🎙️

リアルタイム文字起こし機能付きボイスレコーダー（PWA対応）。
ブラウザやiPhone（Safari）で動作し、録音しながらリアルタイムに音声をテキスト化します。

## ✨ 特徴

- 🎙️ **高音質音声録音**: MediaRecorder API による音声キャプチャ（iOS Safari対応）
- 📝 **リアルタイム文字起こし**: Web Speech API (`webkitSpeechRecognition`) によるリアルタイムテキスト変換（日本語・英語対応）
- 📊 **リアルタイム波形ビジュアライザー**: Web Audio API による周波数解析とスムーズなアニメーション描画
- 💾 **オフラインローカル保存**: IndexedDB による音声データ（Blob）とテキストの永続化
- 🔍 **全文検索**: 過去の文字起こしテキストの検索機能
- 📤 **エクスポート**: 文字起こしテキスト（.txt）および音声ファイルのダウンロード
- 📱 **PWA対応**: Service Worker によるオフラインキャッシュとホーム画面インストール対応
- 💎 **洗練されたUI**: ダークモード、グラスモーフィズム、レスポンシブデザイン

## 🚀 使い方

### ローカルで起動

```bash
# 静的ファイルサーバーで起動
npx serve -l 3000 .
```

ブラウザで `http://localhost:3000` にアクセスしてください。

### iPhone (Safari) での利用

1. MacとiPhoneを同一Wi-Fiに接続します。
2. MacのIPアドレスを確認し、iPhoneのSafariで `http://<MacのIP>:3000` を開きます。
3. マイクの使用を許可して録音・リアルタイム文字起こしをご利用いただけます。

> [!NOTE]
> iOSの制限により、ホーム画面に追加したPWAモードではWeb Speech APIが動作しないため、文字起こし機能を利用する場合は **Safariブラウザのタブ内** でご利用ください。

## 🛠️ 技術スタック

- **フロントエンド**: HTML5, CSS3 (Vanilla CSS / Glassmorphism), Vanilla JavaScript (ES6+)
- **音声処理**: MediaRecorder API, Web Audio API, Web Speech API
- **ストレージ**: IndexedDB
- **PWA**: Service Worker, Web App Manifest
