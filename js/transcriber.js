/**
 * VoiceScribe — 音声認識（文字起こし）モジュール
 * Web Speech API (webkitSpeechRecognition) を利用したリアルタイム音声文字起こし
 */

class Transcriber {
  constructor() {
    this.recognition = null;
    this.isListening = false;
    this.shouldRestart = false;
    this.language = 'ja-JP';
    this.finalTranscript = '';
    this.interimTranscript = '';
    this.retryCount = 0;
    this.maxRetries = 10;
    this.retryDelay = 300;

    // コールバック
    this.onResult = null; // (finalText, interimText) => {}
    this.onError = null;  // (errorMessage) => {}
    this.onEnd = null;    // () => {}
  }

  /**
   * 音声認識の対応状況を確認
   * @returns {{available: boolean, reason: string}}
   */
  static checkAvailability() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      return {
        available: false,
        reason: 'お使いのブラウザは音声認識に対応していません。iOSの場合はSafariでご利用ください。'
      };
    }

    if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') {
      return {
        available: false,
        reason: '音声認識機能を利用するにはHTTPS接続が必要です。'
      };
    }

    return { available: true, reason: '' };
  }

  /**
   * 音声認識インスタンスを初期化（毎回フレッシュ生成）
   */
  init() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    // 既存インスタンスの破棄
    if (this.recognition) {
      try {
        this.recognition.abort();
      } catch {
        // 無視
      }
      this.recognition = null;
    }

    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = this.language;
    this.recognition.maxAlternatives = 1;

    // 結果受信ハンドラ
    this.recognition.onresult = (event) => {
      this.retryCount = 0;

      let currentInterim = '';
      let currentFinal = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          currentFinal += result[0].transcript;
        } else {
          currentInterim += result[0].transcript;
        }
      }

      if (currentFinal) {
        // 日本語環境の場合、句読点と音声コマンドを安全に適用
        const formattedFinal = this.language === 'ja-JP'
          ? this._formatJapanesePunctuation(currentFinal)
          : currentFinal;
        this.finalTranscript += formattedFinal;
      }
      this.interimTranscript = currentInterim;

      if (this.onResult) {
        this.onResult(this.finalTranscript, this.interimTranscript);
      }
    };

    // エラーハンドラ
    this.recognition.onerror = (event) => {
      console.warn('音声認識イベントエラー:', event.error);

      switch (event.error) {
        case 'no-speech':
          if (this.shouldRestart) this._retry();
          break;
        case 'audio-capture':
          if (this.onError) this.onError('マイクにアクセスできません。');
          this.stop();
          break;
        case 'not-allowed':
          if (this.onError) this.onError('マイクの使用が許可されていません。');
          this.stop();
          break;
        case 'network':
          if (this.shouldRestart) this._retry();
          break;
        default:
          if (this.shouldRestart) this._retry();
      }
    };

    // 終了ハンドラ
    this.recognition.onend = () => {
      if (this.shouldRestart && this.isListening) {
        this._retry();
      } else {
        this.isListening = false;
        if (this.onEnd) this.onEnd();
      }
    };
  }

  /**
   * 言語を設定
   * @param {'ja-JP'|'en-US'} lang
   */
  setLanguage(lang) {
    this.language = lang;
    if (this.recognition) {
      this.recognition.lang = lang;
    }
  }

  /**
   * 文字起こしを開始（タップ直後に即座に同期起動）
   * @returns {boolean}
   */
  start() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      if (this.onError) this.onError('このブラウザは音声認識に対応していません。Safariで開いてください。');
      return false;
    }

    // iOS Safari必須: 毎回新規インスタンスを生成
    this.init();

    this.finalTranscript = '';
    this.interimTranscript = '';
    this.retryCount = 0;
    this.shouldRestart = true;
    this.isListening = true;

    try {
      this.recognition.start();
      console.log(`音声文字起こし開始 (${this.language})`);
      return true;
    } catch (error) {
      console.warn('文字起こしstart警告:', error);
      if (error.name === 'InvalidStateError') {
        return true;
      }
      this.isListening = false;
      return false;
    }
  }

  /**
   * 文字起こしを停止
   */
  stop() {
    this.shouldRestart = false;
    this.isListening = false;

    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {
        // すでに停止している場合は無視
      }
    }
    console.log('音声文字起こし停止');
  }

  /**
   * 現在の文字起こしテキストを取得（確定テキスト＋暫定テキストを合成）
   * @returns {string}
   */
  getFullTranscript() {
    const final = (this.finalTranscript || '').trim();
    const interim = (this.interimTranscript || '').trim();
    if (final && interim) {
      return `${final} ${interim}`;
    }
    return final || interim || '';
  }

  /**
   * テキストをリセット
   */
  reset() {
    this.finalTranscript = '';
    this.interimTranscript = '';
  }

  /**
   * 認識停止時の自動再起動
   * @private
   */
  _retry() {
    if (!this.shouldRestart || !this.isListening) return;

    this.retryCount++;
    if (this.retryCount > this.maxRetries) {
      console.warn('最大リトライ回数に達しました');
      this.retryCount = 0;
    }

    setTimeout(() => {
      if (this.shouldRestart && this.isListening) {
        try {
          this.init();
          this.recognition.start();
        } catch (error) {
          console.warn('音声認識リトライ警告:', error);
        }
      }
    }, this.retryDelay);
  }

  /**
   * 日本語の確定テキストに安全・自然に句読点を付与
   * @param {string} text - 確定テキストチャンク
   * @returns {string} 整形後のテキスト
   * @private
   */
  _formatJapanesePunctuation(text) {
    if (!text) return '';
    let res = text;

    // 1. 音声句読点コマンド（「まる」「てん」「改行」）の置換
    res = res
      .replace(/(?:^|[\s\u3000])(?:まる|くてん|ピリオド)(?:[\s\u3000]|$)/g, '。')
      .replace(/(?:^|[\s\u3000])(?:てん|とうてん|コンマ)(?:[\s\u3000]|$)/g, '、')
      .replace(/(?:^|[\s\u3000])(?:かいぎょう|改行)(?:[\s\u3000]|$)/g, '\n');

    // 2. 文末パターン（〜です、〜ます、〜でした 等）の末尾に「。」を安全補完
    const endPatterns = /(?:です|ます|でした|ません|でしたら|ください|ですね|でしょうか|思います|あります|おります|いたします|となります|なりました|行います|始めます)$/;
    if (endPatterns.test(res) && !/[。、！？!?\n]$/.test(res)) {
      res += '。';
    }

    // 3. 接続・中継ぎパターン（〜ですが、〜ので、〜から、〜けど 等）の末尾に「、」を安全補完
    const commaPatterns = /(?:ですが|ので|から|けれど|けれども|そして|また|しかし|ただし|なお|ですが)$/;
    if (commaPatterns.test(res) && !/[。、！？!?\n]$/.test(res)) {
      res += '、';
    }

    // 4. 重複句読点のクリーンアップ
    res = res
      .replace(/。+/g, '。')
      .replace(/、+/g, '、')
      .replace(/、。/g, '。');

    return res;
  }
}

// グローバルエクスポート
window.Transcriber = Transcriber;
