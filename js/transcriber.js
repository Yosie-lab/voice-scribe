/**
 * VoiceScribe — 音声認識（文字起こし）モジュール
 * Web Speech API (webkitSpeechRecognition) を利用したリアルタイム音声文字起こし。
 * 認識品質の上限は OS / ブラウザ側。認識器自身のマイクは増幅できない。
 * ここでは取りこぼし（無音扱い、再起動の隙間、尻切れ）を減らす。
 * desktop の ja-JP は、モーラの尻・小声のレベル・再起動だけを英語より敏感にする。
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
    this._lastChunk = '';
    this._lastChunkAt = 0;
    this._lastFromInterim = false;
    this._lastResultAt = 0;
    this._heardSpeechAt = 0;
    this._lastNudgeAt = 0;
    this._intentionalAbort = false;
    this._restartNotBefore = 0;
    this._isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    this._jaHungTimer = null;

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
    this._clearJaHungWatch();

    // 既存インスタンスはハンドラを外してから破棄する（abort の onend で再起動が二重にならない）
    if (this.recognition) {
      const old = this.recognition;
      old.onresult = null;
      old.onerror = null;
      old.onend = null;
      old.onspeechstart = null;
      old.onspeechend = null;
      old.onstart = null;
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
    // 日本語は上位が尻切れでも、うしろの候補にモーラが残ることがある。
    this.recognition.maxAlternatives = this.language === 'ja-JP' ? 5 : 3;

    this.recognition.onstart = () => {
      this._engineRunning = true;
      this._heardSpeechAt = 0;
      this._resumeWhenVisible = false;
    };

    // クラウド結果より先に「音は拾った」が来る。この直後に暫定が無いなら、無視されていないか見る。
    this.recognition.onspeechstart = () => {
      this._heardSpeechAt = Date.now();
    };

    // 日本語の continuous は speechend のあと暫定のまま固まることがある。確定を待ってから付け直す。
    this.recognition.onspeechend = () => {
      this._armJaHungWatch();
    };

    // 結果受信ハンドラ
    this.recognition.onresult = (event) => {
      this._clearJaHungWatch();
      this.retryCount = 0;
      this._contentionRestarts = 0;
      this._captureErrorNotified = false;
      this._lastResultAt = Date.now();

      let currentInterim = '';
      let currentFinal = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = Transcriber.pickTranscript(result, this.language);
        if (result.isFinal) {
          currentFinal += text;
        } else {
          currentInterim += text;
        }
      }

      if (currentFinal) this._appendFinal(currentFinal);
      this.interimTranscript = currentInterim;

      if (this.onResult) {
        this.onResult(this.finalTranscript, this.interimTranscript);
      }
    };

    // エラーハンドラ
    this.recognition.onerror = (event) => {
      const err = event.error || 'error';
      console.warn('音声認識イベントエラー:', err);
      this._commitPendingInterim();

      // 小さい声は no-speech でセッションが切れる。暫定を残してすぐ付け直す。
      if (err === 'no-speech') {
        this._engineRunning = false;
        if (this._deferWhileHidden()) return;
        if (this.shouldRestart && this.isListening) {
          this._scheduleRestart(Transcriber.restartDelay('no-speech', this._isIOS, this.language));
        }
        return;
      }

      // desktop Chromium は MediaRecorder の getUserMedia にマイクを取られると
      // aborted だけで黙って死ぬ（onend が来ないことがある）。録音中なら作り直す。
      // iOS は onend の再生成に任せ、ここは触らない。
      if (err === 'aborted') {
        this._engineRunning = false;
        const intentional = this._intentionalAbort;
        this._intentionalAbort = false;
        if (this._deferWhileHidden()) return;
        if (!this._isIOS && this.shouldRestart && this.isListening) {
          if (!intentional) {
            this._contentionRestarts++;
            this._restartNotBefore = Date.now() + 280;
            if (this._contentionRestarts > this.maxRetries) {
              this.stop();
              if (this.onError) {
                this.onError('音声認識を継続できません。もう一度録音を開始してください。');
              }
              return;
            }
          }
          this._scheduleRestart(intentional ? 40 : 300);
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
    // 確定前の暫定はここで残す。再起動の隙間で早口の続きが消えるのを防ぐ。
    this.recognition.onend = () => {
      this._engineRunning = false;
      this._commitPendingInterim();
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
    this._lastChunk = '';
    this._lastChunkAt = 0;
    this._lastFromInterim = false;
    this._lastResultAt = Date.now();
    this._heardSpeechAt = 0;
    this._lastNudgeAt = 0;
    this._intentionalAbort = false;
    this._restartNotBefore = 0;
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
    this._intentionalAbort = false;
    this._clearRestartTimer();
    this._clearJaHungWatch();
    this._commitPendingInterim();

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
    let interim = (this.interimTranscript || '').trim();
    if (interim) {
      interim = Transcriber.stripFillers(interim, this.language).trim();
      if (this.language === 'ja-JP' && interim) interim = this._formatJapanesePunctuation(interim);
    }
    if (final && interim) return this._joinTranscript(final, interim).trim();
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
    this._lastChunk = '';
    this._lastChunkAt = 0;
    this._lastFromInterim = false;
  }

  /**
   * 最後に文字が来てからのミリ秒。まだ一度もないときは Infinity。
   * @returns {number}
   */
  msSinceResult() {
    if (!this._lastResultAt) return Infinity;
    return Date.now() - this._lastResultAt;
  }

  /**
   * 認識が止まっている、または結果を返さず小さい声を捨てているときに付け直す。
   * 暫定が流れているあいだは切らない。マイクの取り合い直後も待たせる。
   * @param {'gap'|'stall'} reason
   * @returns {boolean}
   */
  nudge(reason) {
    if (!this.shouldRestart || !this.isListening) return false;
    if (this._hold || document.visibilityState === 'hidden') return false;
    const now = Date.now();
    if (this._restartNotBefore && now < this._restartNotBefore) return false;
    if (this._lastNudgeAt && now - this._lastNudgeAt < 3000) return false;

    if (!this._engineRunning) {
      this._lastNudgeAt = now;
      this._clearRestartTimer();
      this._restartNow();
      return true;
    }

    if (reason !== 'stall') return false;
    if ((this.interimTranscript || '').trim()) return false;
    const stallMs = Transcriber.speechWatchProfile(this.language, this._isIOS).resultMs;
    if (this._heardSpeechAt && now - this._heardSpeechAt < stallMs) return false;
    if (this._lastResultAt && now - this._lastResultAt < stallMs) return false;

    this._lastNudgeAt = now;
    this._commitPendingInterim();
    this._intentionalAbort = true;
    this._engineRunning = false;
    this._clearRestartTimer();
    this._clearJaHungWatch();
    this._scheduleRestart(Transcriber.restartDelay('stall', this._isIOS, this.language));
    try {
      if (this.recognition) this.recognition.abort();
    } catch {
      this._intentionalAbort = false;
    }
    return true;
  }

  /**
   * onend 後に認識インスタンスを作り直して再開する。連続呼び出しは1本にまとめる。
   * @param {number} [delayMs]
   * @private
   */
  _scheduleRestart(delayMs) {
    if (!this.shouldRestart || !this.isListening || this._restartTimer) return;

    const delay = typeof delayMs === 'number'
      ? delayMs
      : Transcriber.restartDelay('end', this._isIOS, this.language);
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
      this._heardSpeechAt = 0;
      this._lastResultAt = Date.now();
      this.retryCount = 0;
    } catch (error) {
      if (error && error.name === 'InvalidStateError') {
        this.retryCount++;
        if (this.retryCount > this.maxRetries) {
          this.stop();
          if (this.onError) this.onError('音声認識を継続できません。もう一度録音を開始してください。');
          return;
        }
        this._restartTimer = setTimeout(() => {
          this._restartTimer = null;
          this._restartNow();
        }, 160);
        return;
      }
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
   * 日本語 desktop で、speechend 後も暫定が確定しないときだけ付け直す。
   * 暫定が無いあいだは切らない（連続認識の待ち時間を潰さない）。iOS は onend に任せる。
   * @private
   */
  _armJaHungWatch() {
    this._clearJaHungWatch();
    if (this.language !== 'ja-JP' || this._isIOS) return;
    if (!this.shouldRestart || !this.isListening || !this._engineRunning) return;
    this._jaHungTimer = setTimeout(() => {
      this._jaHungTimer = null;
      if (!this.shouldRestart || !this.isListening || !this._engineRunning) return;
      const pending = (this.interimTranscript || '').trim();
      if (!Transcriber.shouldRecoverHungRecognition({
        language: this.language,
        ios: this._isIOS,
        msSinceResult: this.msSinceResult(),
        hasInterim: !!pending
      })) return;
      this._commitPendingInterim();
      this._intentionalAbort = true;
      this._engineRunning = false;
      this._clearRestartTimer();
      this._scheduleRestart(Transcriber.restartDelay('end', this._isIOS, this.language));
      try {
        if (this.recognition) this.recognition.abort();
      } catch {
        this._intentionalAbort = false;
      }
    }, Transcriber.jaHungWatchMs);
  }

  /**
   * @private
   */
  _clearJaHungWatch() {
    if (this._jaHungTimer) {
      clearTimeout(this._jaHungTimer);
      this._jaHungTimer = null;
    }
  }

  /**
   * desktop ja-JP のレベル監視。英語と iOS は v57 と同じしきい値。
   * @param {string} language
   * @param {boolean} ios
   * @returns {{floor: number, abs: number, mult: number, gapMs: number, stallMs: number, resultMs: number}}
   */
  static speechWatchProfile(language, ios) {
    if (language === 'ja-JP' && !ios) {
      // 初期しきい値は max(0.007, 0.004*2) = 0.008。0.01 前後の小声を拾い、0.008 以下の部屋ノイズは拾わない。
      return {
        floor: 0.004,
        abs: 0.007,
        mult: 2,
        gapMs: 400,
        stallMs: 1400,
        resultMs: 1600
      };
    }
    return {
      floor: 0.012,
      abs: 0.018,
      mult: 3.2,
      gapMs: 600,
      stallMs: 2000,
      resultMs: 2500
    };
  }

  /**
   * @param {number} level
   * @param {number} floor
   * @param {{abs: number, mult: number}} profile
   * @returns {boolean}
   */
  static isSpeechHot(level, floor, profile) {
    return level > Math.max(profile.abs, floor * profile.mult);
  }

  /**
   * 再起動までの待ち。desktop 日本語だけ隙間を詰める。iOS / 英語は v57 のまま。
   * @param {'no-speech'|'stall'|'end'} kind
   * @param {boolean} isIOS
   * @param {string} language
   * @returns {number}
   */
  static restartDelay(kind, isIOS, language) {
    const jaDesktop = language === 'ja-JP' && !isIOS;
    if (isIOS) {
      if (kind === 'no-speech' || kind === 'stall') return 70;
      return 90;
    }
    if (kind === 'no-speech') return jaDesktop ? 15 : 25;
    if (kind === 'stall') return jaDesktop ? 20 : 30;
    return jaDesktop ? 20 : 35;
  }

  /**
   * speechend 後、暫定がこのミリ秒動かなければ日本語 desktop だけ付け直す。
   */
  static jaHungWatchMs = 900;

  /**
   * @param {{language: string, ios: boolean, msSinceResult: number, hasInterim: boolean}} state
   * @returns {boolean}
   */
  static shouldRecoverHungRecognition(state) {
    if (!state || state.language !== 'ja-JP' || state.ios) return false;
    if (!state.hasInterim) return false;
    return state.msSinceResult >= Transcriber.jaHungWatchMs;
  }

  /**
   * 上位仮説が空、または尻切れのときだけ別案を採用する。文の書き換えはしない。
   * 言語を渡さない、または英語のときは v57 と同じ規則。
   * @param {SpeechRecognitionResult|Array<{transcript?: string, confidence?: number}>} result
   * @param {string} [language]
   * @returns {string}
   */
  static pickTranscript(result, language) {
    if (language === 'ja-JP') return Transcriber._pickTranscriptJa(result);
    return Transcriber._pickTranscriptEn(result);
  }

  /**
   * confidence が全て 0 のブラウザ（Chrome に多い）では、順位を信用する。
   * @param {SpeechRecognitionResult|Array<{transcript?: string, confidence?: number}>} result
   * @returns {string}
   */
  static _pickTranscriptEn(result) {
    if (!result || !result.length) return '';
    const n = Math.min(result.length, 3);
    let anyConfidence = false;
    for (let i = 0; i < n; i++) {
      const confidence = result[i] && typeof result[i].confidence === 'number' ? result[i].confidence : 0;
      if (confidence > 0) anyConfidence = true;
    }

    if (anyConfidence) {
      let bestText = (result[0] && result[0].transcript) || '';
      let bestScore = -1;
      for (let i = 0; i < n; i++) {
        const alt = result[i];
        if (!alt) continue;
        const text = alt.transcript || '';
        const trimmed = text.trim();
        if (!trimmed) continue;
        const score = alt.confidence + Math.min(trimmed.length, 40) * 0.0008;
        if (score > bestScore) {
          bestScore = score;
          bestText = text;
        }
      }
      return bestText;
    }

    const primary = (result[0] && result[0].transcript) || '';
    const base = primary.trim();
    if (!base) {
      for (let i = 1; i < n; i++) {
        const text = (result[i] && result[i].transcript) || '';
        if (text.trim()) return text;
      }
      return primary;
    }

    for (let i = 1; i < n; i++) {
      const text = (result[i] && result[i].transcript) || '';
      const trimmed = text.trim();
      if (!trimmed.startsWith(base)) continue;
      const rawExtra = trimmed.slice(base.length);
      const extra = rawExtra.trim();
      // 空白や句読点を含む伸びは別文なので採用しない。尻切れの続きだけ足す。
      if (extra && extra.length <= 12 && !/[\s。、！？!?]/.test(rawExtra)) return text;
    }
    return primary;
  }

  /**
   * 日本語は信頼度 0 が多く、早口の続きが 12 字を超える。最長の尻だけ足す。
   * 数字表記（3 / 三）の差では尻を捨てない。空白 1 つだけの区切りはモーラの続きとみなす。
   * @param {SpeechRecognitionResult|Array<{transcript?: string, confidence?: number}>} result
   * @returns {string}
   */
  static _pickTranscriptJa(result) {
    if (!result || !result.length) return '';
    const n = Math.min(result.length, 5);
    let anyConfidence = false;
    for (let i = 0; i < n; i++) {
      const confidence = result[i] && typeof result[i].confidence === 'number' ? result[i].confidence : 0;
      if (confidence > 0) anyConfidence = true;
    }

    if (anyConfidence) {
      let bestText = (result[0] && result[0].transcript) || '';
      let bestConf = 0;
      let bestScore = -1;
      const scoreN = Math.min(n, 3);
      for (let i = 0; i < scoreN; i++) {
        const alt = result[i];
        if (!alt) continue;
        const text = alt.transcript || '';
        const trimmed = text.trim();
        if (!trimmed) continue;
        const confidence = typeof alt.confidence === 'number' ? alt.confidence : 0;
        const score = confidence + Math.min(trimmed.length, 40) * 0.0008;
        if (score > bestScore) {
          bestScore = score;
          bestText = text;
          bestConf = confidence;
        }
      }
      return Transcriber._extendJaTail(bestText, result, n, bestConf);
    }

    const primary = (result[0] && result[0].transcript) || '';
    const base = primary.trim();
    if (!base) {
      for (let i = 1; i < n; i++) {
        const text = (result[i] && result[i].transcript) || '';
        if (text.trim()) return text;
      }
      return primary;
    }
    return Transcriber._extendJaTail(primary, result, n, 0);
  }

  /**
   * 漢数字との対応。長さは変えない。
   * @param {string} text
   * @returns {string}
   */
  static _foldJaDigits(text) {
    const digits = '〇一二三四五六七八九';
    return (text || '')
      .replace(/[0-9]/g, (ch) => digits[ch.charCodeAt(0) - 48])
      .replace(/[０-９]/g, (ch) => digits[ch.charCodeAt(0) - 0xFF10]);
  }

  /**
   * @param {string} primary
   * @param {SpeechRecognitionResult|Array<{transcript?: string, confidence?: number}>} result
   * @param {number} n
   * @param {number} bestConf
   * @returns {string}
   */
  static _extendJaTail(primary, result, n, bestConf) {
    const base = (primary || '').trim();
    if (!base) return primary || '';
    const foldBase = Transcriber._foldJaDigits(base);
    let best = primary;
    let bestExtra = 0;
    for (let i = 1; i < n; i++) {
      const alt = result[i];
      if (!alt) continue;
      const confidence = typeof alt.confidence === 'number' ? alt.confidence : 0;
      if (bestConf > 0 && confidence > 0 && confidence < bestConf - 0.12) continue;
      const trimmed = (alt.transcript || '').trim();
      if (!trimmed) continue;
      const folded = Transcriber._foldJaDigits(trimmed);
      if (!folded.startsWith(foldBase)) continue;
      const rawExtra = trimmed.slice(foldBase.length);
      const extra = rawExtra.trim();
      if (!extra || extra.length > 24) continue;
      if ((rawExtra.match(/[ \t\u3000]/g) || []).length > 1) continue;
      if (!/^[ \t\u3000]*[^ \t\u3000。、！？!?]+$/.test(rawExtra)) continue;
      if (extra.length <= bestExtra) continue;
      bestExtra = extra.length;
      const prefix = trimmed.slice(0, foldBase.length).replace(/[ \t\u3000]+$/g, '');
      best = prefix + extra;
    }
    return best;
  }

  /**
   * 確定チャンクの末尾と次チャンクの頭が同じとき、繰り返したモーラを一度だけ残す。
   * @param {string} left
   * @param {string} right
   * @returns {string}
   */
  static mergeJapaneseOverlap(left, right) {
    const a = (left || '').replace(/[。、！？!?\s\u3000]+$/g, '');
    const b = (right || '').replace(/^[。、！？!?\s\u3000]+/, '');
    if (!a || !b) return '';
    const max = Math.min(a.length, b.length, 24);
    for (let len = max; len >= 4; len--) {
      if (a.slice(-len) === b.slice(0, len)) return a.slice(0, -len) + b;
    }
    return '';
  }

  /**
   * 独立したフィラーだけ外す。あの / まあ / like など実語は残す。
   * @param {string} text
   * @param {string} language
   * @returns {string}
   */
  static stripFillers(text, language) {
    if (!text) return '';
    if (language === 'ja-JP') {
      // えーと系は語彙になりにくいので落とす。あのー / そのー は実語なので長音だけ外す。
      return text
        .replace(/えー+っと|えーっと|えーと|えっと/g, '')
        .replace(/あのー+|あの〜+/g, 'あの')
        .replace(/そのー+|その〜+/g, 'その')
        .replace(/^[、,\s]+/, '')
        .replace(/[ \t\u3000]{2,}/g, ' ');
    }
    return text
      .replace(/\b(?:um+|uh+)\b[,.]?/gi, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\s+([,.!?])/g, '$1');
  }

  /**
   * @param {string} raw
   * @private
   */
  _appendFinal(raw) {
    let next = Transcriber.stripFillers(raw, this.language).trim();
    if (!next) return;
    if (this.language === 'ja-JP') next = this._formatJapanesePunctuation(next);
    if (!next.trim()) return;

    const now = Date.now();
    const last = this._lastChunk || '';
    const mergeMs = this.language === 'ja-JP' ? 2200 : 1600;
    if (last && this._normalize(next) === this._normalize(last)) {
      const echo = now - this._lastChunkAt < 450;
      const promoted = this._lastFromInterim && now - this._lastChunkAt < mergeMs;
      if (echo || promoted) {
        this._lastFromInterim = false;
        return;
      }
    }

    if (
      this._lastFromInterim &&
      last &&
      now - this._lastChunkAt < mergeMs &&
      this._normalize(next).startsWith(this._normalize(last)) &&
      this._normalize(next).length > this._normalize(last).length
    ) {
      const current = this.finalTranscript || '';
      const base = current.slice(0, Math.max(0, current.length - last.length));
      this.finalTranscript = this._joinTranscript(base.trim(), next);
      this._lastChunk = next;
      this._lastChunkAt = now;
      this._lastFromInterim = false;
      return;
    }

    this.finalTranscript = this._joinTranscript(this.finalTranscript, next);
    this._lastChunk = next;
    this._lastChunkAt = now;
    this._lastFromInterim = false;
  }

  /**
   * セッションが切れる直前の暫定を、確定側へ移す。
   * @private
   */
  _commitPendingInterim() {
    const pending = (this.interimTranscript || '').trim();
    if (!pending) return;
    this.interimTranscript = '';
    const before = this.finalTranscript;
    this._appendFinal(pending);
    if (this.finalTranscript !== before) this._lastFromInterim = true;
    if (this.onResult) this.onResult(this.finalTranscript, this.interimTranscript);
  }

  /**
   * @param {string} text
   * @returns {string}
   * @private
   */
  _normalize(text) {
    return (text || '').replace(/[\s\u3000。、！？!?.,]+/g, '');
  }

  /**
   * 日本語はスペースを足さない。英語のチャンク間だけ空白を入れる。
   * @param {string} base
   * @param {string} next
   * @returns {string}
   * @private
   */
  _joinTranscript(base, next) {
    const b = (next || '').trim();
    if (!b) return base || '';
    const a = base || '';
    if (!a.trim()) return b;
    if (this.language === 'en-US') {
      if (/\s$/.test(a) || /^[,.!?)]/.test(b)) return a + b;
      return `${a.replace(/\s+$/, '')} ${b}`;
    }
    const left = a.replace(/[ \t\u3000]+$/g, '');
    const right = b.replace(/^[ \t\u3000]+/, '');
    return Transcriber.mergeJapaneseOverlap(left, right) || (left + right);
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

    // 3. 接続の末尾に「、」。裸の「から」は「三時から」など時刻に付くので補完しない。
    const commaPatterns = /(?:ですが|ので|けれど|けれども|そして|また|しかし|ただし|なお|だから|ですから)$/;
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
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Transcriber;
}
