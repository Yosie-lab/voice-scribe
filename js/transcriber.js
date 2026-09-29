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
    this.maxRetries = 8;
    this._contentionRestarts = 0;
    this._restartTimer = null;
    this._hold = false;
    this._engineRunning = false;
    this._resumeWhenVisible = false;
    this._engineWasStarted = false;
    this._captureErrorNotified = false;
    this._isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

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
        reason: 'お使いのブラウザは音声認識に対応していません。iPhoneではSafariからホーム画面に追加してください。'
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

    // 既存インスタンスはハンドラを外してから破棄する（abort の onend で再起動が二重にならない）
    if (this.recognition) {
      const old = this.recognition;
      old.onresult = null;
      old.onerror = null;
      old.onend = null;
      this.recognition = null;
      try {
        old.abort();
      } catch {
        // 無視
      }
    }

    this.recognition = new SpeechRecognition();
    // iOS は continuous:true だと確定せずすぐ終わる。false にして onend で作り直す。
    this.recognition.continuous = !this._isIOS;
    this.recognition.interimResults = true;
    this.recognition.lang = this.language;
    this.recognition.maxAlternatives = 1;

    // 結果受信ハンドラ
    this.recognition.onresult = (event) => {
      this.retryCount = 0;
      this._contentionRestarts = 0;
      this._captureErrorNotified = false;

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
      const err = event.error || 'error';
      console.warn('音声認識イベントエラー:', err);

      if (err === 'no-speech') return;

      // desktop Chromium は MediaRecorder の getUserMedia にマイクを取られると
      // aborted だけで黙って死ぬ（onend が来ないことがある）。録音中なら作り直す。
      // iOS は onend の再生成に任せ、ここは触らない。
      if (err === 'aborted') {
        this._engineRunning = false;
        if (this._deferWhileHidden()) return;
        if (!this._isIOS && this.shouldRestart && this.isListening) {
          this._contentionRestarts++;
          if (this._contentionRestarts > this.maxRetries) {
            this.stop();
            if (this.onError) {
              this.onError('音声認識を継続できません。もう一度録音を開始してください。');
            }
            return;
          }
          this._scheduleRestart(300);
        }
        return;
      }

      if (err === 'audio-capture') {
        this._engineRunning = false;
        // 画面ロックはマイクを奪う。stop() すると復帰できなくなるので、録音セッション中は殺さない。
        if (this._deferWhileHidden()) return;
        if (this.shouldRestart && this.isListening) {
          this.retryCount++;
          if (this.retryCount <= this.maxRetries) {
            this._scheduleRestart(300);
            return;
          }
          this._resumeWhenVisible = true;
          if (!this._captureErrorNotified) {
            this._captureErrorNotified = true;
            if (this.onError) this.onError('音声認識が中断されました。録音は継続しています。');
          }
          return;
        }
        if (this.onError) this.onError('マイクにアクセスできません。');
        this.stop();
        return;
      }
      if (err === 'not-allowed') {
        this._engineRunning = false;
        if (this._deferWhileHidden()) return;
        if (this.shouldRestart && this.isListening && this._engineWasStarted) {
          this._resumeWhenVisible = true;
          return;
        }
        if (this.onError) this.onError('マイクの使用が許可されていません。');
        this.stop();
        return;
      }
      if (this.shouldRestart) this._scheduleRestart();
    };

    // 終了ハンドラ。iOS スタンドアロンでは発話ごとに終わるので、ここで認識を作り直す。
    this.recognition.onend = () => {
      this._engineRunning = false;
      if (this._hold || document.visibilityState === 'hidden') {
        if (this.shouldRestart && this.isListening) this._resumeWhenVisible = true;
        return;
      }
      if (this.shouldRestart && this.isListening) {
        this._scheduleRestart();
      } else {
        this.isListening = false;
        if (this.onEnd) this.onEnd();
      }
    };
  }

  /**
   * iPhone Safari はユーザージェスチャ内で認識を先に start する。
   * desktop Chromium は getUserMedia より前に start すると認識が abort される。
   * @returns {boolean}
   */
  get startBeforeRecorder() {
    return this._isIOS;
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
      if (this.onError) this.onError('このブラウザは音声認識に対応していません。');
      return false;
    }

    // iOS Safari必須: 毎回新規インスタンスを生成
    this.init();

    this.finalTranscript = '';
    this.interimTranscript = '';
    this.retryCount = 0;
    this._contentionRestarts = 0;
    this._clearRestartTimer();
    this._hold = false;
    this._resumeWhenVisible = false;
    this.shouldRestart = true;
    this.isListening = true;

    try {
      this.recognition.start();
      this._engineRunning = true;
      this._engineWasStarted = true;
      console.log(`音声文字起こし開始 (${this.language})`);
      return true;
    } catch (error) {
      console.warn('文字起こしstart警告:', error);
      if (error.name === 'InvalidStateError') {
        this._engineRunning = true;
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
    this._engineRunning = false;
    this._hold = false;
    this._resumeWhenVisible = false;
    this._clearRestartTimer();

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
   * 画面が隠れたあいだ、確定テキストを消さずに再起動ループを止める。
   */
  holdForBackground() {
    if (!this.isListening && !this.shouldRestart) return;
    this._hold = true;
    this._clearRestartTimer();
  }

  /**
   * ロック解除後に、同じ確定テキストのまま認識だけ付け直す。
   */
  resumeAfterBackground() {
    const held = this._hold || this._resumeWhenVisible;
    this._hold = false;
    if (document.visibilityState === 'hidden') return;
    if (!this.shouldRestart || !this.isListening) {
      if (!held) return;
      this.shouldRestart = true;
      this.isListening = true;
    }
    this.retryCount = 0;
    this._contentionRestarts = 0;
    if (this._engineRunning) {
      this._resumeWhenVisible = false;
      return;
    }
    this.continueListening();
  }

  /**
   * 一時停止からの再開。start() と違い、確定テキストは消さない。
   * @returns {boolean}
   */
  continueListening() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return false;
    this.shouldRestart = true;
    this.isListening = true;
    this._hold = false;
    this._resumeWhenVisible = false;
    this.retryCount = 0;
    this._contentionRestarts = 0;
    this._clearRestartTimer();
    this._restartNow();
    return true;
  }

  /**
   * @returns {boolean}
   */
  isEngineRunning() {
    return this._engineRunning;
  }

  /**
   * テキストをリセット
   */
  reset() {
    this.finalTranscript = '';
    this.interimTranscript = '';
  }

  /**
   * onend 後に認識インスタンスを作り直して再開する。連続呼び出しは1本にまとめる。
   * @param {number} [delayMs]
   * @private
   */
  _scheduleRestart(delayMs) {
    if (!this.shouldRestart || !this.isListening || this._restartTimer) return;

    const delay = typeof delayMs === 'number' ? delayMs : (this._isIOS ? 220 : 80);
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      this._restartNow();
    }, delay);
  }

  /**
   * @private
   */
  _deferWhileHidden() {
    if (this._hold || document.visibilityState === 'hidden') {
      if (this.shouldRestart && this.isListening) this._resumeWhenVisible = true;
      return true;
    }
    return false;
  }

  /**
   * @private
   */
  _restartNow() {
    if (!this.shouldRestart || !this.isListening) return;
    if (this._hold || document.visibilityState === 'hidden') {
      this._resumeWhenVisible = true;
      return;
    }

    try {
      this.init();
      this.recognition.start();
      this._engineRunning = true;
      this._resumeWhenVisible = false;
      this.retryCount = 0;
    } catch (error) {
      if (error && error.name === 'InvalidStateError') return;
      console.warn('音声認識リトライ警告:', error);
      this.retryCount++;
      if (this.retryCount > this.maxRetries) {
        this.stop();
        if (this.onError) this.onError('音声認識を継続できません。もう一度録音を開始してください。');
        return;
      }
      this._restartTimer = setTimeout(() => {
        this._restartTimer = null;
        this._restartNow();
      }, 250);
    }
  }

  /**
   * @private
   */
  _clearRestartTimer() {
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
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
