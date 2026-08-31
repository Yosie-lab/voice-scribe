/**
 * VoiceScribe — 音声認識モジュール (Transcriber)
 * iOS Safari 標準の Web Speech API を極限までシンプルに、素直に動作させる高精度設計
 */

class Transcriber {
  constructor() {
    this.recognition = null;
    this.isListening = false;
    this.shouldRestart = false;
    this.language = 'ja-JP';
    this.finalTranscript = '';
    this.interimTranscript = '';

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
        reason: 'お使いのブラウザは音声認識に対応していません。Safariでご利用ください。'
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
   * 音声認識インスタンスを初期化（Safari最適化のシンプル構造）
   */
  init() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    if (this.recognition) {
      try {
        this.recognition.onresult = null;
        this.recognition.onerror = null;
        this.recognition.onend = null;
        this.recognition.abort();
      } catch {}
      this.recognition = null;
    }

    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = this.language;
    this.recognition.maxAlternatives = 1;

    // 結果受信ハンドラ
    this.recognition.onresult = (event) => {
      let interim = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript;

        if (result.isFinal) {
          // 確定テキストに自然な句読点を補正して追加
          const formatted = this._formatFinalText(text);
          if (this.finalTranscript) {
            const sep = this.language === 'en-US' ? ' ' : '';
            this.finalTranscript += sep + formatted;
          } else {
            this.finalTranscript = formatted;
          }
        } else {
          interim += text;
        }
      }

      this.interimTranscript = interim;

      if (this.onResult) {
        this.onResult(this.finalTranscript, this.interimTranscript);
      }
    };

    // エラーハンドラ
    this.recognition.onerror = (event) => {
      console.warn('音声認識イベント:', event.error);
      if (event.error === 'not-allowed') {
        if (this.onError) this.onError('マイクの使用が許可されていません。');
        this.stop();
      } else if (event.error === 'audio-capture') {
        if (this.onError) this.onError('マイクにアクセスできませんでした。');
        this.stop();
      }
      // 通常の無音(no-speech)などは再起動
    };

    // 終了ハンドラ（無音自動停止時にシームレス再開）
    this.recognition.onend = () => {
      // 終了時に未確定テキストがあれば救出
      if (this.interimTranscript && this.interimTranscript.trim()) {
        const saved = this._formatFinalText(this.interimTranscript);
        if (this.finalTranscript) {
          const sep = this.language === 'en-US' ? ' ' : '';
          this.finalTranscript += sep + saved;
        } else {
          this.finalTranscript = saved;
        }
        this.interimTranscript = '';
        if (this.onResult) {
          this.onResult(this.finalTranscript, '');
        }
      }

      if (this.shouldRestart && this.isListening) {
        setTimeout(() => {
          if (this.shouldRestart && this.isListening) {
            try {
              this.init();
              this.recognition.start();
            } catch (e) {
              console.warn('再接続警告:', e);
            }
          }
        }, 50);
      } else {
        this.isListening = false;
        if (this.onEnd) this.onEnd();
      }
    };
  }

  /**
   * 確定した文にシンプルな句読点を付与
   * @param {string} raw
   * @returns {string}
   * @private
   */
  _formatFinalText(raw) {
    let text = (raw || '').trim();
    if (!text) return '';

    if (this.language === 'ja-JP') {
      // 接続詞の後ろに「、」
      text = text.replace(/(^|[。\s])(しかし|また|例えば|そして|ところで|なお|つまり|要するに|まず|次に|最後に|実は)(?![、\s])/g, '$1$2、');

      // 文末に「。」または「？」
      if (!/[。！？!\?」』）\)]$/.test(text)) {
        if (/(ですか|ますか|でしょうか|なの|なのか|ですかね|かな|かい|誰|何|いつ|どこ|なぜ|どう)$/.test(text)) {
          text += '？';
        } else {
          text += '。';
        }
      }
    } else {
      text = text.charAt(0).toUpperCase() + text.slice(1);
      if (!/[.!?]$/.test(text)) {
        text += '.';
      }
    }

    return text;
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
   * 文字起こしを開始
   * @returns {boolean}
   */
  start() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      if (this.onError) this.onError('このブラウザは音声認識に対応していません。Safariで開いてください。');
      return false;
    }

    this.init();
    this.finalTranscript = '';
    this.interimTranscript = '';
    this.shouldRestart = true;
    this.isListening = true;

    try {
      this.recognition.start();
      console.log(`音声文字起こし開始 (${this.language})`);
      return true;
    } catch (error) {
      console.warn('文字起こしstart警告:', error);
      if (error.name === 'InvalidStateError') return true;
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
      } catch {}
    }
    console.log('音声文字起こし停止');
  }

  /**
   * 現在の文字起こしテキストを取得
   * @returns {string}
   */
  getFullTranscript() {
    const final = (this.finalTranscript || '').trim();
    const interim = (this.interimTranscript || '').trim();

    if (final && interim) {
      const sep = this.language === 'en-US' ? ' ' : '';
      return `${final}${sep}${interim}`;
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
}

// グローバルエクスポート
window.Transcriber = Transcriber;
