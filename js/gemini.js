/**
 * VoiceScribe — Google Gemini API 連携サービス (GeminiService)
 * 録音されたクリアな音声データ（Blob）を Gemini 1.5 Flash に直接送信し、
 * 抜け落ちのない100%完璧な全文文字起こしと構造化要約を完全無料で生成
 */

class GeminiService {
  constructor() {
    this.storageKey = 'voicescribe_gemini_api_key';
    this.autoTranscribeKey = 'voicescribe_auto_gemini_enabled';
    this.apiKey = this.loadApiKey();
    this.isAutoEnabled = this.loadAutoEnabled();
    this.model = 'gemini-1.5-flash';
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
   * 自動AI処理が有効か
   * @returns {boolean}
   */
  loadAutoEnabled() {
    const val = localStorage.getItem(this.autoTranscribeKey);
    return val === null ? true : val === 'true';
  }

  /**
   * 自動AI処理の設定を保存
   * @param {boolean} enabled
   */
  saveAutoEnabled(enabled) {
    this.isAutoEnabled = !!enabled;
    localStorage.setItem(this.autoTranscribeKey, enabled ? 'true' : 'false');
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
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${encodeURIComponent(key)}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: 'Hello, reply with "OK".' }]
          }]
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errMsg = errorData.error?.message || `HTTP ${response.status}`;
        return { success: false, message: `接続失敗: ${errMsg}` };
      }

      return { success: true, message: '✅ Gemini API接続成功！正常に利用できます。' };
    } catch (err) {
      console.error('Gemini API test error:', err);
      return { success: false, message: `通信エラー: ${err.message}` };
    }
  }

  /**
   * 音声Blobから超高精度な文字起こしと要約を一度に生成
   * @param {Blob} audioBlob - 録音された音声データ
   * @param {'ja-JP'|'en-US'} [language='ja-JP'] - 言語
   * @returns {Promise<{transcript: string, headline: string, summaryBullets: Array<string>, keywords: Array<string>, actionItems: Array<string>, formattedText: string}>}
   */
  async transcribeAndSummarize(audioBlob, language = 'ja-JP') {
    if (!this.hasApiKey()) {
      throw new Error('Gemini APIキーが設定されていません。設定画面でキーを登録してください。');
    }

    if (!audioBlob || audioBlob.size === 0) {
      throw new Error('音声データがありません。');
    }

    // 1. Blobをbase64に変換
    const base64Audio = await this._blobToBase64(audioBlob);
    const mimeType = audioBlob.type || 'audio/mp4';

    // 2. プロンプトの構築
    const langPrompt = language === 'ja-JP' ? '日本語' : '英語';
    const promptText = `
あなたは世界最高峰のプロフェッショナル文字起こし・要約AIです。
提供された音声ファイルを高精度に解析し、以下の指示に厳密に従ってJSON形式で出力してください。

【文字起こしの指示】
1. 音声で話されている内容を一言一句漏らさず、100%完璧に文字起こししてください（transcript）。
2. 早口、小声、長文、言い淀みも前後の文脈から正確に補完してください。
3. 自然で読みやすい句読点（「、」「。」）および適切な段落改行（1段落あたり2〜4文）を入れて整形してください。

【要約・整理の指示】
1. headline: 話題・トピックがひと目でわかる簡潔な見出し（20文字以内、例: 📌 〇〇についての打合せ）。
2. summaryBullets: 話の重要ポイントを箇条書きで3〜5項目。
3. keywords: 重要キーワードを3〜5個（例: ["打ち合わせ", "スケジュール"]）。
4. actionItems: 決定事項ややるべきアクション（あれば配列、なければ空配列）。

必ず以下の形式の純粋なJSONのみを出力してください（Markdownコードブロックは含めても構いません）：
{
  "transcript": "完璧な文字起こし全文...",
  "headline": "📌 見出し",
  "summaryBullets": ["要点1", "要点2", "要点3"],
  "keywords": ["キーワード1", "キーワード2"],
  "actionItems": ["アクション1"]
}
`;

    // 3. APIリクエスト送信
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

    const requestBody = {
      contents: [{
        parts: [
          { text: promptText },
          {
            inline_data: {
              mime_type: mimeType,
              data: base64Audio
            }
          }
        ]
      }],
      generationConfig: {
        temperature: 0.2,
        response_mime_type: 'application/json'
      }
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errMsg = errorData.error?.message || `HTTP ${response.status}`;
      throw new Error(`Gemini APIエラー: ${errMsg}`);
    }

    const responseData = await response.json();
    const textOutput = responseData.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!textOutput) {
      throw new Error('Gemini APIから応答が得られませんでした。');
    }

    // 4. JSONのパース
    let parsedResult;
    try {
      // コードブロック記法（```json ... ```）の除去
      const cleanJson = textOutput.replace(/```json\s*|\s*```/g, '').trim();
      parsedResult = JSON.parse(cleanJson);
    } catch (e) {
      console.warn('JSONパース失敗、生テキストを使用:', textOutput);
      parsedResult = {
        transcript: textOutput,
        headline: '📌 録音メモ',
        summaryBullets: [textOutput.substring(0, 100)],
        keywords: [],
        actionItems: []
      };
    }

    // 5. 構造化テキストの生成
    const bullets = Array.isArray(parsedResult.summaryBullets) ? parsedResult.summaryBullets : [];
    const keywords = Array.isArray(parsedResult.keywords) ? parsedResult.keywords : [];
    const actions = Array.isArray(parsedResult.actionItems) ? parsedResult.actionItems : [];

    let formattedText = `【要点まとめ】\n${bullets.map(b => `・${b}`).join('\n')}`;
    if (keywords.length > 0) {
      formattedText += `\n\n【キーワード】\n${keywords.map(k => `#${k}`).join(' ')}`;
    }
    if (actions.length > 0) {
      formattedText += `\n\n【決定・アクション】\n${actions.map((a, i) => `${i + 1}. ${a}`).join('\n')}`;
    }

    return {
      transcript: parsedResult.transcript || '',
      headline: parsedResult.headline || '📌 録音メモ',
      summaryBullets: bullets,
      keywords: keywords,
      actionItems: actions,
      formattedText: formattedText
    };
  }

  /**
   * BlobをBase64文字列に変換
   * @param {Blob} blob
   * @returns {Promise<string>}
   * @private
   */
  _blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64String = reader.result.split(',')[1];
        resolve(base64String);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
}

// グローバルエクスポート
window.GeminiService = GeminiService;
