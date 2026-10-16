/**
 * VoiceScribe — メインアプリケーションコントローラー (VoiceScribeApp)
 * 各モジュール（Storage, Recorder, Transcriber, Whisper, Visualizer, UI）を統合管理
 */

/** @type {string} 設定画面とコンソールで確認するビルド番号 */
const APP_BUILD = 'v77';

class VoiceScribeApp {
  constructor() {
    this.storage = new StorageManager();
    this.recorder = new AudioRecorder();
    this.transcriber = new Transcriber();
    this.whisper = new WhisperService();
    this.ui = null;
    this.visualizer = null;

    // アプリケーション状態
    this.isRecording = false;
    this.currentRecordingId = null;
    this.currentDetailId = null;
    this.timerInterval = null;
    this.currentAudio = null;
    this.currentAudioUrl = null;
    this.playbackInterval = null;
    this._userPaused = false;
    this._backgrounded = false;
    this._recoverTimer = null;
    this._recoverGen = 0;
    this._recoverAttempts = 0;
    this._recovering = false;
    this._whisperBusy = false;
    this._stopPromise = null;
    this._sessionCreatedAt = 0;
    this._bestTranscript = '';
    this._checkpointHasAudio = false;
    this._checkpointBlob = null;
    this._checkpointing = false;
    this._checkpointGen = 0;
    this._saveChain = null;
    this._starting = false;
    this._draftId = null;
    this._draftBlob = null;
    this._draftMime = '';
    this._draftTranscript = '';
    this._draftCreatedAt = 0;
    this._draftLanguage = 'ja-JP';
    this._draftDuration = 0;
    this._draftSegments = null;
    this._priorParts = null;
    this._priorMime = '';
    this._priorDuration = 0;
    this._resumeBase = '';
    this._resumePrefix = '';
    this._draftAudio = null;
    this._draftAudioUrl = null;
    this._draftPlayToken = 0;
    this._speechWatch = null;
    this._captionWatch = null;
    this._speechProfile = null;
    this._speechFloor = 0.012;
    this._speechHotMs = 0;
    this._stallFloor = 0.012;
    this._stallHotMs = 0;
    this._transcriptEpoch = 0;

    window.app = this;
  }

  /**
   * アプリケーションを初期化
   */
  async init() {
    try {
      // ストレージ初期化
      await this.storage.init();

      // UI初期化
      this.ui = new UIManager();
      this.ui.initNavigation();

      // ビジュアライザー初期化
      const canvas = document.getElementById('visualizer-canvas');
      if (canvas) {
        this.visualizer = new AudioVisualizer(canvas);
        this.visualizer.startIdleAnimation();
      }

      // 各画面のイベントリスナー設定
      this._setupRecordView();
      this._bindRecordingLifecycle();
      this._bindViewportSync();
      this._setupListView();
      this._setupDetailView();

      // 音声認識対応状況の確認
      this._checkTranscriptionSupport();

      const restored = await this._restoreLockCheckpoint();
      if (restored) {
        this._rememberDraft(restored);
        const restoredText = restored.text || restored.transcript || '';
        if (restoredText) this.ui.updateTranscript(restoredText, '', false);
      }

      // 録音一覧の初回読み込み
      await this._refreshRecordingsList();

      this._syncViewportHeight();
      this.refreshDiagnostics();

      console.log(`VoiceScribe 初期化完了 (${APP_BUILD})`);
    } catch (error) {
      console.error('VoiceScribe 初期化エラー:', error);
    }
  }

  /**
   * 文字起こし機能の対応状況を確認
   * @private
   */
  _checkTranscriptionSupport() {
    const { available, reason } = Transcriber.checkAvailability();
    const unsupportedEl = document.getElementById('transcript-unsupported');

    if (!available && unsupportedEl) {
      unsupportedEl.classList.add('visible');
      const msgEl = unsupportedEl.querySelector('.unsupported-msg');
      if (msgEl) msgEl.textContent = reason;
    }
  }

  // =====================================
  // 1. 録音画面 (Record View) 制御
  // =====================================

  /**
   * 録音画面のイベントリスナーを設定
   * @private
   */
  _setupRecordView() {
    // 録音開始/停止ボタン
    const recordBtn = document.getElementById('record-btn');
    if (recordBtn) {
      recordBtn.addEventListener('click', () => this._toggleRecording());
    }

    // 言語切替ボタン
    const langBtns = document.querySelectorAll('.lang-btn');
    langBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        if (this.isRecording) return;
        langBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const lang = btn.dataset.lang;
        this.transcriber.setLanguage(lang);
      });
    });

    // 一時停止ボタン
    const pauseBtn = document.getElementById('pause-btn');
    if (pauseBtn) {
      pauseBtn.addEventListener('click', () => this._togglePause());
    }

    // クリアは録音中も有効。ジェスチャの pointerdown は preventDefault しない。
    const clearBtn = document.getElementById('clear-transcript-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', (event) => {
        event.preventDefault();
        this._clearTranscript();
      });
    }

    const resumeBtn = document.getElementById('resume-reading-btn');
    if (resumeBtn) {
      resumeBtn.addEventListener('click', () => {
        this._resumeReading();
      });
    }
    this.transcriber.onListeningChange = () => {
      this._syncResumeReading();
    };

    const liveObsidianBtn = document.getElementById('live-obsidian-btn');
    if (liveObsidianBtn) {
      liveObsidianBtn.addEventListener('click', () => this._saveLiveToObsidian());
    }

    // 録音エラーコールバック
    this.recorder.onError = (message) => {
      this.ui.showToast(message, 'error');
    };
    this.recorder.onInterrupted = () => {
      if (!this.isRecording || this._userPaused) return;
      this._checkpointRecording();
      if (document.visibilityState === 'hidden') {
        this._backgrounded = true;
        return;
      }
      this._scheduleForegroundWork();
    };
    this.recorder.onChunk = () => {
      if (!this.isRecording || !this._backgrounded) return;
      this._checkpointRecording();
    };
    this.transcriber.onNeedsCheckpoint = () => {
      if (!this.isRecording) return;
      this._checkpointRecording();
    };
    this.transcriber.onError = (message) => {
      this.ui.showToast(message, 'error');
    };

    const continueBtn = document.getElementById('continue-recording-btn');
    if (continueBtn) {
      continueBtn.addEventListener('click', () => {
        if (this.isRecording || this._stopPromise || this._starting) return;
        this._startRecording({ continueDraft: true });
      });
    }
    const draftPlayBtn = document.getElementById('draft-play-btn');
    if (draftPlayBtn) {
      draftPlayBtn.addEventListener('click', () => this._toggleDraftPlayback());
    }
  }

  /**
   * 画面上の文字起こしと認識バッファを消す。録音とマイクはそのまま。
   * 録音中は同じストリームのまま認識だけ付け直し、消した仮説を次の onresult で戻さない。
   * @private
   */
  _clearTranscript() {
    this._transcriptEpoch += 1;
    const keepListening = this.isRecording && !this._userPaused && this.transcriber.isListening;
    this.transcriber.reset();
    if (keepListening) {
      this.transcriber.continueListening();
    }
    this.ui.updateTranscript('', '', this.isRecording);
  }

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

  /**
   * 録音を開始（iOS Safari同期起動＆完全フェイルセーフ）
   * @private
   */
  async _startRecording(options) {
    if (this._stopPromise) await this._stopPromise;
    if (this.isRecording || this._starting) return;
    this._starting = true;
    const continueDraft = !!(options && options.continueDraft);
    try {
    const restored = await this._restoreLockCheckpoint();
    if (restored) this._rememberDraft(restored);
    this._stopDraftPlayback();

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

    // プレースホルダーを非表示
    const placeholderEl = document.getElementById('transcript-placeholder');
    if (placeholderEl) {
      placeholderEl.style.display = 'none';
    }

    this.transcriber.onResult = (finalText, interimText) => {
      this.ui.updateTranscript(finalText, interimText, true);
    };

    // iOS Safari はタップ同期で SpeechRecognition を先に起動する（continuous:false の再生成経路）。
    // desktop Chromium は逆順にすると getUserMedia が認識を abort し、ライブ文字が出ない。
    const recognitionFirst = this.transcriber.startBeforeRecorder;

    if (recognitionFirst) {
      let started = false;
      try {
        started = this.transcriber.start() !== false;
      } catch (e) {
        console.warn('SpeechRecognition start warning:', e);
      }
      if (!started) {
        this.transcriber.armResume();
        this.transcriber.continueListening();
      }
      this._primeContinuedTranscript();
    }

    try {
      const stream = await this.recorder.start({
        language: this.transcriber.language,
        ios: this.transcriber.startBeforeRecorder
      });
      if (!this.isRecording) {
        try { await this.recorder.stop(); } catch { /* 停止済み */ }
        return;
      }
      if (this.visualizer && stream) {
        this.visualizer.stopIdleAnimation();
        await this.visualizer.connectStream(stream);
      }
    } catch (recErr) {
      console.warn('MediaRecorder start warning:', recErr);
    }

    if (!this.isRecording) return;

    if (!recognitionFirst) {
      let started = false;
      try {
        started = this.transcriber.start() !== false;
      } catch (e) {
        console.warn('SpeechRecognition start warning:', e);
      }
      if (!started) {
        this.transcriber.armResume();
        this.transcriber.continueListening();
      }
      this._primeContinuedTranscript();
    }

    if (!this.isRecording) return;
    this._ensureLiveRecognition();
    this._startSpeechWatch();
    this._startCaptionWatch();

    // 言語ボタンを一時無効化
    document.querySelectorAll('.lang-btn').forEach((btn) => {
      btn.style.pointerEvents = 'none';
      btn.style.opacity = '0.5';
    });

    this.ui.showToast(prior ? '🎙️ 続きを録音中' : '🎙️ 録音中（お話しください）', 'success', 2000);
    } finally {
      this._starting = false;
      this._syncResumeReading();
    }
  }

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

  /**
   * 録音を停止して保存（Groq Whisper連携付き）
   * 途中で失敗しても、Clear / 再生が触れる待機状態に戻す。
   * @private
   */
  async _stopRecordingBody(interrupted, quiet) {
    const uiEpoch = this._transcriptEpoch;
    this._stopSpeechWatch();
    this._stopCaptionWatch();
    this._recoverGen++;
    this._checkpointGen++;
    if (this._recoverTimer) {
      clearTimeout(this._recoverTimer);
      this._recoverTimer = null;
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
    // stop() が onstop を待って固まっても、先に同じ ID へ書いて UI を戻す。
    this._checkpointRecording({ force: true });
    this.transcriber.stop();

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
        let finalTranscript = transcript;

        if (!interrupted && joined && this.whisper.hasApiKey() && audioBlob) {
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
        }

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

  /**
   * 録音フラグと操作ボタンを待機状態へ戻す。
   * @param {string} [transcript]
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
    document.querySelectorAll('.lang-btn').forEach((btn) => {
      btn.style.pointerEvents = '';
      btn.style.opacity = '';
    });
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
    this._syncResumeReading();
  }

  /**
   * start() は確定テキストを空にする。続き録音の接頭辞はそのあとで戻す。
   * @private
   */
  _primeContinuedTranscript() {
    if (!this._resumePrefix) return;
    this.transcriber.setContinuedPrefix(this._resumePrefix);
    this._bestTranscript = this._longerText(this._bestTranscript, this._resumePrefix);
    if (this.isRecording) this.ui.updateTranscript(this._resumePrefix, '', true);
  }

  /**
   * @returns {string}
   * @private
   */
  _resumeStamp() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  }

  /**
   * @param {string} live
   * @returns {string}
   * @private
   */
  _collapseResumeTranscript(live) {
    const text = (live || '').trim();
    const base = (this._resumeBase || '').trim();
    const prefix = (this._resumePrefix || '').trim();
    if (!prefix) return text;
    if (!text || text === base || text === prefix) return base;
    if (text.startsWith(prefix) && !text.slice(prefix.length).trim()) return base;
    return text;
  }

  /**
   * @param {string} left
   * @param {string} right
   * @returns {string}
   * @private
   */
  _longerText(left, right) {
    const a = (left || '').trim();
    const b = (right || '').trim();
    return b.length > a.length ? b : a;
  }

  /**
   * @returns {string}
   * @private
   */
  _activeLanguage() {
    const activeLangBtn = document.querySelector('.lang-btn.active');
    return activeLangBtn ? activeLangBtn.dataset.lang : 'ja-JP';
  }

  /**
   * @returns {string}
   * @private
   */
  _readLiveTranscript() {
    let transcript = (this.transcriber.getFullTranscript() || '').trim();
    if (!transcript) {
      const textEl = document.getElementById('transcript-text');
      if (textEl) transcript = (textEl.innerText || textEl.textContent || '').trim();
    }
    transcript = this._longerText(transcript, this._bestTranscript);
    if (transcript) this._bestTranscript = transcript;
    return transcript;
  }

  /**
   * @param {Object|null} recording
   * @returns {Blob[]}
   * @private
   */
  _audioParts(recording) {
    if (!recording) return [];
    if (recording.segments && recording.segments.length) {
      return recording.segments.filter((blob) => blob && blob.size);
    }
    return recording.audioBlob && recording.audioBlob.size ? [recording.audioBlob] : [];
  }

  /**
   * @param {Object} recording
   * @private
   */
  /**
   * 停止直後に IndexedDB の完了を待たず、再生ボタンだけ先に出す。
   * @private
   */
  _stageDraftFromStop({ id, parts, mimeType, transcript, duration, language, createdAt }) {
    if (!id) return;
    const blobs = (parts || []).filter((blob) => blob && blob.size);
    const text = (transcript || '').trim();
    if (!blobs.length && !text) return;
    this._draftId = id;
    if (text) this._draftTranscript = text;
    this._draftCreatedAt = createdAt || this._draftCreatedAt || Date.now();
    this._draftLanguage = language || this._draftLanguage || 'ja-JP';
    if (typeof duration === 'number' && duration >= 0) this._draftDuration = duration;
    this._draftMime = mimeType || this._draftMime || (blobs[0] && blobs[0].type) || 'audio/mp4';
    if (blobs.length > 1) {
      this._draftSegments = blobs;
      this._draftBlob = blobs[0];
    } else if (blobs.length === 1) {
      this._draftBlob = blobs[0];
      this._draftSegments = null;
    }
    this._syncDraftControls();
  }

  /**
   * @param {Blob[]} prior
   * @param {Blob|null} fresh
   * @returns {Blob[]}
   * @private
   */
  _mergeAudioParts(prior, fresh) {
    const base = (prior || []).filter((blob) => blob && blob.size);
    if (fresh && fresh.size) return base.concat([fresh]);
    return base.slice();
  }

  /**
   * @returns {Promise<void>}
   * @private
   */
  async _awaitCheckpointIdle() {
    for (let i = 0; i < 40 && this._checkpointing; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * @param {Object} recording
   * @private
   */
  _rememberDraft(recording) {
    if (!recording || !recording.id) return;
    this._draftId = recording.id;
    this._draftBlob = recording.audioBlob || null;
    this._draftMime = recording.mimeType || '';
    this._draftTranscript = recording.text || recording.transcript || '';
    this._draftCreatedAt = recording.createdAt || 0;
    this._draftLanguage = recording.language || 'ja-JP';
    this._draftDuration = recording.duration || Math.round((recording.durationMs || 0) / 1000);
    this._draftSegments = (recording.segments || []).filter((blob) => blob && blob.size);
    this._priorParts = null;
    this._priorMime = '';
    this._priorDuration = 0;
    this._resumeBase = '';
    this._resumePrefix = '';
    this._syncDraftControls();
  }

  /**
   * @private
   */
  _syncDraftControls() {
    const continueBtn = document.getElementById('continue-recording-btn');
    const playBtn = document.getElementById('draft-play-btn');
    const idle = !this.isRecording;
    const parts = this._draftSegments && this._draftSegments.length
      ? this._draftSegments
      : (this._draftBlob ? [this._draftBlob] : []);
    if (continueBtn) continueBtn.style.display = idle && this._draftId ? 'inline-flex' : 'none';
    if (playBtn) playBtn.style.display = idle && parts.length ? 'inline-flex' : 'none';
  }

  /**
   * @private
   */
  _toggleDraftPlayback() {
    if (this.isRecording) return;
    if (this._draftAudio && !this._draftAudio.paused) {
      this._stopDraftPlayback();
      return;
    }
    const parts = this._draftSegments && this._draftSegments.length
      ? this._draftSegments.filter((blob) => blob && blob.size)
      : (this._draftBlob ? [this._draftBlob] : []);
    if (!parts.length) return;
    const token = ++this._draftPlayToken;
    const playBtn = document.getElementById('draft-play-btn');
    const playAt = (index) => {
      if (token !== this._draftPlayToken) return;
      if (index >= parts.length) {
        this._stopDraftPlayback();
        return;
      }
      if (this._draftAudio) {
        try { this._draftAudio.pause(); } catch { /* 停止済み */ }
      }
      if (this._draftAudioUrl) URL.revokeObjectURL(this._draftAudioUrl);
      const url = URL.createObjectURL(parts[index]);
      const audio = new Audio(url);
      this._draftAudio = audio;
      this._draftAudioUrl = url;
      audio.onended = () => playAt(index + 1);
      audio.onerror = () => this._stopDraftPlayback();
      audio.play().catch(() => this._stopDraftPlayback());
      if (playBtn) playBtn.textContent = '停止';
    };
    playAt(0);
  }

  /**
   * @private
   */
  _stopDraftPlayback() {
    this._draftPlayToken++;
    if (this._draftAudio) {
      try { this._draftAudio.pause(); } catch { /* 停止済み */ }
      this._draftAudio = null;
    }
    if (this._draftAudioUrl) {
      URL.revokeObjectURL(this._draftAudioUrl);
      this._draftAudioUrl = null;
    }
    const playBtn = document.getElementById('draft-play-btn');
    if (playBtn) playBtn.textContent = '再生';
  }

  /**
   * ロックや終了の前に、同じ録音 ID へ音声と文字起こしを書く。
   * テキストは localStorage、音声 Blob は IndexedDB。Blob は localStorage に入れない。
   * @private
   */
  _checkpointRecording(options) {
    const force = !!(options && options.force);
    if (this._checkpointing || !this.currentRecordingId) return;
    if (!force && !this.isRecording) return;
    this._checkpointing = true;
    const gen = ++this._checkpointGen;
    try {
      this.recorder.flush();
      const transcript = this._collapseResumeTranscript(this._readLiveTranscript());
      const peeked = this.recorder.peekBlob();
      if (peeked.blob) this._checkpointBlob = peeked.blob;
      const prior = (this._priorParts || []).filter((blob) => blob && blob.size);
      const fresh = peeked.blob || (!prior.length ? this._checkpointBlob : null);
      const parts = fresh ? prior.concat([fresh]) : prior.slice();
      if (!transcript && !parts.length) return;

      const language = this._activeLanguage();
      const createdAt = this._sessionCreatedAt || Date.now();
      const added = fresh ? (this.recorder.getElapsedTime() || 0) : 0;
      const duration = (this._priorDuration || 0) + added;
      const meta = {
        id: this.currentRecordingId,
        title: this._generateTitle(transcript, language),
        text: transcript,
        transcript: transcript,
        language: language,
        duration: duration,
        durationMs: duration * 1000,
        createdAt: createdAt,
        updatedAt: Date.now(),
        audioKey: this.currentRecordingId,
        mimeType: (parts[0] && parts[0].type) || this._priorMime || peeked.mimeType || 'audio/mp4'
      };
      try {
        localStorage.setItem('voicescribe-lock-checkpoint', JSON.stringify(meta));
      } catch (error) {
        console.warn('文字起こしの退避に失敗:', error);
      }

      if (!parts.length && this._checkpointHasAudio) return;

      const audioBlob = parts[0] || null;
      const record = Object.assign({}, meta, {
        audioBlob: audioBlob,
        segments: parts.length > 1 ? parts : null
      });
      this._enqueueSave(async () => {
        if (gen !== this._checkpointGen) return;
        await this.storage.save(record);
        if (gen !== this._checkpointGen) return;
        if (audioBlob) this._checkpointHasAudio = true;
        this._refreshRecordingsList();
      }).catch((error) => {
        console.warn('中断チェックポイントの保存に失敗:', error);
      });
    } finally {
      this._checkpointing = false;
    }
  }

  /**
   * @param {string} id
   * @private
   */
  _clearCheckpointMeta(id) {
    try {
      const raw = localStorage.getItem('voicescribe-lock-checkpoint');
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!data || !id || data.id === id) localStorage.removeItem('voicescribe-lock-checkpoint');
    } catch {
      // メタが読めなくても本体は IndexedDB
    }
  }

  /**
   * ページが閉じられたあとも、ロック前の文字起こしを履歴へ戻す。
   * @returns {Promise<Object|null>}
   * @private
   */
  async _restoreLockCheckpoint() {
    let raw = null;
    try {
      raw = localStorage.getItem('voicescribe-lock-checkpoint');
    } catch {
      return null;
    }
    if (!raw) return null;

    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!data || !data.id) return null;

    let existing = null;
    try {
      existing = await this.storage.getById(data.id);
    } catch (error) {
      console.warn('チェックポイントの読み込みに失敗:', error);
      return null;
    }

    const transcript = this._longerText(data.text || data.transcript, existing && (existing.text || existing.transcript));
    const parts = this._audioParts(existing);
    if (!transcript && !parts.length) {
      this._clearCheckpointMeta(data.id);
      return null;
    }

    try {
      const saved = await this.storage.save({
        id: data.id,
        title: (existing && existing.title) || data.title || this._generateTitle(transcript, data.language || 'ja-JP'),
        audioBlob: (existing && existing.audioBlob) || parts[0] || null,
        mimeType: (existing && existing.mimeType) || data.mimeType || 'audio/mp4',
        segments: existing && existing.segments && existing.segments.length > 1 ? existing.segments : null,
        text: transcript,
        transcript: transcript,
        language: data.language || (existing && existing.language) || 'ja-JP',
        duration: Math.max(data.duration || 0, (existing && existing.duration) || 0),
        durationMs: Math.max(data.durationMs || 0, (existing && existing.durationMs) || 0, Math.round(Math.max(data.duration || 0, (existing && existing.duration) || 0) * 1000)),
        audioKey: data.audioKey || data.id,
        createdAt: data.createdAt || (existing && existing.createdAt) || Date.now()
      });
      this._clearCheckpointMeta(data.id);
      return await this._materializeAudio(saved);
    } catch (error) {
      console.warn('ロック中の文字起こしを復元できませんでした:', error);
      return null;
    }
  }

  /**
   * @param {Object} recording
   * @returns {Promise<Object>}
   * @private
   */
  async _materializeAudio(recording) {
    if (!recording) return recording;
    const parts = this._audioParts(recording);
    if (parts.length <= 1) {
      if (parts.length === 1 && !recording.audioBlob) recording.audioBlob = parts[0];
      if (recording.segments) {
        recording.segments = null;
        try { return await this.storage.save(recording); } catch { return recording; }
      }
      return recording;
    }
    try {
      const wav = await AudioRecorder.concatToWav(parts);
      return await this.storage.save(Object.assign({}, recording, {
        audioBlob: wav,
        mimeType: 'audio/wav',
        segments: null
      }));
    } catch (error) {
      console.warn('音声セグメントの結合に失敗:', error);
      return recording;
    }
  }

  /**
   * @param {string} id
   * @returns {Promise<Object|null>}
   * @private
   */
  async _savedSession(id) {
    if (!id) return null;
    try {
      return await this.storage.getById(id);
    } catch {
      return null;
    }
  }

  /**
   * チェックポイントと停止保存が同じ録音を上書きし合わないように直列化する。
   * @param {() => Promise<*>} task
   * @returns {Promise<*>}
   * @private
   */
  _enqueueSave(task) {
    const prev = this._saveChain || Promise.resolve();
    const next = prev.then(task, task);
    this._saveChain = next.then(() => {}, () => {});
    return next;
  }

  /**
   * ロック解除の start() がジェスチャ不足で拒否されたとき、
   * 録音ボタン以外の次のタップで同じ文字起こしを再開する。
   * @private
   */
  _armRecognitionGesture() {
    if (this._recognitionGesture) return;
    const onPointer = (event) => {
      if (!this.isRecording || this._userPaused) {
        document.removeEventListener('pointerdown', onPointer, true);
        this._recognitionGesture = null;
        return;
      }
      const target = event.target;
      // クリアは次の click に任せる。このリスナはイベントを止めない。
      if (target && target.closest && target.closest('#record-btn, #pause-btn, #clear-transcript-btn, #continue-recording-btn, #draft-play-btn, #resume-reading-btn')) return;
      if (this.transcriber.isEngineRunning()) {
        document.removeEventListener('pointerdown', onPointer, true);
        this._recognitionGesture = null;
        return;
      }
      // desktop は死んだマイクのあとに認識を起こす。タップの先走りで getUserMedia より前に start しない。
      if (!this.transcriber.startBeforeRecorder && this.recorder.needsRecovery()) return;
      this.transcriber.continueListening();
    };
    this._recognitionGesture = onPointer;
    document.addEventListener('pointerdown', onPointer, true);
  }

  /**
   * 一時停止/再開を切り替え
   * @private
   */
  async _togglePause() {
    if (!this.isRecording) return;

    const pauseBtn = document.getElementById('pause-btn');
    const pausing = !this._userPaused && this.recorder.state !== 'paused';

    if (pausing) {
      if (!this.recorder.pause()) {
        this.recorder.state = 'paused';
        this.recorder.pauseStartTime = Date.now();
      }
      this._userPaused = true;
      this.transcriber.stop();
      this._stopTimer();
      this.ui.setRecordingStatus('paused');
      if (pauseBtn) pauseBtn.textContent = '▶️';
      if (this.visualizer) this.visualizer.startIdleAnimation();
      this._syncResumeReading();
      return;
    }

    this._userPaused = false;
    const ios = this.transcriber.startBeforeRecorder;
    // iOS は await より前、このタップの中で認識を付ける。
    if (ios) this.transcriber.continueListening();
    let stream = this.recorder.stream;
    if (!this.recorder.resume()) {
      try {
        stream = await this.recorder.ensureCapture();
      } catch (error) {
        console.warn('再開に失敗:', error);
        this._userPaused = true;
        this.recorder.state = 'paused';
        if (ios) this.transcriber.stop();
        this.ui.setRecordingStatus('paused');
        if (pauseBtn) pauseBtn.textContent = '▶️';
        this.ui.showToast('マイクを再開できませんでした。', 'error');
        this._syncResumeReading();
        return;
      }
    }

    if (!ios) this.transcriber.continueListening();
    this._startTimer();
    this.ui.setRecordingStatus('recording');
    if (pauseBtn) pauseBtn.textContent = '⏸️';
    if (this.visualizer && stream) {
      this.visualizer.stopIdleAnimation();
      await this.visualizer.connectStream(stream);
    }
    this._syncResumeReading();
  }

  /**
   * 読み取りが止まったあとに、残っているテキストを消さず認識を付け直す。
   * desktop は生きているストリームを使い、死んでいれば録音経路で取り直してから認識する。
   * iOS はタップの同期区間で continuous:false の認識を先に start する。
   * @private
   */
  async _resumeReading() {
    if (!this.isRecording || this._userPaused || this._stopPromise) return;
    const ios = this.transcriber.startBeforeRecorder;
    if (ios && (!this.transcriber.isEngineRunning() || this.recorder.needsRecovery())) {
      this.transcriber.continueListening();
    }

    let stream = this.recorder.stream;
    const captureDown = this.recorder.needsRecovery();
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

    if (!ios && (captureDown || !this.transcriber.isEngineRunning())) {
      this.transcriber.continueListening();
    }
    this._recoverAttempts = 0;
    this._syncResumeReading();
  }

  /**
   * 認識が落ちている、または録音トラックが切れているときだけ「再開」を出す。
   * @private
   */
  _syncResumeReading() {
    const btn = document.getElementById('resume-reading-btn');
    if (!btn || !this.transcriber) return;
    if (document.visibilityState === 'hidden') {
      btn.style.display = 'none';
      return;
    }
    const recognitionDown = this.transcriber.needsResume()
      || this.transcriber.isCaptionStalled();
    const show = !!(this.isRecording && !this._userPaused && recognitionDown);
    btn.style.display = show ? 'inline-flex' : 'none';
  }

  /**
   * 録音は動いているのに認識だけ付いていないとき、同じジェスチャ内で付け直す。
   * @private
   */
  _ensureLiveRecognition() {
    if (!this.isRecording || this._userPaused) return;
    if (this.transcriber.isEngineRunning() && !this.transcriber.isCaptionStalled()) return;
    if (this.transcriber.needsResume()) this.transcriber.continueListening();
  }

  /**
   * 音量メータが無くても、字幕だけ止まっているゾンボ認識を検知して付け直す。
   * @private
   */
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
    if (this.transcriber.isCaptionStalled()) {
      this.transcriber.reviveLiveCaption();
    }
    this._syncResumeReading();
  }

  /**
   * 録音ストリームの音量だけを見る。認識が落ちている隙間や、結果が来ない小さい声で付け直す。
   * SpeechRecognition 用に別の getUserMedia は開かない。
   * @private
   */
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
  }

  /**
   * @private
   */
  _stopSpeechWatch() {
    if (this._speechWatch) {
      clearInterval(this._speechWatch);
      this._speechWatch = null;
    }
    this._speechHotMs = 0;
    this._stallHotMs = 0;
  }

  /**
   * ビジュアライザが繋がらなくても字幕の死活を見る。
   * @private
   */
  _startCaptionWatch() {
    this._stopCaptionWatch();
    this._captionWatch = setInterval(() => this._checkCaptionHealth(), 1000);
  }

  /**
   * @private
   */
  _stopCaptionWatch() {
    if (this._captionWatch) {
      clearInterval(this._captionWatch);
      this._captionWatch = null;
    }
  }

  /**
   * @private
   */
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
  }

  /**
   * 録音タイマーを開始
   * @private
   */
  _startTimer() {
    this._stopTimer();
    const base = this._priorDuration || 0;
    this.timerInterval = setInterval(() => {
      const elapsed = base + (this.recorder.getElapsedTime() || 0);
      this.ui.updateTimer(elapsed);
    }, 200);
  }

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

  /**
   * 画面ロック / 復帰。Wake Lock は使わない。サイドボタンのロックは iOS がマイクを止める。
   * @private
   */
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
  }

  /**
   * @private
   */
  _onRecordingHidden() {
    if (!this.isRecording) return;
    this._backgrounded = true;
    this._syncViewportHeight();
    this.recorder.flush();
    if (!this._userPaused) this.transcriber.holdForBackground();
    this._checkpointRecording();
  }

  /**
   * @private
   */
  _scheduleForegroundWork() {
    if (this._recoverTimer) clearTimeout(this._recoverTimer);
    this._recoverTimer = setTimeout(() => {
      this._recoverTimer = null;
      this._onForeground();
    }, 80);
  }

  /**
   * @private
   */
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
  }

  /**
   * @private
   */
  async _recoverActiveRecording() {
    if (this._recovering) return;
    this._recovering = true;
    try {
      await this._recoverActiveRecordingBody();
    } finally {
      this._recovering = false;
    }
  }

  /**
   * @private
   */
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
  }

  /**
   * マイク復帰が失敗してもセッションは残し、間隔を空けて同じ録音を付け直す。
   * @private
   */
  _scheduleCaptureRetry() {
    if (this._recoverTimer) clearTimeout(this._recoverTimer);
    const wait = Math.min(8000, 700 * Math.max(1, this._recoverAttempts));
    this._recoverTimer = setTimeout(() => {
      this._recoverTimer = null;
      if (!this.isRecording || this._userPaused || document.visibilityState === 'hidden') return;
      this._recoverActiveRecording();
    }, wait);
  }

  /**
   * @returns {boolean}
   * @private
   */
  _isIOSDevice() {
    const ua = navigator.userAgent || '';
    if (/iPhone|iPod/i.test(ua)) return true;
    if (/iPad/i.test(ua)) return true;
    return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  }

  /**
   * 設定モーダル用。ビルド番号と現在の画面向きを表示する。
   */
  refreshDiagnostics() {
    const el = document.getElementById('app-build-info');
    const iosHint = document.getElementById('app-ios-rotation-hint');
    if (!el) return;
    const type = screen.orientation && screen.orientation.type
      ? screen.orientation.type
      : (window.innerWidth > window.innerHeight ? 'landscape' : 'portrait');
    const angle = screen.orientation && typeof screen.orientation.angle === 'number'
      ? `${screen.orientation.angle}°`
      : '';
    const mode = window.navigator.standalone === true
      || window.matchMedia('(display-mode: standalone)').matches
      ? 'ホーム画面'
      : 'Safari';
    el.textContent = `ビルド ${APP_BUILD} · ${mode} · 向き ${type}${angle ? ` (${angle})` : ''}`;

    if (!iosHint) return;
    if (!this._isIOSDevice()) {
      iosHint.style.display = 'none';
      iosHint.textContent = '';
      return;
    }
    iosHint.style.display = 'block';
    iosHint.innerHTML = [
      '<b>iPhone の画面の向き</b><br>',
      '・<b>上下反転（逆さの縦）</b>は iPhone の仕様でほとんどの機種が非対応です。アプリ側では有効にできません。<br>',
      '・<b>横画面</b>にする: コントロールセンター → 「画面の向きをロック」を OFF にしてから端末を横に。<br>',
      '・<b>ホーム画面</b>から起動している場合: アイコンを削除 → Safari で ',
      '<a href="https://yosie-lab.github.io/voice-scribe/" target="_blank" rel="noopener">yosie-lab.github.io/voice-scribe</a>',
      ' を開く → ⚙️ でビルド v77 を確認 → 共有 → ホーム画面に追加。',
      '<br>今朝のアップデートで向きがおかしくなった場合も、上と同じ手順で古いホーム画面アイコンを消してください。'
    ].join('');
  }

  /**
   * iOS Safari は回転後も 100dvh が古い値のままになることがある。実測高さで上書きする。
   * @private
   */
  _syncViewportHeight() {
    const h = window.visualViewport && window.visualViewport.height
      ? window.visualViewport.height
      : window.innerHeight;
    if (h > 0) {
      document.documentElement.style.setProperty('--app-height', `${Math.round(h)}px`);
    }
  }

  /**
   * 回転・リサイズのたびにレイアウト高さを実測に合わせる（向き固定 API は使わない）。
   * @private
   */
  _bindViewportSync() {
    const sync = () => {
      this._syncViewportHeight();
      this.refreshDiagnostics();
    };
    window.addEventListener('pageshow', sync);
    window.addEventListener('orientationchange', sync);
    window.addEventListener('resize', sync);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', sync);
    }
    if (screen.orientation && typeof screen.orientation.addEventListener === 'function') {
      screen.orientation.addEventListener('change', sync);
    }
  }

  /**
   * ロック復帰後にオーバーレイやヒットテストが残らないようにする。
   * @private
   */
  _unstickUi() {
    if (!this._whisperBusy && this.ui) this.ui.hideWhisperOverlay();
    const root = document.getElementById('app');
    if (!root) return;
    root.style.transform = 'translateZ(0)';
    requestAnimationFrame(() => {
      root.style.transform = '';
    });
  }

  /**
   * @private
   */
  _recoverPlaybackAfterForeground() {
    if (this.currentAudio && this.currentAudio.error) {
      this._stopPlayback();
    }
  }

  /**
   * テキストからタイトルを自動生成
   * @param {string} transcript
   * @param {string} language
   * @returns {string}
   * @private
   */
  _generateTitle(transcript, language) {
    if (!transcript || !transcript.trim()) {
      return language === 'en-US' ? 'Voice Memo' : '録音メモ';
    }

    const clean = transcript.replace(/[。、！？!?\n\r]/g, ' ').trim();
    const words = clean.split(/\s+/).filter(Boolean);

    if (words.length === 0) {
      return language === 'en-US' ? 'Voice Memo' : '録音メモ';
    }

    let title = words.slice(0, 5).join(' ');
    if (title.length > 25) {
      title = title.substring(0, 25) + '...';
    }
    return title;
  }

  // =====================================
  // 2. 一覧画面 (List View) 制御
  // =====================================

  /**
   * 一覧画面のイベントリスナーを設定
   * @private
   */
  _setupListView() {
    // 検索入力
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
      let debounceTimer = null;
      searchInput.addEventListener('input', (e) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          await this._searchRecordings(e.target.value);
        }, 250);
      });
    }

    // 録音カードのクリックイベント（委譲）
    const listContainer = document.getElementById('recordings-list');
    if (listContainer) {
      listContainer.addEventListener('click', (e) => {
        const deleteBtn = e.target.closest('.card-delete-btn, [data-action="delete"]');
        if (deleteBtn) {
          e.stopPropagation();
          e.preventDefault();
          const id = deleteBtn.dataset.id || deleteBtn.closest('.recording-card')?.dataset?.id;
          if (id) {
            this._confirmDelete(id);
          }
          return;
        }

        const card = e.target.closest('.recording-card');
        if (card && card.dataset.id) {
          this._openDetail(card.dataset.id);
        }
      });
    }
  }

  /**
   * 録音一覧を再読み込みして描画
   * @private
   */
  async _refreshRecordingsList() {
    try {
      const recordings = await this.storage.getAll();
      this.ui.renderRecordingsList(recordings);
    } catch (error) {
      console.error('録音一覧読み込みエラー:', error);
    }
  }

  /**
   * 録音を検索
   * @param {string} query
   * @private
   */
  async _searchRecordings(query) {
    try {
      const results = await this.storage.search(query);
      this.ui.renderRecordingsList(results);
    } catch (error) {
      console.error('検索エラー:', error);
    }
  }

  /**
   * 録音の削除を確認
   * @param {string} id
   * @private
   */
  _confirmDelete(id) {
    this.ui.showConfirmModal({
      icon: '🗑️',
      title: '録音を削除しますか？',
      description: 'この操作は取り消せません。音声データと文字起こしテキストが完全に削除されます。',
      confirmText: '削除する',
      onConfirm: async () => {
        try {
          await this.storage.delete(id);
          await this._refreshRecordingsList();
          this.ui.showToast('録音を削除しました', 'success');

          if (this.currentDetailId === id) {
            this.ui.switchView('list');
          }
        } catch (error) {
          console.error('削除エラー:', error);
          this.ui.showToast('削除中にエラーが発生しました。', 'error');
        }
      }
    });
  }

  // =====================================
  // 3. 詳細画面 (Detail View) 制御
  // =====================================

  /**
   * 詳細ビューのイベントリスナーを設定
   * @private
   */
  _setupDetailView() {
    // 戻るボタン
    const backBtn = document.getElementById('back-btn');
    if (backBtn) {
      backBtn.addEventListener('click', () => {
        this._stopPlayback();
        this.ui.switchView('list');
      });
    }

    // 再生ボタン
    const playBtn = document.getElementById('play-btn');
    if (playBtn) {
      playBtn.addEventListener('click', () => this._togglePlayback());
    }

    // 10秒スキップボタン
    const skipBackBtn = document.getElementById('skip-back-btn');
    const skipFwdBtn = document.getElementById('skip-fwd-btn');
    if (skipBackBtn) {
      skipBackBtn.addEventListener('click', () => this._skipPlayback(-10));
    }
    if (skipFwdBtn) {
      skipFwdBtn.addEventListener('click', () => this._skipPlayback(10));
    }

    // シークバー（プログレスバー）
    const progressBar = document.getElementById('player-progress');
    if (progressBar) {
      progressBar.addEventListener('click', (e) => this._seekPlayback(e));
    }

    // テキストコピーボタン
    const detailCopyBtn = document.getElementById('detail-copy-btn');
    if (detailCopyBtn) {
      detailCopyBtn.addEventListener('click', () => this._copyDetailText());
    }

    const detailObsidianBtn = document.getElementById('detail-obsidian-btn');
    if (detailObsidianBtn) {
      detailObsidianBtn.addEventListener('click', () => this._saveDetailToObsidian());
    }

    // Whisper再変換ボタン
    const detailWhisperBtn = document.getElementById('detail-whisper-btn');
    if (detailWhisperBtn) {
      detailWhisperBtn.addEventListener('click', () => this._requestWhisperDetailTranscribe());
    }

    // テキストダウンロードボタン
    const exportTextBtn = document.getElementById('export-text-btn');
    if (exportTextBtn) {
      exportTextBtn.addEventListener('click', () => this._exportText());
    }

    // 音声ダウンロードボタン
    const exportAudioBtn = document.getElementById('export-audio-btn');
    if (exportAudioBtn) {
      exportAudioBtn.addEventListener('click', () => this._exportAudio());
    }
  }

  /**
   * 詳細画面から手動でGroq Whisper文字起こしを実行
   * @private
   */
  async _requestWhisperDetailTranscribe() {
    if (!this.currentDetailId) return;

    if (!this.whisper.hasApiKey()) {
      this.ui.showToast('⚙️ 設定画面からGroq APIキーを登録してください', 'info', 4000);
      const settingsBtn = document.getElementById('header-settings-btn');
      if (settingsBtn) settingsBtn.click();
      return;
    }

    try {
      let recording = await this.storage.getById(this.currentDetailId);
      recording = await this._materializeAudio(recording);
      if (!recording || !recording.audioBlob) {
        this.ui.showToast('音声データが保存されていないため、Whisper変換を実行できません。', 'error');
        return;
      }

      this.ui.showWhisperOverlay();

      const whisperText = await this.whisper.transcribeAudio(recording.audioBlob, recording.language || 'ja-JP');

      if (whisperText && whisperText.trim()) {
        recording.transcript = whisperText.trim();
        recording.title = this._generateTitle(whisperText.trim(), recording.language || 'ja-JP');

        await this.storage.save(recording);
        await this._refreshRecordingsList();

        // 詳細画面を再描画
        this.ui.showDetail(recording);
        this.ui.showToast('⚡ Whisper文字起こしが完了しました！', 'success', 3000);
      }
    } catch (err) {
      console.error('詳細Whisper文字起こしエラー:', err);
      this.ui.showToast(`Whisperエラー: ${err.message}`, 'error', 5000);
    } finally {
      this.ui.hideWhisperOverlay();
    }
  }

  /**
   * 詳細ビューを開く
   * @param {string} id
   * @private
   */
  async _openDetail(id) {
    try {
      let recording = await this.storage.getById(id);
      if (!recording) {
        this.ui.showToast('録音データが見つかりません。', 'error');
        return;
      }
      recording = await this._materializeAudio(recording);

      this.currentDetailId = id;
      this._stopPlayback();

      // UI描画
      this.ui.showDetail(recording);

      // 静的波形の描画
      const waveformCanvas = document.getElementById('player-waveform-canvas');
      if (waveformCanvas && recording.audioBlob) {
        AudioVisualizer.drawStaticWaveform(recording.audioBlob, waveformCanvas);
      }

      // 再生時間表示のリセット
      const currentTimeEl = document.getElementById('player-current-time');
      const totalTimeEl = document.getElementById('player-total-time');
      const progressFill = document.getElementById('player-progress-fill');

      if (currentTimeEl) currentTimeEl.textContent = '00:00';
      if (totalTimeEl) totalTimeEl.textContent = UIManager.formatTime(recording.duration || 0);
      if (progressFill) progressFill.style.width = '0%';

      this.ui.switchView('detail');
    } catch (error) {
      console.error('詳細読み込みエラー:', error);
      this.ui.showToast('データの読み込みに失敗しました。', 'error');
    }
  }

  /**
   * 音声再生の開始/一時停止を切り替え
   * @private
   */
  async _togglePlayback() {
    if (this.currentAudio && !this.currentAudio.paused) {
      this._pausePlayback();
    } else {
      await this._startPlayback();
    }
  }

  /**
   * 音声再生を開始
   * @private
   */
  async _startPlayback() {
    if (!this.currentDetailId) return;

    try {
      let recording = await this.storage.getById(this.currentDetailId);
      recording = await this._materializeAudio(recording);
      if (!recording || !this._audioParts(recording).length) {
        this.ui.showToast('再生できる音声データがありません。', 'info');
        return;
      }

      if (!this.currentAudio) {
        if (this.currentAudioUrl) {
          URL.revokeObjectURL(this.currentAudioUrl);
        }
        this.currentAudioUrl = URL.createObjectURL(recording.audioBlob);
        this.currentAudio = new Audio(this.currentAudioUrl);

        this.currentAudio.onended = () => {
          this._stopPlayback();
        };

        this.currentAudio.onerror = (e) => {
          console.error('オーディオ再生エラー:', e);
          this.ui.showToast('音声の再生に失敗しました。', 'error');
          this._stopPlayback();
        };
      }

      await this.currentAudio.play();

      const playBtn = document.getElementById('play-btn');
      if (playBtn) playBtn.textContent = '⏸️';

      this._startPlaybackTracking();
    } catch (error) {
      console.error('再生開始エラー:', error);
      // ロック後に死んだ Audio 要素を残すと、次の再生も失敗し続ける。
      this._stopPlayback();
      this.ui.showToast('音声の再生を開始できませんでした。', 'error');
    }
  }

  /**
   * 音声再生を一時停止
   * @private
   */
  _pausePlayback() {
    if (this.currentAudio) {
      this.currentAudio.pause();
      const playBtn = document.getElementById('play-btn');
      if (playBtn) playBtn.textContent = '▶️';
      this._stopPlaybackTracking();
    }
  }

  /**
   * 音声再生を停止してリセット
   * @private
   */
  _stopPlayback() {
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio.currentTime = 0;
      this.currentAudio = null;
    }

    if (this.currentAudioUrl) {
      URL.revokeObjectURL(this.currentAudioUrl);
      this.currentAudioUrl = null;
    }

    this._stopPlaybackTracking();

    const playBtn = document.getElementById('play-btn');
    const currentTimeEl = document.getElementById('player-current-time');
    const progressFill = document.getElementById('player-progress-fill');

    if (playBtn) playBtn.textContent = '▶️';
    if (currentTimeEl) currentTimeEl.textContent = '00:00';
    if (progressFill) progressFill.style.width = '0%';
  }

  /**
   * 再生位置をスキップ（秒数指定）
   * @param {number} seconds
   * @private
   */
  _skipPlayback(seconds) {
    if (!this.currentAudio) return;
    const newTime = Math.max(0, Math.min(this.currentAudio.duration || 0, this.currentAudio.currentTime + seconds));
    this.currentAudio.currentTime = newTime;
    this._updatePlaybackUI();
  }

  /**
   * プログレスバークリックでシーク
   * @param {MouseEvent} event
   * @private
   */
  _seekPlayback(event) {
    if (!this.currentAudio || !this.currentAudio.duration) return;

    const progressBar = document.getElementById('player-progress');
    if (!progressBar) return;

    const rect = progressBar.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, clickX / rect.width));

    this.currentAudio.currentTime = ratio * this.currentAudio.duration;
    this._updatePlaybackUI();
  }

  /**
   * 再生トラッキングタイマーを開始
   * @private
   */
  _startPlaybackTracking() {
    this._stopPlaybackTracking();
    this.playbackInterval = setInterval(() => {
      this._updatePlaybackUI();
    }, 100);
  }

  /**
   * 再生トラッキングタイマーを停止
   * @private
   */
  _stopPlaybackTracking() {
    if (this.playbackInterval) {
      clearInterval(this.playbackInterval);
      this.playbackInterval = null;
    }
  }

  /**
   * 再生UI（時間・プログレスバー）を更新
   * @private
   */
  _updatePlaybackUI() {
    if (!this.currentAudio) return;

    const current = this.currentAudio.currentTime || 0;
    const duration = this.currentAudio.duration || 0;

    const currentTimeEl = document.getElementById('player-current-time');
    const totalTimeEl = document.getElementById('player-total-time');
    const progressFill = document.getElementById('player-progress-fill');

    if (currentTimeEl) currentTimeEl.textContent = UIManager.formatTime(current);
    if (totalTimeEl && duration > 0) totalTimeEl.textContent = UIManager.formatTime(duration);

    if (progressFill && duration > 0) {
      const percentage = (current / duration) * 100;
      progressFill.style.width = `${percentage}%`;
    }
  }

  /**
   * 録音画面の文字起こしを Obsidian Inbox へ保存
   * @private
   */
  async _saveLiveToObsidian() {
    const textEl = document.getElementById('transcript-text');
    const transcript = textEl ? (textEl.innerText || textEl.textContent || '').trim() : '';
    if (!transcript) {
      this.ui.showToast('保存する文字起こしがありません', 'info');
      return;
    }

    const activeLangBtn = document.querySelector('.lang-btn.active');
    const language = activeLangBtn ? activeLangBtn.dataset.lang : 'ja-JP';
    await this._sendToObsidian({
      title: this._generateTitle(transcript, language),
      transcript,
      language
    });
  }

  /**
   * 詳細画面の文字起こしを Obsidian Inbox へ保存
   * @private
   */
  async _saveDetailToObsidian() {
    if (!this.currentDetailId) return;

    try {
      const recording = await this.storage.getById(this.currentDetailId);
      const transcript = (recording && recording.transcript ? recording.transcript : '').trim();
      if (!recording || !transcript) {
        this.ui.showToast('保存する文字起こしがありません', 'info');
        return;
      }

      await this._sendToObsidian({
        title: recording.title || 'Voice note',
        transcript,
        language: recording.language || 'ja-JP',
        createdAt: recording.createdAt
      });
    } catch (error) {
      console.error('Obsidian保存エラー:', error);
      this.ui.showToast('Obsidianへの保存に失敗しました', 'error');
    }
  }

  /**
   * @param {{ title: string, transcript: string, language: string, createdAt?: number }} note
   * @private
   */
  async _sendToObsidian(note) {
    if (!window.ObsidianInbox) {
      this.ui.showToast('Obsidian保存を読み込めませんでした', 'error');
      return;
    }

    try {
      const result = await ObsidianInbox.save(note);
      this.ui.showToast(result.message, result.ok ? 'success' : 'info', 4000);
    } catch (error) {
      console.error('Obsidian保存エラー:', error);
      this.ui.showToast('Obsidianへの保存に失敗しました', 'error');
    }
  }

  /**
   * 詳細画面のテキストをコピー
   * @private
   */
  async _copyDetailText() {
    const textEl = document.getElementById('detail-transcript-text');
    const text = textEl ? (textEl.innerText || textEl.textContent || '').trim() : '';

    if (!text || text === 'テキストなし') {
      this.ui.showToast('コピーするテキストがありません。', 'info');
      return;
    }

    const success = await UIManager.copyToClipboard(text);
    if (success) {
      this.ui.showToast('📋 テキストをコピーしました', 'success');
    } else {
      this.ui.showToast('コピーに失敗しました。', 'error');
    }
  }

  /**
   * テキストファイルとしてエクスポート
   * @private
   */
  async _exportText() {
    if (!this.currentDetailId) return;

    try {
      const recording = await this.storage.getById(this.currentDetailId);
      if (!recording || !recording.transcript) {
        this.ui.showToast('エクスポートするテキストがありません。', 'info');
        return;
      }

      const dateStr = UIManager.formatDate(recording.createdAt);
      const content = `タイトル: ${recording.title || '録音メモ'}\n録音日時: ${dateStr}\n録音時間: ${UIManager.formatTime(recording.duration || 0)}\n\n--- 文字起こし ---\n\n${recording.transcript}`;

      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${recording.title || '録音'}_文字起こし.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      this.ui.showToast('📄 テキストをダウンロードしました', 'success');
    } catch (error) {
      console.error('テキストエクスポートエラー:', error);
      this.ui.showToast('ダウンロードに失敗しました。', 'error');
    }
  }

  /**
   * 音声ファイルとしてエクスポート
   * @private
   */
  async _exportAudio() {
    if (!this.currentDetailId) return;

    try {
      let recording = await this.storage.getById(this.currentDetailId);
      recording = await this._materializeAudio(recording);
      if (!recording || !recording.audioBlob) {
        this.ui.showToast('エクスポートする音声データがありません。', 'info');
        return;
      }

      let ext = 'mp4';
      const mime = recording.mimeType || '';
      if (mime.includes('webm')) ext = 'webm';
      else if (mime.includes('wav')) ext = 'wav';
      else if (mime.includes('ogg')) ext = 'ogg';
      const url = URL.createObjectURL(recording.audioBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${recording.title || '録音'}_音声.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      this.ui.showToast('🎵 音声をダウンロードしました', 'success');
    } catch (error) {
      console.error('音声エクスポートエラー:', error);
      this.ui.showToast('ダウンロードに失敗しました。', 'error');
    }
  }
}

// =====================================
// アプリケーション起動
// =====================================
document.addEventListener('DOMContentLoaded', async () => {
  const app = new VoiceScribeApp();
  await app.init();

  // Service Worker登録と自動更新
  if ('serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.register('./sw.js?v=77');
      console.log('Service Worker 登録完了:', registration.scope);
      if (registration.update) {
        registration.update();
      }
    } catch (error) {
      console.warn('Service Worker 登録失敗:', error);
    }
  }
});
