/**
 * VoiceScribe — 録音中の字幕・認識・マイク復旧（VoiceScribeApp mixin）
 */
const VoiceScribeRecordingHealth = {
  async _resumeReading() {
    if (!this.isRecording || this._userPaused || this._stopPromise) return;
    const ios = this.transcriber.startBeforeRecorder;
    const captureDown = this.recorder.needsRecovery();

    // iOS: マイク復旧より先に認識を付ける（await 前）。録音経路の復旧は後ろで非同期。
    const kicked = this.transcriber.manualResumeListening(true);
    this._recoverAttempts = 0;
    this._startCaptionWatch();
    this._startSpeechWatch();
    this._armResumeBoost();
    this._syncResumeReading();
    if (!kicked) {
      this.ui.showToast('再開できませんでした。もう一度「再開」をタップしてください', 'error', 3500);
    } else {
      this.ui.showToast('🎙️ 聞き取りを開始しました。話してください', 'success', 2500);
    }

    if (captureDown && ios) {
      this.recorder.ensureCapture().then((stream) => {
        if (!this.isRecording || this._userPaused) return;
        if (this.visualizer && stream) {
          this.visualizer.stopIdleAnimation();
          this.visualizer.connectStream(stream);
        }
        if (!this.transcriber.isEngineRunning()) {
          this.transcriber.manualResumeListening(false);
        }
        this._syncResumeReading();
      }).catch((error) => {
        console.warn('読み取り再開でマイクを戻せませんでした:', error);
        this.ui.showToast('マイクの復旧に失敗しました。もう一度「再開」をタップしてください', 'error', 4000);
        this.transcriber._signalResumeNeeded();
        this._syncResumeReading();
      });
      return;
    }

    let stream = this.recorder.stream;
    if (captureDown) {
      try {
        stream = await this.recorder.ensureCapture();
      } catch (error) {
        console.warn('読み取り再開でマイクを戻せませんでした:', error);
        this.ui.showToast('マイクを再開できませんでした。', 'error');
        this._syncResumeReading();
        return;
      }
    }

    if (!this.isRecording || this._userPaused) return;
    if (this.visualizer && stream) {
      this.visualizer.stopIdleAnimation();
      await this.visualizer.connectStream(stream);
    }

    if (!this.transcriber.isEngineRunning()) {
      this.transcriber.manualResumeListening(ios);
    }
    this._syncResumeReading();
  },

  _armResumeBoost() {
    if (this._resumeBoostTimer) clearInterval(this._resumeBoostTimer);
    let ticks = 0;
    this._resumeBoostTimer = setInterval(() => {
      ticks++;
      if (!this.isRecording || this._userPaused || ticks > 20) {
        clearInterval(this._resumeBoostTimer);
        this._resumeBoostTimer = null;
        return;
      }
      if (!this.transcriber.inUserResumeGrace()) return;
      if (this.transcriber.isEngineRunning()) return;
      this.transcriber.manualResumeListening(false);
      this._syncResumeReading();
    }, 400);
  },

  _syncResumeReading() {
    const btn = document.getElementById('resume-reading-btn');
    const headerBtn = document.getElementById('resume-reading-header-btn');
    if (!this.transcriber) return;
    const targets = [btn, headerBtn].filter(Boolean);
    if (!targets.length) return;
    if (document.visibilityState === 'hidden') {
      targets.forEach((el) => { el.style.display = 'none'; });
      return;
    }
    const captureDown = !!(this.recorder && this.recorder.needsRecovery());
    const recognitionDown = this.transcriber.shouldShowManualResume() || captureDown;
    const show = !!(this.isRecording && !this._userPaused && recognitionDown);
    targets.forEach((el) => { el.style.display = show ? 'inline-flex' : 'none'; });
    if (typeof document !== 'undefined' && document.body) {
      document.body.classList.toggle('caption-stalled-recording', show);
    }
  },

  _ensureLiveRecognition() {
    if (!this.isRecording || this._userPaused) return;
    if (this.transcriber.isEngineRunning() && !this.transcriber.isCaptionStalled()) return;
    if (this.transcriber.needsResume()) this.transcriber.continueListening();
  },

  _checkCaptionHealth() {
    if (!this.isRecording || this._userPaused || document.visibilityState === 'hidden') return;
    if (this.transcriber._hold) {
      this.transcriber.resumeAfterBackground();
    } else if (this.transcriber._resumeWhenVisible && !this.transcriber.isEngineRunning()) {
      this.transcriber.resumeAfterBackground();
    }
    if (!this.transcriber.isListening) {
      this.transcriber.shouldRestart = true;
      this.transcriber.isListening = true;
    }
    this._syncResumeReading();
    if (this.transcriber._resumeNeeded) return;
    if (this.transcriber.inUserResumeGrace()) return;
    if (this.transcriber.isCaptionStalled()) {
      this.transcriber.reviveLiveCaption();
      this._syncResumeReading();
    }
  },

  _startSpeechWatch() {
    this._stopSpeechWatch();
    this._speechProfile = Transcriber.speechWatchProfile(
      this.transcriber.language,
      this.transcriber.startBeforeRecorder
    );
    this._speechFloor = this._speechProfile.floor;
    this._stallFloor = this._speechProfile.stallFloor ?? this._speechProfile.floor;
    this._speechHotMs = 0;
    this._stallHotMs = 0;
    this._speechWatch = setInterval(() => this._pollSpeechLevel(), 200);
  },

  _stopSpeechWatch() {
    if (this._speechWatch) {
      clearInterval(this._speechWatch);
      this._speechWatch = null;
    }
    this._speechHotMs = 0;
    this._stallHotMs = 0;
  },

  _startCaptionWatch() {
    this._stopCaptionWatch();
    this._captionWatch = setInterval(() => this._checkCaptionHealth(), 1000);
  },

  _stopCaptionWatch() {
    if (this._captionWatch) {
      clearInterval(this._captionWatch);
      this._captionWatch = null;
    }
  },

  _pollSpeechLevel() {
    this._checkCaptionHealth();
    if (!this.isRecording || this._userPaused || document.visibilityState === 'hidden') {
      this._speechHotMs = 0;
      this._stallHotMs = 0;
      return;
    }
    if (!this.visualizer || typeof this.visualizer.getSpeechLevel !== 'function') return;

    const profile = this._speechProfile || Transcriber.speechWatchProfile('en-US', false);
    const ema = this.visualizer.getSpeechLevel();
    let peak = null;
    if (profile.usePeak && typeof this.visualizer.getSpeechPeak === 'function') {
      const sampled = this.visualizer.getSpeechPeak();
      if (typeof sampled === 'number' && !Number.isNaN(sampled)) peak = sampled;
    }
    if ((ema == null || Number.isNaN(ema)) && peak == null) return;

    const flags = Transcriber.speechHotFlags(profile, ema, peak, this._speechFloor, this._stallFloor);
    if (!flags.gap) {
      const quiet = typeof ema === 'number' && !Number.isNaN(ema) ? ema : peak;
      this._speechFloor = this._speechFloor * 0.96 + quiet * 0.04;
      this._speechHotMs = 0;
    } else {
      this._speechHotMs += 200;
    }

    if (profile.stallAbs == null) {
      this._stallHotMs = this._speechHotMs;
    } else if (!flags.stall) {
      if (typeof ema === 'number' && !Number.isNaN(ema)) {
        this._stallFloor = this._stallFloor * 0.96 + ema * 0.04;
      }
      this._stallHotMs = 0;
    } else {
      this._stallHotMs += 200;
    }

    if (this._speechHotMs < profile.gapMs && this._stallHotMs < profile.stallMs) return;

    if (!this.transcriber.isEngineRunning()) {
      if (this._speechHotMs < profile.gapMs) return;
      this.transcriber.nudge('gap');
      this._speechHotMs = 0;
      this._stallHotMs = 0;
      return;
    }
    // 英語だけ、結果も speechstart も無い長い発話で abort して付け直す。
    // desktop ja は仮説のあと結果が止まったときだけ stop() する。2.5 秒では切らない。
    if (this._stallHotMs >= profile.stallMs && this.transcriber.msSinceResult() >= profile.resultMs) {
      this.transcriber.nudge('stall');
      this._speechHotMs = 0;
      this._stallHotMs = 0;
    }
  },

  _bindRecordingLifecycle() {
    const onHide = () => this._onRecordingHidden();
    const onShow = () => {
      if (!this.isRecording) this._syncViewportHeight();
      this._scheduleForegroundWork();
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') onHide();
      else onShow();
    });
    window.addEventListener('pagehide', onHide);
    window.addEventListener('pageshow', onShow);
    document.addEventListener('freeze', onHide);
    document.addEventListener('resume', onShow);
  },

  _onRecordingHidden() {
    if (!this.isRecording) return;
    this._backgrounded = true;
    this._syncViewportHeight();
    this.recorder.flush();
    if (!this._userPaused) this.transcriber.holdForBackground();
    this._checkpointRecording();
  },

  _scheduleForegroundWork() {
    if (this._recoverTimer) clearTimeout(this._recoverTimer);
    this._recoverTimer = setTimeout(() => {
      this._recoverTimer = null;
      this._onForeground();
    }, 80);
  },

  async _onForeground() {
    this._unstickUi();
    this._recoverPlaybackAfterForeground();
    if (this._checkpointHasAudio || this._bestTranscript || this._draftId) {
      this._refreshRecordingsList();
    }
    if (!this.isRecording) return;
    if (this._userPaused) {
      this.ui.setRecordingStatus('paused');
      return;
    }
    await this._recoverActiveRecording();
  },

  async _recoverActiveRecording() {
    if (this._recovering) return;
    this._recovering = true;
    try {
      await this._recoverActiveRecordingBody();
    } finally {
      this._recovering = false;
    }
  },

  async _recoverActiveRecordingBody() {
    if (!this.isRecording || this._userPaused) return;
    const gen = ++this._recoverGen;
    const wasBackground = this._backgrounded;
    this._backgrounded = false;

    const captureDown = this.recorder.needsRecovery();
    if (
      !wasBackground &&
      !captureDown &&
      this.transcriber.isEngineRunning() &&
      !this.transcriber.isCaptionStalled()
    ) {
      this.transcriber.resumeAfterBackground();
      this._recoverAttempts = 0;
      this._startTimer();
      this._startCaptionWatch();
      this._startSpeechWatch();
      this.ui.setRecordingStatus('recording');
      this._syncResumeReading();
      this._checkCaptionHealth();
      return;
    }

    this.ui.setRecordingStatus('recording');
    this._startTimer();

    if (captureDown) {
      this._recoverAttempts++;
      try {
        const stream = await this.recorder.ensureCapture();
        if (!this.isRecording || gen !== this._recoverGen) return;
        if (document.visibilityState === 'hidden') {
          this._backgrounded = true;
          return;
        }
        if (this.visualizer && stream) {
          this.visualizer.stopIdleAnimation();
          await this.visualizer.connectStream(stream);
        }
      } catch (error) {
        console.warn('録音の復帰に失敗:', error);
        if (!this.isRecording || gen !== this._recoverGen) return;
        if (document.visibilityState === 'hidden') {
          this._backgrounded = true;
          return;
        }
        // ユーザが停止するまで録音は終わらせない。テキストもマイクのチャンクも残す。
        if (this._recoverAttempts === 1) {
          this.ui.showToast('マイクが一時的に外れました。録音は続けています。', 'info', 4000);
        }
        this._syncResumeReading();
        this._scheduleCaptureRetry();
        return;
      }
    } else if (this.visualizer && this.visualizer.audioCtx && this.visualizer.audioCtx.state === 'suspended') {
      try {
        await this.visualizer.audioCtx.resume();
      } catch {
        // メータは録音継続に必須ではない
      }
    }

    if (!this.isRecording || gen !== this._recoverGen || this._userPaused) return;
    this._recoverAttempts = 0;
    // マイクを取り直したあとに認識を付ける。先に start すると desktop Chrome は abort する。
    if (captureDown && !this.transcriber.startBeforeRecorder) {
      this.transcriber.continueListening();
    } else {
      this.transcriber.resumeAfterBackground();
    }
    this.ui.setRecordingStatus('recording');
    this._armRecognitionGesture();
    this._syncResumeReading();
  },

  _scheduleCaptureRetry() {
    if (this._recoverTimer) clearTimeout(this._recoverTimer);
    const wait = Math.min(8000, 700 * Math.max(1, this._recoverAttempts));
    this._recoverTimer = setTimeout(() => {
      this._recoverTimer = null;
      if (!this.isRecording || this._userPaused || document.visibilityState === 'hidden') return;
      this._recoverActiveRecording();
    }, wait);
  }
};

if (typeof window !== 'undefined') window.VoiceScribeRecordingHealth = VoiceScribeRecordingHealth;
if (typeof module !== 'undefined' && module.exports) module.exports = VoiceScribeRecordingHealth;
