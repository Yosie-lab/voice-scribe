/**
 * VoiceScribe — 音声認識（文字起こし）
 *
 * 担当を分ける:
 * - セッション: start / stop / continue / 再起動。マイクは開かない。
 * - 結果の確定: 候補選択、暫定の保全、重なり結合、描画コールバック。同じ区間は二度入れない。
 * - 回復: desktop ja が黙ったときだけ stop() して付け直す。仮説を捨てる abort() は回復に使わない。
 * - 再起動が何度失敗しても、ユーザが止めるまで shouldRestart は落とさない。録音はここでは止めない。
 * - 同じ確定句の再送は repeatWindowMs のあいだ足さない。resultIndex は再起動で 0 に戻る。
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
    this._stopWatch = null;
    this._stopWatchGen = 0;
    this._stopWatchPending = false;
    this._resumeNeeded = false;
    this._restartDelayMs = 0;
    this._recentNorms = [];
    /** @type {string} 続き録音の接頭辞。dedupe はこのあとに足した分だけ見る。 */
    this._dedupeAnchorNorm = '';
    /** @type {string} 接頭辞の生テキスト（句読点畳みの対象外にする） */
    this._dedupeAnchorRaw = '';
    this._pendingStartAt = 0;
    this._startAckTimer = null;
    this._startAckGen = 0;
    this._lastReviveAt = 0;
    this._lastInterimAt = 0;
    this._lastInterimNorm = '';
    this._stallReviveCount = 0;
    this._lastCaptionChangeAt = 0;
    this._captionFingerprint = '';
    this._userResumeUntil = 0;

    // コールバック
    this.onResult = null; // (finalText, interimText) => {}
    this.onError = null;  // (errorMessage) => {}
    this.onEnd = null;    // () => {}
    this.onListeningChange = null; // () => {} 認識が落ちた / 戻った
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
    // 新しい認識の resultIndex は 0 から。カーソルを残すと次の発話まで捨て、字幕が止まったように見える。
    // 確定済みの句は消さない。同じ句の再送は _recentNorms で落とす。
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
    this._pendingStartAt = 0;
    this._clearStartAckWatch();
    this._resumeNeeded = false;
    this._stopWatchPending = false;
    this._clearStopWatch();
    this._sessionStartedAt = Date.now();
    this._heardSpeechAt = 0;
    this._speechEndedAt = 0;
    if ((this.finalTranscript || '').trim() || (this.interimTranscript || '').trim()) {
      this._gotHypothesis = true;
    } else {
      this._gotHypothesis = false;
    }
    this._jaFastRestart = false;
    this._jaUnwedgeSent = false;
    this._resumeWhenVisible = false;
    this._clearJaSpeechEndFlush();
    this._armJaLiveWatch();
    this._notifyListening();
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
    const beforeFinal = this.finalTranscript;
    const beforeInterimNorm = this._normalize(this.interimTranscript);

    let currentInterim = '';
    let currentFinal = '';
    /** @type {string[]} */
    const newFinals = [];
    const results = event.results || [];
    const resultIndex = typeof event.resultIndex === 'number' ? event.resultIndex : 0;
    const fromIndex = Math.max(resultIndex, this._finalCursor || 0);

    for (let i = fromIndex; i < results.length; i++) {
      const result = results[i];
      const text = Transcriber.pickTranscript(result, this.language);
      if (result.isFinal) {
        const folded = this._normalize(text);
        // 同じイベントの最終が同じ文面で二枚来ても、一枚だけ足す。
        if (folded && folded !== this._normalize(currentFinal)) {
          currentFinal += text;
          newFinals.push(text);
        }
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
    for (const piece of newFinals) {
      if ((piece || '').trim()) this._appendFinal(piece);
    }
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
    const cleanedInterim = this._cleanLiveInterim(
      this.finalTranscript,
      Transcriber.stripEchoInterim(
        this.language,
        this.finalTranscript,
        currentInterim
      )
    );
    const prevInterimNorm = this._normalize(this.interimTranscript);
    const nextInterimNorm = this._normalize(cleanedInterim);
    this.interimTranscript = cleanedInterim;
    if (nextInterimNorm !== prevInterimNorm) {
      this._lastInterimAt = Date.now();
      this._lastInterimNorm = nextInterimNorm;
    }
    if (this._speechEndedAt && this._lastResultAt > this._speechEndedAt) {
      this._clearJaSpeechEndFlush();
    }

    this._finalizeCaptionActivity(beforeFinal, beforeInterimNorm);

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
    this._engineRunning = false;
    this._pendingStartAt = 0;
    this._clearStartAckWatch();
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
    // 回数で stop() しない。止めると歌の途中で字幕が戻らない。
    // iOS は onend の再生成に任せ、ここは watch だけ付ける。
    if (err === 'aborted') {
      this._engineRunning = false;
      const intentional = this._intentionalAbort;
      this._intentionalAbort = false;
      if (this._deferWhileHidden()) return;
      if (!this.shouldRestart || !this.isListening) return;
      if (this._isIOS) {
        this._armStopWatch();
        return;
      }
      if (!intentional) {
        this._contentionRestarts++;
        this._restartNotBefore = Date.now() + 280;
        if (this._contentionRestarts > this.maxRetries) this._signalResumeNeeded();
      }
      const jaWaiting = this._isDesktopJa() && !this._gotHypothesis
        && (intentional || this._speechEndedAt > 0);
      if (!jaWaiting) this._jaFastRestart = false;
      const backoff = Math.min(1500, 300 + this._contentionRestarts * 120);
      this._scheduleRestart(jaWaiting ? this._restartDelayFor('end') : (intentional ? 40 : backoff));
      return;
    }

    if (err === 'audio-capture') {
      this._engineRunning = false;
      // 画面ロックはマイクを奪う。stop() すると復帰できなくなるので、録音セッション中は殺さない。
      if (this._deferWhileHidden()) return;
      if (this.shouldRestart && this.isListening) {
        this.retryCount++;
        if (this.retryCount > 2) this._signalResumeNeeded();
        this._scheduleRestart(Math.min(2500, 300 * this.retryCount));
        return;
      }
      if (this.onError) this.onError('マイクにアクセスできません。');
      this.stop();
      return;
    }
    if (err === 'not-allowed') {
      this._engineRunning = false;
      if (this._deferWhileHidden()) return;
      // 録音中の拒否はジェスチャが要る。セッションと確定テキストは残し、再開ボタンに渡す。
      if (this.shouldRestart && this.isListening && this._engineWasStarted) {
        this._signalResumeNeeded();
        return;
      }
      if (this.onError) this.onError('マイクの使用が許可されていません。');
      this.stop();
      return;
    }

    // network などで onend が来ないことがある。動いている扱いにしたままにしない。
    this._engineRunning = false;
    if (this._deferWhileHidden()) return;
    if (this.shouldRestart && this.isListening) {
      this.retryCount++;
      if (this.retryCount > 2) this._signalResumeNeeded();
      this._scheduleRestart(Math.min(2000, 300 + this.retryCount * 150));
    }
  }

  /**
   * iOS は発話ごとに終わるので、ここで認識を作り直す。
   * 確定前の暫定は残す。再起動の隙間で早口の続きが消えるのを防ぐ。
   * @private
   */
  _onRecognitionEnd() {
    this._engineRunning = false;
    this._pendingStartAt = 0;
    this._clearStartAckWatch();
    this._intentionalAbort = false;
    this._jaUnwedgeSent = false;
    this._stopWatchPending = false;
    this._clearStopWatch();
    this._clearJaHungWatch();
    this._clearJaSpeechEndFlush();
    this._commitPendingInterim();
    if (this._hold || document.visibilityState === 'hidden') {
      if (this.shouldRestart && this.isListening) this._resumeWhenVisible = true;
      if (this.onNeedsCheckpoint) this.onNeedsCheckpoint();
      this._notifyListening();
      return;
    }
    if (this.shouldRestart && this.isListening) {
      this._scheduleRestart(this._restartDelayFor('end'));
    } else {
      this.isListening = false;
      if (this.onEnd) this.onEnd();
      this._notifyListening();
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
    this._lastInterimAt = 0;
    this._lastInterimNorm = '';
    this._lastChunk = '';
    this._lastChunkAt = 0;
    this._lastFromInterim = false;
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
    this._resumeNeeded = false;
    this._restartDelayMs = 0;
    this._stopWatchPending = false;
    this._pendingStartAt = 0;
    this._recentNorms = [];
    this._dedupeAnchorNorm = '';
    this._dedupeAnchorRaw = '';
    this.retryCount = 0;
    this._contentionRestarts = 0;
    this._clearRestartTimer();
    this._clearStopWatch();
    this._clearStartAckWatch();
    this._hold = false;
    this._resumeWhenVisible = false;
    this.shouldRestart = true;
    this.isListening = true;

    return this._tryStartEngine('session');
  }

  /**
   * 続き録音の接頭辞。start() のあとに呼ぶ。接頭辞は dedupe の対象外にする。
   * @param {string} prefix
   */
  setContinuedPrefix(prefix) {
    const text = prefix || '';
    this.finalTranscript = text;
    this.interimTranscript = '';
    this._dedupeAnchorRaw = text;
    this._dedupeAnchorNorm = this._normalize(text);
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
    this._resumeNeeded = false;
    this._restartDelayMs = 0;
    this._stopWatchPending = false;
    this._pendingStartAt = 0;
    this._clearStartAckWatch();
    this._clearRestartTimer();
    this._clearStopWatch();
    this._clearJaHungWatch();
    this._clearJaSpeechEndFlush();
    this._commitPendingInterim();
    this._notifyListening();

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
    this._engineRunning = false;
    this._clearRestartTimer();
    this._clearStartAckWatch();
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
    if (this.inUserResumeGrace() && this.awaitingStartAck()) return true;
    return this.manualResumeListening(false);
  }

  /**
   * ユーザが再開を押した直後は、自動 revive と競合しない。
   * @returns {boolean}
   */
  inUserResumeGrace() {
    return !!(this._userResumeUntil && Date.now() < this._userResumeUntil);
  }

  /**
   * start() 済みで onstart 待ち。字幕が古くても、この間は needsResume で init しない。
   * @returns {boolean}
   */
  awaitingStartAck() {
    if (!this._pendingStartAt) return false;
    const ackMs = this._isIOS ? Transcriber.iosStartAckMs : Transcriber.startAckMs;
    return Date.now() - this._pendingStartAt < ackMs;
  }

  /**
   * MediaRecorder がマイクを取ったあと、onstart 前に落ちた認識を付け直す。
   * ack 待ちを中断する（再開 grace 中の二重 init とは別経路）。
   * @returns {boolean}
   */
  reattachAfterSharedMic() {
    if (!this.shouldRestart || !this.isListening) return false;
    if (this._engineRunning) return true;
    this._clearStartAckWatch();
    this._pendingStartAt = 0;
    const hadText = !!((this.finalTranscript || '').trim() || (this.interimTranscript || '').trim());
    for (let attempt = 0; attempt < 3; attempt++) {
      this.init();
      this._sessionStartedAt = Date.now();
      if (hadText) this._gotHypothesis = true;
      if (this._tryStartEngine('restart')) {
        this._resumeWhenVisible = false;
        this._heardSpeechAt = 0;
        this._speechEndedAt = 0;
        this.retryCount = 0;
        this._notifyListening();
        return true;
      }
    }
    this.retryCount++;
    this._scheduleRestart(Transcriber.restartDelay('end', this._isIOS, this.language));
    return false;
  }

  /**
   * ユーザタップで認識を付け直す。await より先に呼ぶ。ゾンビ engine も止めてから start する。
   * @param {boolean} [fromUserTap]
   * @returns {boolean}
   */
  manualResumeListening(fromUserTap = true) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return false;
    if (!fromUserTap && this.inUserResumeGrace() && this.awaitingStartAck()) return true;
    this.shouldRestart = true;
    this.isListening = true;
    this._hold = false;
    this._resumeWhenVisible = false;
    this._resumeNeeded = false;
    this._stallReviveCount = 0;
    this.retryCount = 0;
    this._contentionRestarts = 0;
    this._clearRestartTimer();
    this._clearStopWatch();
    this._clearJaHungWatch();
    this._clearJaSpeechEndFlush();
    this._engineRunning = false;
    const hadText = !!((this.finalTranscript || '').trim() || (this.interimTranscript || '').trim());

    // iOS は stop()→onend 待ちでジェスチャが切れる。init() の abort だけで作り直し、同期で start を数回試す。
    if (fromUserTap) this._userResumeUntil = Date.now() + 12000;
    const attempts = fromUserTap ? 6 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      this.init();
      this._sessionStartedAt = Date.now();
      if (hadText) this._gotHypothesis = true;
      if (this._tryStartEngine('restart')) {
        this._resumeWhenVisible = false;
        this._heardSpeechAt = 0;
        this._speechEndedAt = 0;
        this.retryCount = 0;
        this._notifyListening();
        return true;
      }
    }

    if (fromUserTap) {
      this._signalResumeNeeded();
      return false;
    }
    this.retryCount++;
    this._scheduleRestart(Transcriber.restartDelay('end', this._isIOS, this.language));
    return false;
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
    this._recentNorms = [];
  }

  /**
   * 認識が落ちていて、自動の短い再起動だけでは戻っていない。
   * 動いているあいだ、隠しているあいだ、発話ごとの短い切れ目では false。
   * @returns {boolean}
   */
  /**
   * @returns {number}
   * @private
   */
  _captionStaleThresholdMs() {
    return this._isIOS ? Transcriber.iosCaptionStaleMs : Transcriber.captionStaleMs;
  }

  /**
   * 録音中にユーザへ「再開」を見せるか。自動復帰だけに任せない。
   * @returns {boolean}
   */
  shouldShowManualResume() {
    if (!this.shouldRestart || !this.isListening) return false;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
    if (this.inUserResumeGrace()) {
      if (this._resumeNeeded) return true;
      if (this.awaitingStartAck() || this._engineRunning) return false;
    }
    if (this._resumeNeeded || this._resumeWhenVisible) return true;
    if (this._hold) return this.isCaptionStalled();
    const msStill = this.msSinceCaptionChange();
    if (this._isIOS && this._gotHypothesis && msStill >= Transcriber.iosResumeOfferMs) return true;
    if (this._gotHypothesis && msStill >= this._captionStaleThresholdMs()) return true;
    return this.needsResume() || this.isCaptionStalled();
  }

  needsResume() {
    if (!this.shouldRestart || !this.isListening) return false;
    if (this._hold) {
      if (this.awaitingStartAck()) return false;
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        return this.isCaptionStalled() || this._resumeNeeded || this._resumeWhenVisible;
      }
      return false;
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
    if (this.awaitingStartAck()) return false;
    const msResult = this.msSinceResult();
    const stale = msResult >= this._captionStaleThresholdMs();
    if (this._restartTimer && !stale) return false;
    if (this._resumeNeeded) return true;
    if (this.isCaptionStalled()) return true;
    if (this._engineRunning) {
      if (this._isIOS && stale && this._gotHypothesis) return true;
      return false;
    }
    return true;
  }

  /**
   * 録音中なのに字幕が止まっている。onstart だけ来て onresult が無い Chrome のゾンビも含む。
   * @returns {boolean}
   */
  isCaptionStalled() {
    if (!this.shouldRestart || !this.isListening) return false;
    if (this._hold && typeof document !== 'undefined' && document.visibilityState === 'visible') {
      return this.msSinceResult() >= Transcriber.captionBootMs;
    }
    if (this._hold) return false;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
    if (this.awaitingStartAck()) return false;
    const staleMs = this._captionStaleThresholdMs();
    const msResult = this.msSinceResult();
    const stale = msResult >= staleMs;
    if (this._restartTimer && !stale) return false;

    const interim = (this.interimTranscript || '').trim();
    if (interim) {
      const interimMs = this._lastInterimAt
        ? Date.now() - this._lastInterimAt
        : msResult;
      if (interimMs < staleMs) return false;
    }

    const now = Date.now();
    const sinceEngine = this._sessionStartedAt ? now - this._sessionStartedAt : msResult;
    if (!this._gotHypothesis) {
      const bootMs = this._isIOS ? Transcriber.iosCaptionBootMs : Transcriber.captionBootMs;
      return sinceEngine >= bootMs;
    }
    return stale;
  }

  /**
   * 字幕が止まったとき、録音は触らず認識だけ付け直す。
   * @returns {boolean}
   */
  reviveLiveCaption() {
    if (!this.shouldRestart || !this.isListening) return false;
    if (this._resumeNeeded || this.inUserResumeGrace()) return false;
    if (!this.isCaptionStalled()) return false;
    if (this._lastReviveAt && Date.now() - this._lastReviveAt < 2500) return false;
    if (this._stallReviveCount >= Transcriber.manualResumeAfterRevives) {
      this._signalResumeNeeded();
      return false;
    }
    this._lastReviveAt = Date.now();
    this._stallReviveCount++;

    if (!this._engineRunning) {
      this._clearRestartTimer();
      this._restartNow();
      return true;
    }

    if (this._isIOS) {
      this._clearRestartTimer();
      this._commitPendingInterim();
      this.interimTranscript = '';
      this._lastInterimAt = 0;
      this._lastInterimNorm = '';
      this._restartNow();
      if (this.onResult) this.onResult(this.finalTranscript, this.interimTranscript);
      return true;
    }

    if (this._isDesktopJa()) {
      if (!this._gotHypothesis) {
        this._intentionalAbort = true;
        try {
          if (this.recognition) {
            this.recognition.stop();
            this._armStopWatch();
          }
        } catch {
          this._intentionalAbort = false;
        }
        return true;
      }
      return this._unwedgeJaSession();
    }

    if (!this._gotHypothesis) {
      this._clearRestartTimer();
      this._restartNow();
      return true;
    }

    return this.nudge('stall');
  }

  /**
   * タップなしでは認識を始められなかったとき。確定テキストは消さない。
   */
  armResume() {
    this.shouldRestart = true;
    this.isListening = true;
    this._engineRunning = false;
    this._hold = false;
    this._signalResumeNeeded();
  }

  /**
   * 最後に文字が来てからのミリ秒。まだ一度もないときは Infinity。
   * @returns {number}
   */
  msSinceResult() {
    return this.msSinceCaptionChange();
  }

  /**
   * 字幕の中身が最後に変わってからのミリ秒（同文の再送だけでは進まない）。
   * @returns {number}
   */
  msSinceCaptionChange() {
    const t = this._lastCaptionChangeAt || this._lastResultAt;
    if (t) return Date.now() - t;
    if (this._sessionStartedAt) return Date.now() - this._sessionStartedAt;
    return Infinity;
  }

  /**
   * @param {string} beforeFinal
   * @param {string} beforeInterimNorm
   * @private
   */
  _finalizeCaptionActivity(beforeFinal, beforeInterimNorm) {
    if (this.language === 'ja-JP') {
      const polished = Transcriber.polishJaCommitted(this.finalTranscript, this._dedupeAnchorRaw);
      if (polished !== this.finalTranscript) this.finalTranscript = polished;
    }
    const fp = this._captionActivityFingerprint();
    const finalChanged = (this.finalTranscript || '') !== (beforeFinal || '');
    const interimNorm = this._normalize(this.interimTranscript);
    const interimChanged = interimNorm !== beforeInterimNorm;
    if (fp !== this._captionFingerprint || finalChanged || interimChanged) {
      this._captionFingerprint = fp;
      this._lastCaptionChangeAt = Date.now();
      this._lastResultAt = this._lastCaptionChangeAt;
      this._stallReviveCount = 0;
    }
  }

  /**
   * @returns {string}
   * @private
   */
  _captionActivityFingerprint() {
    const finalNorm = this._normalize(this.finalTranscript || '');
    if (finalNorm.length >= 20) return `f:${finalNorm}`;
    return `f:${finalNorm}|i:${this._normalize(this.interimTranscript || '')}`;
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

    if (this.inUserResumeGrace() && this.awaitingStartAck()) return false;
    if (!this._engineRunning) {
      // start() 直後は onstart 前。ここで init() すると desktop の初回認識が abort され字幕が空になる。
      if (this.awaitingStartAck()) return false;
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
        resultAfterSpeechEnd: !!(this._speechEndedAt && this._lastResultAt > this._speechEndedAt)
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
    this._restartDelayMs = delay;
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      this._restartNow();
    }, delay);
    this._notifyListening();
  }

  /**
   * @private
   */
  _deferWhileHidden() {
    if (this._hold || document.visibilityState === 'hidden') {
      if (this.shouldRestart && this.isListening) this._resumeWhenVisible = true;
      if (this.onNeedsCheckpoint) this.onNeedsCheckpoint();
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

    this.init();
    if (!this._tryStartEngine('restart')) {
      this.retryCount++;
      if (this.retryCount > this.maxRetries) this._signalResumeNeeded();
      this._scheduleRestart(Math.min(2000, 160 * Math.max(1, this.retryCount)));
      return;
    }
    this._resumeWhenVisible = false;
    this._heardSpeechAt = 0;
    this._speechEndedAt = 0;
    this._gotHypothesis = false;
    this.retryCount = 0;
  }

  /**
   * recognition.start() と onstart 待ち。onstart 前に _engineRunning を立てない。
   * @param {'session'|'restart'} kind
   * @returns {boolean}
   * @private
   */
  _tryStartEngine(kind) {
    if (!this.recognition) return false;
    this._engineRunning = false;
    this._pendingStartAt = Date.now();
    try {
      this.recognition.start();
      if (kind === 'session') this._engineWasStarted = true;
      this._armStartAckWatch();
      console.log(`音声文字起こし開始 (${this.language})`);
      return true;
    } catch (error) {
      console.warn('文字起こしstart警告:', error);
      this._pendingStartAt = 0;
      this._clearStartAckWatch();
      if (error.name === 'InvalidStateError') {
        try {
          this.recognition.stop();
        } catch {
          // 無視
        }
        try {
          this.recognition.start();
          if (kind === 'session') this._engineWasStarted = true;
          this._armStartAckWatch();
          return true;
        } catch (retryErr) {
          console.warn('文字起こし再start警告:', retryErr);
        }
      }
      if (kind === 'session') this.isListening = false;
      return false;
    }
  }

  /**
   * start() したのに onstart が来ない Chrome 向け。動いている扱いのまま黙るのを防ぐ。
   * @private
   */
  _armStartAckWatch() {
    this._clearStartAckWatch();
    const gen = ++this._startAckGen;
    this._startAckTimer = setTimeout(() => {
      this._startAckTimer = null;
      if (gen !== this._startAckGen) return;
      if (this._engineRunning || !this.shouldRestart || !this.isListening) return;
      if (!this._pendingStartAt) return;
      console.warn('音声認識 onstart 待ちがタイムアウトしたため、付け直します');
      this._pendingStartAt = 0;
      this._signalResumeNeeded();
      if (!this._restartTimer) this._scheduleRestart(Transcriber.restartDelay('end', this._isIOS, this.language));
    }, this._isIOS ? Transcriber.iosStartAckMs : Transcriber.startAckMs);
  }

  /**
   * @private
   */
  _clearStartAckWatch() {
    this._startAckGen += 1;
    if (this._startAckTimer) {
      clearTimeout(this._startAckTimer);
      this._startAckTimer = null;
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
   * stop() のあと onend が来ない Chrome は、エンジンが動いていることにしたまま黙る。
   * 録音は止めず、認識インスタンスだけ作り直す。
   * @private
   */
  _armStopWatch() {
    this._clearStopWatch();
    this._stopWatchPending = true;
    const gen = this._stopWatchGen;
    this._stopWatch = setTimeout(() => {
      this._stopWatch = null;
      if (gen !== this._stopWatchGen) return;
      if (!this._stopWatchPending) return;
      if (!this.shouldRestart || !this.isListening) return;
      this._stopWatchPending = false;
      this._engineRunning = false;
      this._jaUnwedgeSent = false;
      this._intentionalAbort = false;
      if (this._restartTimer) return;
      this._scheduleRestart(Transcriber.restartDelay('end', this._isIOS, this.language));
    }, Transcriber.stopWatchMs);
  }

  /**
   * @private
   */
  _clearStopWatch() {
    this._stopWatchGen += 1;
    if (this._stopWatch) {
      clearTimeout(this._stopWatch);
      this._stopWatch = null;
    }
  }

  /**
   * @private
   */
  _signalResumeNeeded() {
    if (!this.shouldRestart || !this.isListening) return;
    this._resumeNeeded = true;
    this._notifyListening();
  }

  /**
   * @private
   */
  _notifyListening() {
    if (this.onListeningChange) this.onListeningChange();
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
        if (this.recognition) {
          this.recognition.stop();
          this._armStopWatch();
        }
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
        resultAfterSpeechEnd: this._lastResultAt > endedAt
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
      if (this.recognition) {
        this.recognition.stop();
        this._armStopWatch();
      }
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
   * 同じ確定句を再送とみなす窓。
   * desktop ja の stop()+restart は jaStaleStopMs（4.5s）や jaResultGraceMs（3s）だけ空く。
   * 旧 2200ms では、再起動後に Chrome が同じ歌詞の final をもう一度出すと字幕が重複する。
   */
  static repeatWindowMs = 22000;

  /**
   * 日本語の確定・暫定をつなぐときに見る最大オーバーラップ（plain 文字）。
   * 24 だと歌詞級の再送で境界が二重になり、字幕が読めなくなる。
   */
  static jaOverlapMax = 128;

  /**
   * これより短い自動再起動では「再開」を出さない。iOS の発話ごとの切れ目で点滅させない。
   */
  static resumeGapMs = 1200;

  /**
   * 回復の stop() のあと onend が来ないとき、認識だけ付け直すまでの待ち。
   */
  static stopWatchMs = 800;

  /**
   * start() から onstart まで待つ時間。これより早い gap nudge は初回認識を abort する。
   */
  static startAckMs = 1200;

  /** iOS は onstart が遅れやすい。再開直後の二重 init を避ける */
  static iosStartAckMs = 2200;

  /**
   * onstart のあと一度も仮説が来ない desktop 向け。「再開」と自動復帰の目安。
   */
  static captionBootMs = 5000;

  /**
   * iOS は発話ごとに onend があり、最初の仮説まで時間がかかることがある。
   */
  static iosCaptionBootMs = 9000;

  /**
   * 仮説のあと結果が途切れたときの字幕停止。jaStaleStopMs と揃える。
   */
  static captionStaleMs = 4500;

  /**
   * iOS は発話ごとに onend があり、desktop より早く「止まった」ように見える。
   */
  static iosCaptionStaleMs = 3200;

  /** iOS で「再開」を出し始めるまで（確定が動いていない時間） */
  static iosResumeOfferMs = 1800;

  /**
   * この回数だけ自動付け直ししたあとは、タップ用の「再開」を出す。
   */
  static manualResumeAfterRevives = 2;

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
    if (fa === fb) return a;
    const max = Math.min(fa.length, fb.length, Transcriber.jaOverlapMax);
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
    const max = Math.min(foldC.length, foldI.length, Transcriber.jaOverlapMax);
    for (let len = max; len >= 4; len--) {
      if (foldC.slice(-len) === foldI.slice(0, len)) return Transcriber._slicePlain(pending, len);
    }
    return raw;
  }

  /**
   * 確定末尾に同じ塊が二重になったとき、外側の繰り返しだけ取る（接頭辞は触らない）。
   * @param {string} text
   * @param {string} [anchorRaw]
   * @returns {string}
   */
  static collapseAdjacentJaRepeats(text, anchorRaw) {
    const raw = (text || '').trim();
    if (!raw) return '';
    const anchor = (anchorRaw || '').trim();
    const head = anchor && raw.startsWith(anchor) ? anchor : '';
    let tail = head ? raw.slice(head.length) : raw;
    if (!tail) return raw;
    let norm = Transcriber._foldJaDigits(Transcriber._plain(tail));
    let changed = true;
    while (changed && norm.length >= 16) {
      changed = false;
      const cap = Math.min(Math.floor(norm.length / 2), Transcriber.jaOverlapMax);
      for (let unit = cap; unit >= 8; unit--) {
        if (norm.slice(-unit) !== norm.slice(-2 * unit, -unit)) continue;
        tail = Transcriber._trimLastPlain(tail, unit);
        norm = Transcriber._foldJaDigits(Transcriber._plain(tail));
        changed = true;
        break;
      }
    }
    return head + tail;
  }

  /**
   * 長い確定がほぼ半分ずつ重複（Hermes デモのような塊の再送）を1つに畳む。
   * @param {string} text
   * @param {string} [anchorRaw]
   * @returns {string}
   */
  static collapseJaNearHalfDuplicate(text, anchorRaw) {
    const raw = (text || '').trim();
    if (!raw) return '';
    const anchor = (anchorRaw || '').trim();
    const head = anchor && raw.startsWith(anchor) ? anchor : '';
    let tail = head ? raw.slice(head.length) : raw;
    let norm = Transcriber._foldJaDigits(Transcriber._plain(tail));
    if (norm.length < 40) return raw;
    let changed = true;
    while (changed && norm.length >= 40) {
      changed = false;
      const half = Math.floor(norm.length / 2);
      const a = norm.slice(0, half);
      const b = norm.slice(half);
      const shared = Transcriber._lcsLen(a, b);
      if (shared >= half * 0.72) {
        tail = Transcriber._headPlain(tail, half);
        norm = Transcriber._foldJaDigits(Transcriber._plain(tail));
        changed = true;
      }
    }
    return head + tail;
  }

  /**
   * @param {string} text
   * @param {string} [anchorRaw]
   * @returns {string}
   */
  static polishJaCommitted(text, anchorRaw) {
    let out = (text || '').trim();
    if (!out) return '';
    out = Transcriber.collapseRepeatedPhrase(out, 'ja-JP');
    out = Transcriber.collapseJaNearHalfDuplicate(out, anchorRaw);
    out = Transcriber.collapseAdjacentJaRepeats(out, anchorRaw);
    out = Transcriber.collapseJaNearHalfDuplicate(out, anchorRaw);
    return out;
  }

  /**
   * @param {string} raw
   * @param {number} plainLen
   * @returns {string}
   */
  static _trimLastPlain(raw, plainLen) {
    const trimmed = (raw || '').trim();
    if (!plainLen) return trimmed;
    let counted = 0;
    let i = trimmed.length;
    while (i > 0 && counted < plainLen) {
      i -= 1;
      if (!/[\s\u3000。、！？!?.,]/.test(trimmed[i])) counted += 1;
    }
    return trimmed.slice(0, i).replace(/[\s\u3000。、！？!?.,]+$/g, '');
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
  // 同じ句の再送は repeatWindowMs のあいだ足さない。再起動で resultIndex は 0 に戻る。
  // -------------------------------------------------------------------------

  /**
   * 句読点を除いて先頭 plainLen 文字を返す。
   * @param {string} raw
   * @param {number} plainLen
   * @returns {string}
   */
  static _headPlain(raw, plainLen) {
    const trimmed = (raw || '').trim();
    let counted = 0;
    let i = 0;
    while (i < trimmed.length && counted < plainLen) {
      if (!/[\s\u3000。、！？!?.,]/.test(trimmed[i])) counted += 1;
      i += 1;
    }
    return trimmed.slice(0, i).replace(/[\s\u3000。、！？!?.,]+$/g, '');
  }

  /**
   * Chrome が歌で同じ句を1つの final に二度入れることがある。全文が同じ単位の繰り返しなら一度にする。
   * 4文字未満の単位（あ、はい）は吃音なので畳まない。
   * @param {string} text
   * @param {string} language
   * @returns {string}
   */
  static collapseRepeatedPhrase(text, language) {
    if (language !== 'ja-JP') return text || '';
    const raw = (text || '').trim();
    if (!raw) return '';
    const norm = Transcriber._foldJaDigits(Transcriber._plain(raw));
    if (norm.length < 8) return raw;
    const maxUnit = Math.min(320, Math.floor(norm.length / 2));
    for (let unit = maxUnit; unit >= 4; unit--) {
      if (norm.length % unit !== 0) continue;
      const times = norm.length / unit;
      if (times < 2 || times > 12) continue;
      const piece = norm.slice(0, unit);
      let same = true;
      for (let t = 1; t < times; t++) {
        if (norm.slice(t * unit, (t + 1) * unit) !== piece) {
          same = false;
          break;
        }
      }
      if (!same) continue;
      return Transcriber._headPlain(raw, unit) || raw;
    }
    return raw;
  }

  /**
   * @param {number} now
   * @returns {{norm: string, at: number}[]}
   * @private
   */
  /**
   * この録音セッションで足した確定だけ（続き録音の接頭辞は除く）。
   * @returns {string}
   * @private
   */
  _committedNewNorm() {
    const full = this._normalize(this.finalTranscript);
    const anchor = this._dedupeAnchorNorm || '';
    if (!anchor) return full;
    if (!full || full.length <= anchor.length) return '';
    if (full.startsWith(anchor)) return full.slice(anchor.length);
    return full;
  }

  _recentRows(now) {
    const windowMs = Transcriber.repeatWindowMs;
    const kept = (this._recentNorms || []).filter((row) => row && row.norm && now - row.at < windowMs);
    this._recentNorms = kept;
    return kept;
  }

  /**
   * @param {string} norm
   * @param {number} now
   * @private
   */
  _rememberNorm(norm, now) {
    if (!norm) return;
    const rows = this._recentRows(now);
    rows.push({ norm, at: now });
    if (rows.length > 12) rows.splice(0, rows.length - 12);
    this._recentNorms = rows;
  }

  /**
   * @param {string} norm
   * @param {number} now
   * @returns {boolean}
   * @private
   */
  _touchNorm(norm, now) {
    const rows = this._recentRows(now);
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].norm === norm) {
        rows[i].at = now;
        return true;
      }
    }
    return false;
  }

  /**
   * 直近の確定と同じ句、または窓内に既にある同じ句。再起動後の final 再送をここで落とす。
   * 1文字は吃音と途中結果なので、旧来の 450ms だけ見る。
   * @param {string} nextNorm
   * @param {number} now
   * @returns {boolean}
   * @private
   */
  _isRepeatedCommit(nextNorm, now) {
    if (!nextNorm) return false;
    const rows = this._recentRows(now);
    const committedNew = this._committedNewNorm();
    const sinceChunk = now - (this._lastChunkAt || 0);
    if (nextNorm.length >= 8 && committedNew && committedNew === nextNorm) {
      return sinceChunk < Transcriber.repeatWindowMs;
    }
    if (nextNorm.length >= 4 && committedNew && committedNew.endsWith(nextNorm)) {
      if (nextNorm.length >= 8 && sinceChunk < Transcriber.repeatWindowMs) return true;
      if (sinceChunk < 450) return true;
    }
    if (!rows.length) return false;
    const latest = rows[rows.length - 1];
    if (latest.norm === nextNorm) {
      if (nextNorm.length >= 2) return true;
      return now - latest.at < 450;
    }
    if (this._dedupeAnchorNorm && nextNorm.length >= 8 && nextNorm === this._dedupeAnchorNorm && rows.length) {
      return true;
    }
    if (nextNorm.length < 4) return false;
    if (rows.some((row) => row.norm === nextNorm)) return true;
    if (nextNorm.length >= 8 && sinceChunk < Transcriber.repeatWindowMs) {
      if (rows.some((row) => row.norm.length > nextNorm.length && (
        row.norm.endsWith(nextNorm) || row.norm.startsWith(nextNorm)
      ))) return true;
      if (committedNew.length >= nextNorm.length) {
        if (committedNew.endsWith(nextNorm)) return true;
        if (committedNew.startsWith(nextNorm)) return true;
      }
    }
    if (
      nextNorm.length >= 10 &&
      sinceChunk < Transcriber.repeatWindowMs &&
      committedNew.length > nextNorm.length &&
      committedNew.includes(nextNorm)
    ) {
      const idx = committedNew.indexOf(nextNorm);
      if (idx === 0 || idx + nextNorm.length === committedNew.length) return true;
    }
    return false;
  }

  /**
   * @param {string} nextNorm
   * @param {number} now
   * @private
   */
  _dropRepeated(nextNorm, now) {
    if (!this._touchNorm(nextNorm, now)) this._rememberNorm(nextNorm, now);
    this._lastChunkAt = now;
    this._lastFromInterim = false;
  }

  /**
   * 歌の同一段落が暫定だけ繰り返されるのを落とす（確定側の dedupe と同じ窓）。
   * @param {string} finalText
   * @param {string} interim
   * @returns {string}
   * @private
   */
  _cleanLiveInterim(finalText, interim) {
    const raw = interim || '';
    const pending = raw.trim();
    if (!pending || this.language !== 'ja-JP') return raw;
    const foldI = this._normalize(pending);
    if (!foldI || foldI.length < 8) return raw;
    const now = Date.now();
    if (this._isRepeatedCommit(foldI, now)) return '';
    return raw;
  }

  /**
   * @param {string} raw
   * @private
   */
  _appendFinal(raw) {
    let next = Transcriber.stripFillers(raw, this.language).trim();
    if (!next) return;
    if (this.language === 'ja-JP') next = Transcriber.collapseRepeatedPhrase(next, this.language);
    if (this.language === 'ja-JP') next = this._formatJapanesePunctuation(next);
    if (!next.trim()) return;

    const now = Date.now();
    const last = this._lastChunk || '';
    const lastNorm = this._normalize(last);
    const nextNorm = this._normalize(next);
    if (!nextNorm) return;
    const mergeMs = this.language === 'ja-JP' ? 2200 : 1600;

    // 同じ句の連続、および再起動で再送された窓内の同一句。2200ms では grace / stale stop に届かない。
    if (nextNorm && this._isRepeatedCommit(nextNorm, now)) {
      this._dropRepeated(nextNorm, now);
      return;
    }

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
      if (this.language === 'ja-JP') {
        this.finalTranscript = Transcriber.collapseAdjacentJaRepeats(
          this.finalTranscript,
          this._dedupeAnchorRaw
        );
      }
      this._lastChunk = next;
      this._lastChunkAt = now;
      this._lastFromInterim = false;
      this._rememberNorm(nextNorm, now);
      return;
    }

    // 長い確定の尻だけが final で戻ってくる（3 と 三を含む）。言い直しは窓のあと。
    const committedNorm = this._committedNewNorm();
    if (
      this.language === 'ja-JP' &&
      nextNorm.length >= 4 &&
      committedNorm.endsWith(nextNorm) &&
      now - this._lastChunkAt < Transcriber.repeatWindowMs
    ) {
      this._dropRepeated(nextNorm, now);
      return;
    }

    if (this.language === 'ja-JP') {
      const left = (this.finalTranscript || '').trim();
      const merged = left
        ? Transcriber.mergeJapaneseOverlap(
          left.replace(/[ \t\u3000]+$/g, ''),
          next.replace(/^[ \t\u3000]+/, '')
        )
        : next.trim();
      if (left && merged && this._normalize(merged) === this._normalize(left)) {
        this._dropRepeated(nextNorm, now);
        return;
      }
    }

    this.finalTranscript = this._joinTranscript(this.finalTranscript, next);
    if (this.language === 'ja-JP') {
      this.finalTranscript = Transcriber.collapseAdjacentJaRepeats(
        this.finalTranscript,
        this._dedupeAnchorRaw
      );
    }
    this._lastChunk = next;
    this._lastChunkAt = now;
    this._lastFromInterim = false;
    this._rememberNorm(nextNorm, now);
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
