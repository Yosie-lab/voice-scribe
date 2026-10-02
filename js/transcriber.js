/**
 * VoiceScribe — 音声認識（文字起こし）
 *
 * 担当を分ける:
 * - セッション: start / stop / continue / 再起動。マイクは開かない。
 * - 結果の確定: 候補選択、暫定の保全、重なり結合、描画コールバック。同じ区間は二度入れない。
 * - 回復: desktop ja が黙ったときだけ stop() して付け直す。仮説を捨てる abort() は回復に使わない。
 *
 * 制約:
 * - desktop ja は continuous:true で話しているあいだ暫定を流す。iOS は continuous:false。
 * - 英語 desktop の stall はこれまで通り abort。
 * - 認識の前に MediaRecorder がマイクを取る（desktop）。ここでは getUserMedia しない。
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
    this._finalCursor = 0;
    this._lastResultAt = 0;
    this._heardSpeechAt = 0;
    this._lastNudgeAt = 0;
    this._intentionalAbort = false;
    this._restartNotBefore = 0;
    this._sessionStartedAt = 0;
    this._speechEndedAt = 0;
    this._gotHypothesis = false;
    this._jaFastRestart = false;
    this._jaUnwedgeSent = false;
    this._isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    this._jaHungTimer = null;
    this._jaSpeechEndTimer = null;

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
    this._finalCursor = 0;
    this._clearJaHungWatch();
    this._clearJaSpeechEndFlush();

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
    // desktop ja も false にすると Chrome は単発になり、仮説が発話の終わりまで出ない。
    // 空字幕の原因は continuous ではなく、speechend / stall の abort。abort はしない。
    this.recognition.continuous = Transcriber.useContinuous(this.language, this._isIOS);
    this.recognition.interimResults = true;
    this.recognition.lang = this.language;
    // 日本語は上位が尻切れでも、うしろの候補にモーラが残ることがある。
    this.recognition.maxAlternatives = this.language === 'ja-JP' ? 5 : 3;

    this.recognition.onstart = () => this._onRecognitionStart();
    this.recognition.onspeechstart = () => this._onSpeechStart();
    this.recognition.onspeechend = () => this._onSpeechEnd();
    this.recognition.onresult = (event) => this._ingestResult(event);
    this.recognition.onerror = (event) => this._onRecognitionError(event);
    this.recognition.onend = () => this._onRecognitionEnd();
  }

  /**
   * セッションが動き始めた。仮説ウォッチはここから。
   * @private
   */
  _onRecognitionStart() {
    this._engineRunning = true;
    this._sessionStartedAt = Date.now();
    this._heardSpeechAt = 0;
    this._speechEndedAt = 0;
    this._gotHypothesis = false;
    this._jaFastRestart = false;
    this._jaUnwedgeSent = false;
    this._resumeWhenVisible = false;
    this._clearJaSpeechEndFlush();
    this._armJaLiveWatch();
  }

  /**
   * クラウド結果より先に「音は拾った」が来る。
   * @private
   */
  _onSpeechStart() {
    this._heardSpeechAt = Date.now();
  }

  /**
   * 仮説は speechend より後に届くことがある。ここでは止めない。
   * 黙った desktop ja は jaStaleStopMs 後に stop() する。900ms では切らない。
   * @private
   */
  _onSpeechEnd() {
    this._speechEndedAt = Date.now();
    this._armJaSpeechEndFlush();
  }

  /**
   * 結果を確定バッファへ取り込み、字幕を描く。
   * @param {SpeechRecognitionEvent} event
   * @private
   */
  _ingestResult(event) {
    this.retryCount = 0;
    this._contentionRestarts = 0;
    this._captureErrorNotified = false;
    this._lastResultAt = Date.now();

    let currentInterim = '';
    let currentFinal = '';
    const results = event.results || [];
    const resultIndex = typeof event.resultIndex === 'number' ? event.resultIndex : 0;
    const fromIndex = Math.max(resultIndex, this._finalCursor || 0);

    for (let i = fromIndex; i < results.length; i++) {
      const result = results[i];
      const text = Transcriber.pickTranscript(result, this.language);
      if (result.isFinal) {
        const folded = this._normalize(text);
        // 同じイベントの最終が同じ文面で二枚来ても、一枚だけ足す。
        if (folded && folded !== this._normalize(currentFinal)) currentFinal += text;
        this._finalCursor = i + 1;
      } else {
        currentInterim += text;
      }
    }

    const previousInterim = this.interimTranscript;
    const superseded = Transcriber.keepSupersededInterim(
      this.language,
      previousInterim,
      currentFinal,
      currentInterim
    );
    if (superseded) {
      const beforeSuper = this.finalTranscript;
      this._appendFinal(superseded);
      if (this.finalTranscript !== beforeSuper) this._lastFromInterim = true;
    }
    const before = this.finalTranscript;
    if ((currentFinal || '').trim()) this._appendFinal(currentFinal);
    if (this.finalTranscript === before) {
      const salvaged = Transcriber.salvageWipedInterim(
        this.language,
        previousInterim,
        '',
        currentInterim
      );
      if (salvaged) {
        this._appendFinal(salvaged);
        if (this.finalTranscript !== before) this._lastFromInterim = true;
      }
    }
    this.interimTranscript = Transcriber.stripEchoInterim(
      this.language,
      this.finalTranscript,
      currentInterim
    );
    if (this._speechEndedAt && this._lastResultAt >= this._speechEndedAt) {
      this._clearJaSpeechEndFlush();
    }

    if (this.onResult) {
      this.onResult(this.finalTranscript, this.interimTranscript);
    }

    if ((this.finalTranscript || this.interimTranscript || '').trim()) {
      this._gotHypothesis = true;
      this._clearJaHungWatch();
    } else if (this._engineRunning) {
      this._armJaLiveWatch();
    }

    // onend が先で、仮説が遅れて届いた。待っていた再起動を短くする。
    if (
      this._gotHypothesis &&
      this._isDesktopJa() &&
      !this._engineRunning &&
      this.shouldRestart &&
      this.isListening
    ) {
      this._clearRestartTimer();
      this._scheduleRestart(Transcriber.restartDelay('end', this._isIOS, this.language));
    }
  }

  /**
   * @param {SpeechRecognitionErrorEvent} event
   * @private
   */
  _onRecognitionError(event) {
    const err = event.error || 'error';
    console.warn('音声認識イベントエラー:', err);
    this._commitPendingInterim();

    // 小さい声は no-speech でセッションが切れる。暫定を残してすぐ付け直す。
    if (err === 'no-speech') {
      this._engineRunning = false;
      if (this._deferWhileHidden()) return;
      if (this.shouldRestart && this.isListening) {
        this._scheduleRestart(this._restartDelayFor('no-speech'));
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
        const jaWaiting = this._isDesktopJa() && !this._gotHypothesis
          && (intentional || this._speechEndedAt > 0);
        if (!jaWaiting) this._jaFastRestart = false;
        this._scheduleRestart(jaWaiting ? this._restartDelayFor('end') : (intentional ? 40 : 300));
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
  }

  /**
   * iOS は発話ごとに終わるので、ここで認識を作り直す。
   * 確定前の暫定は残す。再起動の隙間で早口の続きが消えるのを防ぐ。
   * @private
   */
  _onRecognitionEnd() {
    this._engineRunning = false;
    this._intentionalAbort = false;
    this._jaUnwedgeSent = false;
    this._clearJaHungWatch();
    this._clearJaSpeechEndFlush();
    this._commitPendingInterim();
    if (this._hold || document.visibilityState === 'hidden') {
      if (this.shouldRestart && this.isListening) this._resumeWhenVisible = true;
      return;
    }
    if (this.shouldRestart && this.isListening) {
      this._scheduleRestart(this._restartDelayFor('end'));
    } else {
      this.isListening = false;
      if (this.onEnd) this.onEnd();
    }
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
   * desktop Chrome の ja-JP。回復は stop()。iOS と英語は別経路。
   * @returns {boolean}
   * @private
   */
  _isDesktopJa() {
    return this.language === 'ja-JP' && !this._isIOS;
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
    this._sessionStartedAt = 0;
    this._speechEndedAt = 0;
    this._gotHypothesis = false;
    this._jaFastRestart = false;
    this._jaUnwedgeSent = false;
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
    this._jaFastRestart = false;
    this._jaUnwedgeSent = false;
    this._clearRestartTimer();
    this._clearJaHungWatch();
    this._clearJaSpeechEndFlush();
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
      // 予定済みの ja 再起動はピークで潰さない。init() が遅い onresult を外す。
      if (this.language === 'ja-JP' && !this._isIOS && this._restartTimer) return false;
      this._lastNudgeAt = now;
      this._clearRestartTimer();
      this._restartNow();
      return true;
    }

    if (reason !== 'stall') return false;
    // 仮説が無い desktop ja は切らない。2.5 秒の abort は音声を捨てる。
    // 仮説のあと結果が止まったときだけ stop() する。英語はこれまで通り abort。
    if (this._isDesktopJa()) {
      const sinceSpeechEnd = this._speechEndedAt ? now - this._speechEndedAt : 0;
      const action = Transcriber.jaStaleRecovery({
        language: this.language,
        ios: this._isIOS,
        gotResult: !!this._gotHypothesis,
        msSinceResult: this.msSinceResult(),
        msSinceSpeechEnd: sinceSpeechEnd,
        resultAfterSpeechEnd: !!(this._speechEndedAt && this._lastResultAt >= this._speechEndedAt)
      });
      if (action !== 'stop') return false;
      this._lastNudgeAt = now;
      return this._unwedgeJaSession();
    }
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
      this._speechEndedAt = 0;
      this._gotHypothesis = false;
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

  // -------------------------------------------------------------------------
  // desktop ja の回復。stop() は結果を求める。abort() は仮説を捨てるので使わない。
  // -------------------------------------------------------------------------

  /**
   * 仮説がまだ無い desktop ja だけ、長い無応答のあと stop() する。
   * abort() は結果を返さない。stop() はここまでの音声で結果を求める。
   * @private
   */
  _armJaLiveWatch() {
    this._clearJaHungWatch();
    if (!Transcriber.useJaLiveWatch(this.language, this._isIOS)) return;
    if (!this.shouldRestart || !this.isListening || !this._engineRunning) return;
    const startedAt = this._sessionStartedAt || Date.now();
    this._sessionStartedAt = startedAt;
    this._jaHungTimer = setTimeout(() => {
      this._jaHungTimer = null;
      if (!this.shouldRestart || !this.isListening || !this._engineRunning) return;
      const action = Transcriber.jaLiveRecovery({
        language: this.language,
        ios: this._isIOS,
        hasInterim: !!(this.interimTranscript || '').trim(),
        gotResult: !!this._gotHypothesis,
        msSinceStart: Date.now() - startedAt
      });
      if (action !== 'stop') return;
      this._intentionalAbort = true;
      try {
        if (this.recognition) this.recognition.stop();
      } catch {
        this._intentionalAbort = false;
      }
    }, Transcriber.jaLiveStopMs);
  }

  /**
   * speechend のあと仮説がまだ無いときだけ、再起動を遅らせる。
   * それ以外は英語と同じ待ち。ja を英語より短くすると onresult の前に init() する。
   * @param {'no-speech'|'stall'|'end'} kind
   * @returns {number}
   * @private
   */
  _restartDelayFor(kind) {
    if (this._jaFastRestart) {
      this._jaFastRestart = false;
      return Transcriber.restartDelay(kind, this._isIOS, this.language);
    }
    return Transcriber.endRestartDelay(
      this._isIOS,
      this.language,
      kind,
      this._lastResultAt,
      this._speechEndedAt
    );
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
   * speechend のあと、仮説より新しい結果が無い desktop ja を stop() する。
   * 仮説がまだ無いセッションは 8 秒側に任せ、ここでは切らない。
   * @private
   */
  _armJaSpeechEndFlush() {
    this._clearJaSpeechEndFlush();
    if (!Transcriber.useJaLiveWatch(this.language, this._isIOS)) return;
    if (!this.shouldRestart || !this.isListening || !this._engineRunning) return;
    const endedAt = this._speechEndedAt;
    if (!endedAt) return;
    this._jaSpeechEndTimer = setTimeout(() => {
      this._jaSpeechEndTimer = null;
      if (!this.shouldRestart || !this.isListening || !this._engineRunning) return;
      const action = Transcriber.jaStaleRecovery({
        language: this.language,
        ios: this._isIOS,
        gotResult: !!this._gotHypothesis,
        msSinceResult: this.msSinceResult(),
        msSinceSpeechEnd: Date.now() - endedAt,
        resultAfterSpeechEnd: this._lastResultAt >= endedAt
      });
      if (action !== 'stop') return;
      this._unwedgeJaSession();
    }, Transcriber.jaStaleStopMs);
  }

  /**
   * @private
   */
  _clearJaSpeechEndFlush() {
    if (this._jaSpeechEndTimer) {
      clearTimeout(this._jaSpeechEndTimer);
      this._jaSpeechEndTimer = null;
    }
  }

  /**
   * 黙った desktop ja に、ここまでの音声の結果を求め、すぐ付け直す。
   * abort() は使わない。仮説が無いセッションからは呼ばない。
   * @returns {boolean}
   * @private
   */
  _unwedgeJaSession() {
    if (this._jaUnwedgeSent) return false;
    if (!this.shouldRestart || !this.isListening || !this._engineRunning) return false;
    if (!this._isDesktopJa() || !this._gotHypothesis) return false;
    this._jaUnwedgeSent = true;
    this._jaFastRestart = true;
    this._intentionalAbort = true;
    this._clearJaSpeechEndFlush();
    this._commitPendingInterim();
    try {
      if (this.recognition) this.recognition.stop();
    } catch {
      this._jaFastRestart = false;
      this._intentionalAbort = false;
      this._jaUnwedgeSent = false;
      return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // 言語ポリシー。desktop ja の回復は stop()。speechend の abort は戻さない。
  // -------------------------------------------------------------------------

  /**
   * desktop ja-JP のレベル監視。英語と iOS は v57 と同じしきい値。
   * ja の低いしきい値とピークは、死んだ認識の gap だけに使う。
   * 動いている ja はレベルでは abort しない。仮説のあと黙ったら stop() だけ。
   * @param {string} language
   * @param {boolean} ios
   * @returns {{floor: number, abs: number, mult: number, gapMs: number, stallMs: number, resultMs: number, usePeak?: boolean, stallFloor?: number, stallAbs?: number, stallMult?: number}}
   */
  static speechWatchProfile(language, ios) {
    if (language === 'ja-JP' && !ios) {
      // gap の初期しきい値は max(0.007, 0.004*2) = 0.008。死んだ認識を 1 回のピークで付け直す。
      // stall は max(0.018, 0.012*3.2)。部屋ノイズのピークでは切らない。
      return {
        floor: 0.004,
        abs: 0.007,
        mult: 2,
        gapMs: 200,
        stallMs: 2000,
        resultMs: 2500,
        usePeak: true,
        stallFloor: 0.012,
        stallAbs: 0.018,
        stallMult: 3.2
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
   * ピークは死んだ認識の再起動だけに使う。動いている認識を切る判定は EMA と stall しきい値。
   * stallAbs が無いプロファイル（英語・iOS）は gap と同じレベルを stall にも使う。
   * @param {{abs: number, mult: number, usePeak?: boolean, stallAbs?: number, stallMult?: number}} profile
   * @param {number|null} ema
   * @param {number|null} peak
   * @param {number} gapFloor
   * @param {number} stallFloor
   * @returns {{gap: boolean, stall: boolean}}
   */
  static speechHotFlags(profile, ema, peak, gapFloor, stallFloor) {
    const usePeak = !!(profile && profile.usePeak && typeof peak === 'number' && !Number.isNaN(peak));
    const gapLevel = usePeak ? peak : ema;
    const gap = typeof gapLevel === 'number' && !Number.isNaN(gapLevel)
      && Transcriber.isSpeechHot(gapLevel, gapFloor, profile);
    const separateStall = !!(profile && profile.stallAbs != null);
    const stallSpec = separateStall
      ? { abs: profile.stallAbs, mult: profile.stallMult }
      : profile;
    const stallBase = separateStall ? stallFloor : gapFloor;
    const stall = typeof ema === 'number' && !Number.isNaN(ema)
      && Transcriber.isSpeechHot(ema, stallBase, stallSpec);
    return { gap: !!gap, stall: !!stall };
  }

  /**
   * 再起動までの待ち。desktop は言語で変えない。ja だけ短くすると仮説より先に init() する。
   * iOS は v57 のまま。
   * @param {'no-speech'|'stall'|'end'} kind
   * @param {boolean} isIOS
   * @param {string} [_language] 呼び出し互換。desktop の待ちは言語で変えない。
   * @returns {number}
   */
  static restartDelay(kind, isIOS, _language) {
    if (isIOS) {
      if (kind === 'no-speech' || kind === 'stall') return 70;
      return 90;
    }
    if (kind === 'no-speech') return 25;
    if (kind === 'stall') return 30;
    return 35;
  }

  /**
   * speechend 後に仮説が無い ja desktop の再起動待ち。これより短いと onresult を落とす。
   */
  static jaResultGraceMs = 3000;

  /**
   * 仮説が一度出た desktop ja が、その後結果を足さないとき stop() するまでの待ち。
   * jaResultGraceMs より長く、2.5 秒の stall abort と speechend 900ms の abort より遅い。
   */
  static jaStaleStopMs = 4500;

  /**
   * ライブ ja セッションを止めて結果を求めるまでの待ち。2.5 秒の abort は仮説より短い。
   */
  static jaLiveStopMs = 8000;

  /**
   * iOS だけ発話ごとに終わらせて onend で付け直す。
   * desktop は ja も en も continuous。ja だけ false にすると単発認識になり、
   * 暫定が話しているあいだ来ない（確定は発話終了か、仮説が無いときの stop で届く）。
   * @param {string} _language 呼び出し互換。desktop の continuous は言語で分けない。
   * @param {boolean} ios
   * @returns {boolean}
   */
  static useContinuous(_language, ios) {
    return !ios;
  }

  /**
   * @param {string} language
   * @param {boolean} ios
   * @returns {boolean}
   */
  static useJaLiveWatch(language, ios) {
    return language === 'ja-JP' && !ios;
  }

  /**
   * desktop ja のライブセッションは abort しない。無応答が長いときだけ stop。
   * @param {{language: string, ios: boolean, hasInterim: boolean, gotResult: boolean, msSinceStart: number}} state
   * @returns {'none'|'stop'}
   */
  static jaLiveRecovery(state) {
    if (!state || state.language !== 'ja-JP' || state.ios) return 'none';
    if (state.hasInterim || state.gotResult) return 'none';
    if (state.msSinceStart >= Transcriber.jaLiveStopMs) return 'stop';
    return 'none';
  }

  /**
   * 最初の仮説のあとに黙った desktop ja。stop は結果を求め、abort はしない。
   * 仮説が無いあいだは none（8 秒の jaLiveRecovery が持つ）。
   * 900ms / 2.5 秒では none。
   * @param {{language: string, ios: boolean, gotResult: boolean, msSinceResult: number, msSinceSpeechEnd: number, resultAfterSpeechEnd: boolean}} state
   * @returns {'none'|'stop'}
   */
  static jaStaleRecovery(state) {
    if (!state || state.language !== 'ja-JP' || state.ios) return 'none';
    if (!state.gotResult) return 'none';
    const speechEndHung = state.msSinceSpeechEnd >= Transcriber.jaStaleStopMs
      && !state.resultAfterSpeechEnd;
    const stale = state.msSinceResult >= Transcriber.jaStaleStopMs;
    if (speechEndHung || stale) return 'stop';
    return 'none';
  }

  /**
   * speechend 後、仮説がまだ無い ja desktop だけ再起動を遅らせる。
   * @param {boolean} isIOS
   * @param {string} language
   * @param {'no-speech'|'stall'|'end'} kind
   * @param {number} lastResultAt
   * @param {number} speechEndedAt
   * @returns {number}
   */
  static endRestartDelay(isIOS, language, kind, lastResultAt, speechEndedAt) {
    const waiting = language === 'ja-JP'
      && !isIOS
      && (kind === 'end' || kind === 'no-speech')
      && speechEndedAt > 0
      && !(lastResultAt >= speechEndedAt);
    if (waiting) return Transcriber.jaResultGraceMs;
    return Transcriber.restartDelay(kind, isIOS, language);
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
    const fa = Transcriber._foldJaDigits(a);
    const fb = Transcriber._foldJaDigits(b);
    const max = Math.min(fa.length, fb.length, 24);
    for (let len = max; len >= 4; len--) {
      if (fa.slice(-len) === fb.slice(0, len)) return a.slice(0, -len) + b;
    }
    // 全文が「えー」「えっと」だけのとき、次が同じ頭なら繰り返さず伸ばす。1文字は「あ」+「明日」になるので足さない。
    if (fa.length >= 2 && fa.length < 4 && fb.startsWith(fa)) return b;
    return '';
  }

  /**
   * 日本語の暫定が確定にならず空になったとき、その暫定を残す。
   * 認識器が返していない語は作らない。1文字の途中結果と、英語の暫定は残さない。
   * @param {string} language
   * @param {string} previousInterim
   * @param {string} currentFinal
   * @param {string} currentInterim
   * @returns {string}
   */
  static salvageWipedInterim(language, previousInterim, currentFinal, currentInterim) {
    if (language !== 'ja-JP') return '';
    if ((currentFinal || '').trim()) return '';
    if ((currentInterim || '').trim()) return '';
    const pending = (previousInterim || '').trim();
    if (pending.length < 2) return '';
    return pending;
  }

  /**
   * 日本語の暫定が、別発話の結果に置き換わって isFinal にならなかったとき、前の暫定を残す。
   * 伸び・縮み、頭への補足、同じ区間の書き換え（今日 / きょう）は同じ仮説なので残さない。
   * 暫定の方が長く尻が同じときは、フィラーを残すため暫定を返す。空への置き換えは salvage に任せる。
   * @param {string} language
   * @param {string} previousInterim
   * @param {string} currentFinal
   * @param {string} currentInterim
   * @returns {string}
   */
  static keepSupersededInterim(language, previousInterim, currentFinal, currentInterim) {
    if (language !== 'ja-JP') return '';
    const pending = (previousInterim || '').trim();
    if (pending.length < 2) return '';
    const next = `${currentFinal || ''}${currentInterim || ''}`.trim();
    if (!next) return '';
    const foldPending = Transcriber._foldJaDigits(Transcriber._plain(pending));
    const foldNext = Transcriber._foldJaDigits(Transcriber._plain(next));
    if (!foldPending || !foldNext) return '';
    if (foldNext.startsWith(foldPending) || foldPending.startsWith(foldNext)) return '';
    if (foldNext.length > foldPending.length && foldNext.endsWith(foldPending)) return '';
    if (foldPending.length > foldNext.length && foldPending.endsWith(foldNext)) return pending;
    if (Transcriber._sameJaRewrite(foldPending, foldNext)) return '';
    return pending;
  }

  /**
   * 句読点と空白を除いた比較用文字列。
   * @param {string} text
   * @returns {string}
   */
  static _plain(text) {
    return (text || '').replace(/[\s\u3000。、！？!?.,]+/g, '');
  }

  /**
   * 連続する共通部分。今日 / きょう のように頭が違う同じ発話を、別文と分ける。
   * @param {string} a
   * @param {string} b
   * @returns {number}
   */
  static _lcsLen(a, b) {
    const n = a ? a.length : 0;
    const m = b ? b.length : 0;
    if (!n || !m) return 0;
    let prev = new Array(m + 1).fill(0);
    let best = 0;
    for (let i = 1; i <= n; i++) {
      const cur = new Array(m + 1).fill(0);
      const ai = a[i - 1];
      for (let j = 1; j <= m; j++) {
        if (ai === b[j - 1]) {
          cur[j] = prev[j - 1] + 1;
          if (cur[j] > best) best = cur[j];
        }
      }
      prev = cur;
    }
    return best;
  }

  /**
   * @param {string} foldPending
   * @param {string} foldNext
   * @returns {boolean}
   */
  static _sameJaRewrite(foldPending, foldNext) {
    const shorter = Math.min(foldPending.length, foldNext.length);
    if (shorter < 4) return false;
    const shared = Transcriber._lcsLen(foldPending, foldNext);
    return shared >= 4 && shared >= shorter * 0.65;
  }

  /**
   * 確定の尻を繰り返す暫定は、画面にも次の確定にも残さない。
   * 英語は暫定が確定と完全に同じときだけ外す。
   * @param {string} language
   * @param {string} finalText
   * @param {string} interim
   * @returns {string}
   */
  static stripEchoInterim(language, finalText, interim) {
    const raw = interim || '';
    const pending = raw.trim();
    if (!pending) return '';
    const committed = (finalText || '').trim();
    if (!committed) return raw;

    if (language !== 'ja-JP') {
      const c = committed.replace(/\s+/g, ' ').trim();
      const i = pending.replace(/\s+/g, ' ').trim();
      if (c === i) return '';
      return raw;
    }

    const foldC = Transcriber._foldJaDigits(Transcriber._plain(committed));
    const foldI = Transcriber._foldJaDigits(Transcriber._plain(pending));
    if (!foldI) return '';
    if (foldC.endsWith(foldI)) return '';
    if (foldI.startsWith(foldC)) return Transcriber._slicePlain(pending, foldC.length);
    const max = Math.min(foldC.length, foldI.length, 24);
    for (let len = max; len >= 4; len--) {
      if (foldC.slice(-len) === foldI.slice(0, len)) return Transcriber._slicePlain(pending, len);
    }
    return raw;
  }

  /**
   * 句読点を数えずに plainLen 文字進めて、残りを返す。
   * @param {string} raw
   * @param {number} plainLen
   * @returns {string}
   */
  static _slicePlain(raw, plainLen) {
    const trimmed = (raw || '').trim();
    let counted = 0;
    let i = 0;
    while (i < trimmed.length && counted < plainLen) {
      if (!/[\s\u3000。、！？!?.,]/.test(trimmed[i])) counted += 1;
      i += 1;
    }
    return trimmed.slice(i).replace(/^[\s\u3000。、！？!?.,]+/, '');
  }

  /**
   * 英語の um / uh だけ外す。日本語のえー / えっと / あのーは残す。
   * @param {string} text
   * @param {string} language
   * @returns {string}
   */
  static stripFillers(text, language) {
    if (!text) return '';
    if (language === 'ja-JP') {
      // えー / えっと / あのー は字幕に残す。空白だけ整える。英語の um / uh はこれまで通り外す。
      return text
        .replace(/^[、,\s]+/, '')
        .replace(/[ \t\u3000]{2,}/g, ' ');
    }
    return text
      .replace(/\b(?:um+|uh+)\b[,.]?/gi, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\s+([,.!?])/g, '$1');
  }

  // -------------------------------------------------------------------------
  // 結果の確定。フィラーは残す。空になった暫定は残す。重なったモーラは一度だけ。
  // -------------------------------------------------------------------------

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

    const lastNorm = this._normalize(last);
    const nextNorm = this._normalize(next);
    const shortJa = this.language === 'ja-JP' && lastNorm.length >= 2 && lastNorm.length <= 8;
    if (
      last &&
      now - this._lastChunkAt < mergeMs &&
      (this._lastFromInterim || shortJa) &&
      nextNorm.startsWith(lastNorm) &&
      nextNorm.length > lastNorm.length
    ) {
      const current = this.finalTranscript || '';
      const base = current.slice(0, Math.max(0, current.length - last.length));
      this.finalTranscript = this._joinTranscript(base.trim(), next);
      this._lastChunk = next;
      this._lastChunkAt = now;
      this._lastFromInterim = false;
      return;
    }

    // 日本語の確定の尻に既にある区間（最終の再送、3 と 三）は足さない。言い直しは merge 窓のあと。
    const committedNorm = this._normalize(this.finalTranscript);
    if (
      this.language === 'ja-JP' &&
      nextNorm.length >= 4 &&
      committedNorm.endsWith(nextNorm) &&
      now - this._lastChunkAt < mergeMs
    ) {
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
    const plain = (text || '').replace(/[\s\u3000。、！？!?.,]+/g, '');
    if (this.language === 'ja-JP') return Transcriber._foldJaDigits(plain);
    return plain;
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
