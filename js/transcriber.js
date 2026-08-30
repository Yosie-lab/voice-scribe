/**
 * VoiceScribe — 文字起こし（Web Speech API）
 * リアルタイム音声認識を担当
 * 日本語・英語対応、iOS向け安定性対策を含む
 */

class Transcriber {
  constructor() {
    this.recognition = null;
    this.isListening = false;
    this.language = 'ja-JP'; // デフォルト：日本語
    this.finalTranscript = '';
    this.interimTranscript = '';
    this.retryCount = 0;
    this.maxRetries = 5;
    this.retryDelay = 300;
    this.shouldRestart = false;

    // コールバック
    this.onResult = null; // (finalText, interimText) => {}
    this.onError = null;  // (errorMessage) => {}
    this.onEnd = null;    // () => {}
  }

  /**
   * Web Speech APIの対応確認
   * @returns {boolean}
   */
  static isSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  /**
   * PWA（standalone）モードかどうかを検出
   * @returns {boolean}
   */
  static isStandaloneMode() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true
    );
  }

  /**
   * 文字起こしが利用可能かどうかを総合判定
   * @returns {{available: boolean, reason: string}}
   */
  static checkAvailability() {
    if (!Transcriber.isSupported()) {
      return {
        available: false,
        reason: 'このブラウザは音声認識に対応していません。'
      };
    }

    if (Transcriber.isStandaloneMode()) {
      return {
        available: false,
        reason: 'ホーム画面から開いたPWAでは音声認識が利用できません。Safariのタブ内でご利用ください。'
      };
    }

    return { available: true, reason: '' };
  }

  /**
   * 音声認識を初期化
   */
  init() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = this.language;
    this.recognition.maxAlternatives = 1;

    // 結果を受信したとき
    this.recognition.onresult = (event) => {
      this.retryCount = 0; // 成功時にリトライカウントをリセット

      let interimText = '';
      let finalText = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalText += result[0].transcript;
        } else {
          interimText += result[0].transcript;
        }
      }

      if (finalText) {
        this.finalTranscript += finalText;
      }
      this.interimTranscript = interimText;

      if (this.onResult) {
        this.onResult(this.finalTranscript, this.interimTranscript);
      }
    };

    // エラーハンドリング
    this.recognition.onerror = (event) => {
      console.warn('音声認識エラー:', event.error);

      switch (event.error) {
        case 'no-speech':
          // 無音時は自動リトライ
          if (this.shouldRestart) {
            this._retry();
          }
          break;
        case 'audio-capture':
          if (this.onError) this.onError('マイクにアクセスできません。');
          this.stop();
          break;
        case 'not-allowed':
          if (this.onError) this.onError('マイクの使用が許可されていません。');
          this.stop();
          break;
        case 'aborted':
          // ユーザーによる中断 — リトライしない
          break;
        case 'network':
          if (this.onError) this.onError('ネットワークエラーが発生しました。');
          if (this.shouldRestart) {
            this._retry();
          }
          break;
        default:
          if (this.shouldRestart) {
            this._retry();
          }
      }
    };

    // 認識が終了したとき（自動リスタート）
    this.recognition.onend = () => {
      if (this.shouldRestart && this.isListening) {
        // iOS Safari対策: 少し遅延を入れてリスタート
        this._retry();
      } else {
        this.isListening = false;
        if (this.onEnd) this.onEnd();
      }
    };
  }

  /**
   * 言語を設定
   * @param {string} lang - 言語コード ('ja-JP' または 'en-US')
   */
  setLanguage(lang) {
    this.language = lang;
    if (this.recognition) {
      this.recognition.lang = lang;
    }
  }

  /**
   * 文字起こしを開始
   */
  async start() {
    const { available, reason } = Transcriber.checkAvailability();
    if (!available) {
      if (this.onError) this.onError(reason);
      return false;
    }

    if (!this.recognition) {
      this.init();
    }

    // iOS Safari対策: マイクをプライミング
    try {
      const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      tempStream.getTracks().forEach((track) => track.stop());
    } catch {
      // プライミング失敗時は無視して続行
    }

    this.finalTranscript = '';
    this.interimTranscript = '';
    this.retryCount = 0;
    this.shouldRestart = true;
    this.isListening = true;

    try {
      this.recognition.lang = this.language;
      this.recognition.start();
      console.log(`文字起こし開始 (${this.language})`);
      return true;
    } catch (error) {
      console.error('文字起こし開始エラー:', error);
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
    console.log('文字起こし停止');
  }

  /**
   * 現在の文字起こしテキストを取得
   * @returns {string}
   */
  getFullTranscript() {
    return this.finalTranscript;
  }

  /**
   * テキストをリセット
   */
  reset() {
    this.finalTranscript = '';
    this.interimTranscript = '';
  }

  /**
   * リトライ処理（iOS Safari安定性対策）
   * @private
   */
  _retry() {
    if (this.retryCount >= this.maxRetries) {
      console.warn('最大リトライ回数に達しました');
      this.retryCount = 0;
      // 少し長めに待ってからリトライ
      setTimeout(() => {
        if (this.shouldRestart && this.isListening) {
          this._doRestart();
        }
      }, 2000);
      return;
    }

    this.retryCount++;
    const delay = this.retryDelay * Math.pow(1.5, this.retryCount - 1);
    console.log(`文字起こしリトライ (${this.retryCount}/${this.maxRetries}) — ${Math.round(delay)}ms後`);

    setTimeout(() => {
      if (this.shouldRestart && this.isListening) {
        this._doRestart();
      }
    }, delay);
  }

  /**
   * 認識を再開始
   * @private
   */
  _doRestart() {
    try {
      this.recognition.start();
    } catch (error) {
      console.warn('リスタート失敗:', error);
      // すでに開始している場合は一度停止してから再開
      try {
        this.recognition.stop();
      } catch {
        // 無視
      }
      setTimeout(() => {
        if (this.shouldRestart) {
          try {
            this.recognition.start();
          } catch {
            // 最終的に失敗した場合
          }
        }
      }, 500);
    }
  }
}

// グローバルエクスポート
window.Transcriber = Transcriber;
