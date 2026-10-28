/**
 * VoiceScribe — 録音開始・停止・保存（VoiceScribeApp mixin）
 */
const VoiceScribeRecordingSession = {
  /**
   * @param {boolean} disabled
   * @private
   */
  _setLangButtonsDisabled(disabled) {
    document.querySelectorAll('.lang-btn').forEach((btn) => {
      btn.style.pointerEvents = disabled ? 'none' : '';
      btn.style.opacity = disabled ? '0.5' : '';
    });
  }
,

  /**
   * 録音の開始/停止を切り替え
   * @private
   */
  async _toggleRecording() {
    if (this._stopPromise) {
      await this._stopPromise;
      return;
    }
    if (this.isRecording) {
      await this._stopRecording();
    } else {
      await this._startRecording();
    }
  }
,

  /**
   * 録音を開始（iOS Safari同期起動＆完全フェイルセーフ）
   * @private
   */
  async _startRecording(options) {
    const armOffline = !!(this.whisperLive && this.whisperLive.isEnabled());
    if (armOffline) this.whisperLive.primeFromUserGesture();
    if (this._stopPromise) await this._stopPromise;
    if (this.isRecording || this._starting) return;
    this._starting = true;
    this._offlineWhisperFallback = false;
    this._offlineWhisperSession = armOffline;
    const continueDraft = !!(options && options.continueDraft);
    try {
    this._stopDraftPlayback();
    this._bindLiveTranscriptCallback();
    this.transcriber.setLanguage(this._activeLanguage());
    if (continueDraft && this._draftId) {
      this._armContinueDraftPrefixFromMemory();
    } else {
      this._resumeBase = '';
      this._resumePrefix = '';
    }

    this._restoreLockCheckpoint().then((restored) => {
      if (restored) this._rememberDraft(restored);
    }).catch(() => {});

    let prior = null;
    if (continueDraft && this._draftId) {
      try {
        prior = await this.storage.getById(this._draftId);
      } catch (error) {
        console.warn('続き録音の読み込みに失敗:', error);
      }
      if (!prior) {
        prior = {
          id: this._draftId,
          text: this._draftTranscript,
          transcript: this._draftTranscript,
          audioBlob: this._draftBlob,
          mimeType: this._draftMime,
          duration: this._draftDuration,
          durationMs: (this._draftDuration || 0) * 1000,
          createdAt: this._draftCreatedAt || Date.now(),
          language: this._draftLanguage,
          segments: this._draftSegments
        };
      }
    }

    this.isRecording = true;
    this._userPaused = false;
    this._recoverAttempts = 0;
    this._syncViewportHeight();
    this._checkpointBlob = null;
    if (prior) {
      const parts = this._audioParts(prior);
      this.currentRecordingId = prior.id;
      this._sessionCreatedAt = prior.createdAt || this._draftCreatedAt || Date.now();
      this._priorParts = parts;
      this._priorMime = prior.mimeType || '';
      this._priorDuration = prior.duration || Math.round((prior.durationMs || 0) / 1000);
      this._checkpointHasAudio = parts.length > 0;
      this._checkpointBlob = prior.audioBlob || parts[0] || null;
      const base = this._longerText(prior.text || prior.transcript, this._draftTranscript);
      this._resumeBase = base;
      this._resumePrefix = base ? `${base}\n\n— 続き ${this._resumeStamp()} —\n` : '';
      this._bestTranscript = this._resumePrefix || base;
    } else {
      this.currentRecordingId = StorageManager.generateId();
      this._sessionCreatedAt = Date.now();
      this._priorParts = null;
      this._priorMime = '';
      this._priorDuration = 0;
      this._resumeBase = '';
      this._resumePrefix = '';
      this._bestTranscript = '';
      this._checkpointHasAudio = false;
    }
    this.ui.setRecordingStatus('recording');
    this.ui.updateTimer(this._priorDuration || 0);
    this._startTimer();
    this._syncDraftControls();
    this.ui.updateTranscript(this._resumePrefix || '', '', true);
    if (this._resumePrefix) this._primeContinuedTranscript();

    const placeholderEl = document.getElementById('transcript-placeholder');
    if (placeholderEl) {
      placeholderEl.style.display = 'none';
    }

    if (!this._usesOfflineWhisper()) this._kickIosRecognitionInRecordGesture();

    let stream = null;
    try {
      stream = await this.recorder.start({
        language: this.transcriber.language,
        ios: this._isIOSDevice()
      });
      if (!this.isRecording) {
        try { await this.recorder.stop(); } catch { /* 停止済み */ }
        return;
      }
      this._bootstrapLiveTranscriptionAfterMic();
    } catch (recErr) {
      console.warn('MediaRecorder start warning:', recErr);
      if (!stream) {
        this.isRecording = false;
        this._userPaused = false;
        this._stopTimer();
        this.ui.setRecordingStatus('standby');
        this._haltLiveTranscription();
        this._setLangButtonsDisabled(false);
        return;
      }
    }

    if (!this.isRecording) return;

    if (this._usesOfflineWhisper()) {
      const started = await this._startOfflineWhisper(stream);
      if (!started && this.isRecording) {
        this._offlineWhisperFallback = true;
        this.ui.showToast('オフラインWhisperを開始できなかったので、Web Speechに戻します。', 'info', 4000);
        this._bootstrapLiveTranscriptionAfterMic();
        this._reattachLiveSttAfterMic();
        this._ensureLiveRecognition();
        this._startSpeechWatch();
        this._startCaptionWatch();
      }
    } else {
      this._reattachLiveSttAfterMic();
      this._ensureLiveRecognition();
      this._startSpeechWatch();
      this._startCaptionWatch();
    }

    if (this.visualizer && stream) {
      this.visualizer.stopIdleAnimation();
      await this.visualizer.connectStream(stream);
    }

    if (!this.isRecording) return;
    this._autoRecoverLiveStt();

    this._setLangButtonsDisabled(true);

    this.ui.showToast(prior ? '🎙️ 続きを録音中' : '🎙️ 録音中（お話しください）', 'success', 2000);
    } finally {
      this._starting = false;
      this._ensureLiveTranscriptionIdle();
    }
  }
,

  /**
   * 録音を停止して保存（Groq Whisper連携付き）
   * @private
   */
  async _stopRecording(options) {
    if (this._stopPromise) return this._stopPromise;
    const interrupted = !!(options && options.interrupted);
    const quiet = !!(options && options.quiet);
    this._stopPromise = this._stopRecordingBody(interrupted, quiet).finally(() => {
      this._stopPromise = null;
    });
    return this._stopPromise;
  }
,

  /**
   * Groq Whisper で停止後仕上げ（Web Speech のライブ結果の上書き）。
   * @param {string} liveTranscript
   * @param {Blob|null} audioBlob
   * @param {string} language
   * @param {boolean} interrupted
   * @param {boolean} joined
   * @returns {Promise<string>}
   * @private
   */
  async _finalizeTranscriptWithWhisper(liveTranscript, audioBlob, language, interrupted, joined) {
    let finalTranscript = liveTranscript;
    if (this._usesOfflineWhisper() && (liveTranscript || '').trim()) {
      return finalTranscript;
    }
    if (interrupted || !joined || !this.whisper.hasApiKey() || !audioBlob) {
      return finalTranscript;
    }
    this._whisperBusy = true;
    try {
      this.ui.showWhisperOverlay();
      const whisperText = await this.whisper.transcribeAudio(audioBlob, language);
      if (whisperText && whisperText.trim()) {
        finalTranscript = whisperText.trim();
      }
    } catch (whisperErr) {
      console.warn('Whisper自動文字起こし警告:', whisperErr);
      this.ui.showToast(`Whisperスキップ: ${whisperErr.message}`, 'info', 3000);
    } finally {
      this._whisperBusy = false;
      this.ui.hideWhisperOverlay();
    }
    return finalTranscript;
  }
,

  /**
   * 録音を停止して保存（Groq Whisper連携付き）
   * @private
   */
  async _stopRecordingBody(interrupted, quiet) {
    const uiEpoch = this._transcriptEpoch;
    this._stopSpeechWatch();
    this._stopCaptionWatch();
    this._stopIosSttWarmup();
    this._recoverGen++;
    this._checkpointGen++;
    if (this._recoverTimer) {
      clearTimeout(this._recoverTimer);
      this._recoverTimer = null;
    }

    if (this._usesOfflineWhisper() && this.whisperLive) {
      try {
        await this.whisperLive.finish();
      } catch (error) {
        console.warn('オフラインWhisperの締めに失敗:', error);
      }
    }
    let transcript = this._readLiveTranscript();
    const language = this._activeLanguage();
    const sessionId = this.currentRecordingId;
    const createdAt = this._sessionCreatedAt || Date.now();
    const priorParts = (this._priorParts || []).filter((blob) => blob && blob.size);
    const priorDuration = this._priorDuration || 0;
    this.recorder.flush();
    await this._awaitCheckpointIdle();
    const peeked = this.recorder.peekBlob();
    this._checkpointRecording({ force: true });
    this._haltLiveTranscription();

    let newTake = peeked.blob;
    let audioMime = peeked.mimeType || this._priorMime || 'audio/mp4';
    let segmentDuration = this.recorder.getElapsedTime() || 0;
    let stopParts = this._mergeAudioParts(priorParts, newTake || this._checkpointBlob);
    this._stageDraftFromStop({
      id: sessionId,
      parts: stopParts,
      mimeType: audioMime,
      transcript,
      duration: priorDuration + (newTake ? segmentDuration : 0),
      language,
      createdAt
    });
    this._finishRecordingUi(transcript, uiEpoch);

    try {
      const recResult = await this.recorder.stop();
      if (recResult && recResult.blob) {
        newTake = recResult.blob;
        audioMime = recResult.mimeType || audioMime;
        if (typeof recResult.duration === 'number') segmentDuration = recResult.duration;
      } else if (!newTake && this._checkpointBlob) {
        newTake = this._checkpointBlob;
      }
    } catch (e) {
      console.warn('Recorder stop warning:', e);
      if (!newTake && this._checkpointBlob) newTake = this._checkpointBlob;
    }
    stopParts = this._mergeAudioParts(priorParts, newTake);
    this._stageDraftFromStop({
      id: sessionId,
      parts: stopParts,
      mimeType: audioMime,
      transcript,
      duration: priorDuration + (newTake ? segmentDuration : 0),
      language,
      createdAt
    });

    try {
      let parts = stopParts.length ? stopParts.slice() : this._mergeAudioParts(priorParts, newTake);
      const kept = await this._savedSession(sessionId);
      if (!parts.length && kept) parts = this._audioParts(kept);
      transcript = this._collapseResumeTranscript(transcript);
      if (kept) transcript = this._longerText(transcript, kept.text || kept.transcript);
      transcript = this._collapseResumeTranscript(transcript);

      let audioBlob = parts[0] || (kept && kept.audioBlob) || null;
      let segments = null;
      let duration = priorDuration + (newTake ? segmentDuration : 0);
      if (!newTake && kept) duration = Math.max(duration, kept.duration || 0);
      let joined = parts.length <= 1;

      if (parts.length > 1) {
        try {
          audioBlob = await AudioRecorder.concatToWav(parts);
          audioMime = 'audio/wav';
          joined = true;
        } catch (error) {
          console.warn('続きの音声を結合できませんでした:', error);
          audioBlob = parts[0];
          audioMime = (audioBlob && audioBlob.type) || this._priorMime || audioMime;
          segments = parts;
          this.ui.showToast('続きの音声を1本にできなかったため、区切ったまま保存しました。', 'info', 4000);
        }
      } else if (audioBlob) {
        audioMime = audioBlob.type || audioMime;
      } else if (kept && kept.mimeType) {
        audioMime = kept.mimeType;
      }

      if (transcript || audioBlob || (segments && segments.length)) {
        let finalTranscript = await this._finalizeTranscriptWithWhisper(
          transcript, audioBlob, language, interrupted, joined
        );

        if (language === 'ja-JP' && finalTranscript && !/[。、！？!?\n]$/.test(finalTranscript)) {
          finalTranscript += '。';
        }

        const recording = await this._enqueueSave(() => this.storage.save({
          id: sessionId,
          title: this._generateTitle(finalTranscript, language),
          audioBlob: audioBlob,
          mimeType: audioMime,
          segments: segments,
          text: finalTranscript,
          transcript: finalTranscript,
          language: language,
          duration: duration,
          durationMs: duration * 1000,
          audioKey: sessionId,
          createdAt: createdAt
        }));
        this._rememberDraft(recording);
        this._clearCheckpointMeta(sessionId);
        await this._refreshRecordingsList();
        if (interrupted && !quiet) {
          this.ui.showToast('録音が中断されました。ここまでを保存しました。続きを録音できます。', 'info', 4000);
        } else if (!interrupted) {
          this.ui.showToast('✅ 録音と文字起こしを保存しました', 'success');
        }
        if (uiEpoch === this._transcriptEpoch) {
          this.ui.updateTranscript(finalTranscript, '', false);
          this._syncDraftControls();
        }
      } else {
        this._syncDraftControls();
      }

      this.ui.updateTimer(0);
    } catch (error) {
      console.error('録音停止エラー:', error);
      this._finishRecordingUi(transcript, uiEpoch);
      this._whisperBusy = false;
      if (this.ui.hideWhisperOverlay) this.ui.hideWhisperOverlay();
      this._syncDraftControls();
    }
  }
,

  /**
   * 録音フラグと操作ボタンを待機状態へ戻す。
   * @private
   */
  _finishRecordingUi(transcript, uiEpoch) {
    this.isRecording = false;
    this._userPaused = false;
    this._backgrounded = false;
    this._stopSpeechWatch();
    this._stopCaptionWatch();
    this._syncViewportHeight();
    this._stopTimer();

    if (this.visualizer) {
      try {
        this.visualizer.disconnect();
        this.visualizer.startIdleAnimation();
      } catch (e) {
        console.warn('Visualizer disconnect warning:', e);
      }
    }

    this.ui.setRecordingStatus('standby');
    this._setLangButtonsDisabled(false);
    if (uiEpoch !== undefined && uiEpoch !== this._transcriptEpoch) {
      this.ui.updateTranscript('', '', false);
    } else if (typeof transcript === 'string') {
      this.ui.updateTranscript(transcript, '', false);
    }
    if (this._recognitionGesture) {
      document.removeEventListener('pointerdown', this._recognitionGesture, true);
      this._recognitionGesture = null;
    }
    this._syncDraftControls();
  }
,

  /**
   * 録音タイマーを開始
   * @private
   */
  /**
   * 既存ストリームにオフライン Whisper を載せる。Web Speech は起動しない。
   * @param {MediaStream|null} stream
   * @returns {Promise<boolean>}
   * @private
   */
  async _startOfflineWhisper(stream) {
    if (!this.whisperLive || !stream) return false;
    const appLang = this._activeLanguage();
    this.whisperLive.setLanguage(WhisperLiveText.whisperLanguage(appLang));
    this.whisperLive.setPrefix(this._resumePrefix || '');
    try {
      return await this.whisperLive.start(stream);
    } catch (error) {
      console.warn('オフラインWhisper開始:', error);
      return false;
    }
  }
,

  _startTimer() {
    this._stopTimer();
    const base = this._priorDuration || 0;
    this.timerInterval = setInterval(() => {
      const elapsed = base + (this.recorder.getElapsedTime() || 0);
      this.ui.updateTimer(elapsed);
    }, 200);
  }
,

  /**
   * 録音タイマーを停止
   * @private
   */
  _stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

};

if (typeof window !== 'undefined') window.VoiceScribeRecordingSession = VoiceScribeRecordingSession;
if (typeof module !== 'undefined' && module.exports) module.exports = VoiceScribeRecordingSession;
