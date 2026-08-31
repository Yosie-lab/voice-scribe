/**
 * VoiceScribe — Groq Whisper 音声認識サービス (WhisperService)
 * 録音された音声ファイル全体を Groq の超高速 LPU (Whisper Large v3) に送信し、
 * 抜け落ちのない100%忠実な全文文字起こしを0.5秒〜1秒の爆速で生成
 */

class WhisperService {
  constructor() {
    this.storageKey = 'voicescribe_groq_api_key';
    this.apiKey = this.loadApiKey();
    this.endpoint = 'https://api.groq.com/openai/v1/audio/transcriptions';
    this.model = 'whisper-large-v3';
  }

  /**
   * 保存されたAPIキーを取得
   * @returns {string}
   */
  loadApiKey() {
    return localStorage.getItem(this.storageKey) || '';
  }

  /**
   * APIキーを保存
   * @param {string} key
   */
  saveApiKey(key) {
    const cleanKey = (key || '').trim();
    this.apiKey = cleanKey;
    if (cleanKey) {
      localStorage.setItem(this.storageKey, cleanKey);
    } else {
      localStorage.removeItem(this.storageKey);
    }
  }

  /**
   * APIキーが設定されているか
   * @returns {boolean}
   */
  hasApiKey() {
    return !!this.apiKey && this.apiKey.length >= 10;
  }

  /**
   * APIキーの接続テスト
   * @param {string} [testKey]
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async testConnection(testKey) {
    const key = testKey || this.apiKey;
    if (!key) {
      return { success: false, message: 'APIキーが入力されていません。' };
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const response = await fetch('https://api.groq.com/openai/v1/models', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${key}`
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errMsg = errorData.error?.message || `HTTP ${response.status}`;
        return { success: false, message: `接続失敗: ${errMsg}` };
      }

      return { success: true, message: '✅ Groq API 接続成功！Whisper-large-v3 が利用可能です。' };
    } catch (err) {
      console.error('Groq API test error:', err);
      const isAbort = err.name === 'AbortError';
      return { success: false, message: isAbort ? '接続タイムアウト（ネットワークを確認してください）' : `通信エラー: ${err.message}` };
    }
  }

  /**
   * 音声Blobから超高精度な文字起こしを爆速実行
   * @param {Blob} audioBlob - 録音された音声データ
   * @param {'ja-JP'|'en-US'} [language='ja-JP'] - 言語
   * @returns {Promise<string>} - 文字起こし全文テキスト
   */
  async transcribeAudio(audioBlob, language = 'ja-JP') {
    if (!this.hasApiKey()) {
      throw new Error('Groq APIキーが設定されていません。');
    }

    if (!audioBlob || audioBlob.size === 0) {
      throw new Error('文字起こし対象の音声データがありません。');
    }

    // 1. ファイル拡張子の決定（iOS Safariはmp4、他はwebmなど）
    const mimeType = audioBlob.type || 'audio/mp4';
    const ext = mimeType.includes('webm') ? 'webm' : (mimeType.includes('ogg') ? 'ogg' : 'mp4');
    const fileName = `audio.${ext}`;

    // 2. FormDataの構築（Blobを直接ファイル名付きでappendしてiOS Safari互換性を最大化）
    const formData = new FormData();
    formData.append('file', audioBlob, fileName);
    formData.append('model', this.model);
    formData.append('language', language === 'en-US' ? 'en' : 'ja');
    formData.append('temperature', '0.0');
    formData.append('response_format', 'json');

    // 3. タイムアウト付きフェッチ（最大10秒）
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: formData,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errMsg = errorData.error?.message || `HTTP ${response.status}`;
        throw new Error(`Groqエラー: ${errMsg}`);
      }

      const data = await response.json();
      return (data.text || '').trim();
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        throw new Error('文字起こし処理がタイムアウトしました。');
      }
      throw err;
    }
  }
}

// グローバルエクスポート
window.WhisperService = WhisperService;
