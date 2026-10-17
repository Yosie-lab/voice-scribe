/**
 * VoiceScribe — 録音中のライブ字幕・認識復旧・音量監視（VoiceScribeApp mixin）
 */
const VoiceScribeRecordingHealth = {
  /**
   * ライブ字幕の onResult を配線する。
   * @private
   */
  _bindLiveTranscriptCallback() {
    this.transcriber.onResult = (finalText, interimText) => {
      this.ui.updateTranscript(finalText, interimText, true);
      this._syncResumeReading();
    };
  }
,

  /**
   * 続き録音の接頭辞をメモリ上の下書きから先に組み立てる（await 前）。
   * @private
   */
  _armContinueDraftPrefixFromMemory() {
    if (!this._draftId) return;
    const base = this._longerText(this._draftTranscript, '');
    this._resumeBase = base;
    this._resumePrefix = base ? `${base}\n\n— 続き ${this._resumeStamp()} —\n` : '';
  }
,

  /**
   * マイク取得直後（await 最小）にライブ STT を付ける。
   * @private
   */
  _bootstrapLiveTranscriptionAfterMic() {
    if (!this.isRecording || this._userPaused) return;
    const ios = this._isIOSDevice();
    if (!this.transcriber.startBeforeRecorder) {
      this._kickLiveRecognitionAtRecordStart();
    }
    if (this._resumePrefix) this._primeContinuedTranscript();
    if (ios) {
      // ジェスチャ内 kick 直後の無条件 reattach は post-await start を失敗させ「字幕なし」になりやすい。
      if (!this.transcriber.isEngineRunning() || this.transcriber.isZombieEngine()) {
        this.transcriber.reattachAfterSharedMic({ micContended: true });
      }
      if (!this.transcriber.isEngineRunning()) {
        this.transcriber.manualResumeListening(false);
      }
      this._scheduleIosPostMicWarmup();
    } else {
      this.transcriber.reattachAfterSharedMic({ micContended: true });
    }
  }
,

  /**
   * iOS: 録音ボタン pointerdown で await より先に認識を付ける（click だけだと遅れやすい）。
   * @private
   */
  _gestureKickRecognition() {
    if (!this.transcriber.startBeforeRecorder) return;
    if (this.isRecording || this._starting || this._stopPromise) return;
    this._bindLiveTranscriptCallback();
    this.transcriber.setLanguage(this._activeLanguage());
    if (this.transcriber.isEngineRunning()) return;
    try {
      if (this.transcriber.isListening) {
        this.transcriber.manualResumeListening(false);
      } else {
        this.transcriber.start();
      }
    } catch (error) {
      console.warn('SpeechRecognition gesture kick:', error);
    }
  }
,

  /**
   * マイク取得後、まだ字幕が無い iOS だけ短く待ってから付け直す。
   * @private
   */
  _scheduleIosPostMicWarmup() {
    if (this._iosSttWarmupTimer) clearTimeout(this._iosSttWarmupTimer);
    this._iosSttWarmupTimer = setTimeout(() => {
      this._iosSttWarmupTimer = null;
      if (!this.isRecording || this._userPaused) return;
      const t = this.transcriber;
      const live = (t.getFullTranscript() || '').trim();
      if (live && !t.isZombieEngine()) return;
      if (!t.isEngineRunning() || t.isZombieEngine()) {
        t.reattachAfterSharedMic({ micContended: true });
      }
      this._ensureLiveRecognition();
      this._syncResumeReading();
    }, 550);
  }
,

  /**
   * @private
   */
  _stopIosSttWarmup() {
    if (this._iosSttWarmupTimer) {
      clearTimeout(this._iosSttWarmupTimer);
      this._iosSttWarmupTimer = null;
    }
  }
,

  /**
   * 録音開始時に認識を付ける（ジェスチャ先走り後の二重 start を避ける）。
   * @private
   */
  _kickLiveRecognitionAtRecordStart() {
    let started = false;
    try {
      if (this.transcriber.isEngineRunning()) {
        started = true;
      } else if (this.transcriber.isListening) {
        started = this.transcriber.manualResumeListening(false);
      } else {
        started = this.transcriber.start() !== false;
      }
    } catch (error) {
      console.warn('SpeechRecognition start warning:', error);
    }
    if (!started) {
      this.transcriber.armResume();
      this.transcriber.continueListening();
    }
    this._primeContinuedTranscript();
    return started;
  }
,

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
,

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
,

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
,

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
,

  /**
   * @returns {string}
   * @private
   */
  _activeLanguage() {
    const activeLangBtn = document.querySelector('.lang-btn.active');
    return activeLangBtn ? activeLangBtn.dataset.lang : 'ja-JP';
  }
,

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
,

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
,

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
,

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
,

  /**
   * @returns {Promise<void>}
   * @private
   */
  async _awaitCheckpointIdle() {
    for (let i = 0; i < 40 && this._checkpointing; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
,

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
,

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
,

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
,

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
,

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
,

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
,

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
,

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
,

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
,

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
,

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
      if (target && target.closest && target.closest('#record-btn, #pause-btn, #clear-transcript-btn, #continue-recording-btn, #draft-play-btn, #resume-reading-btn, #resume-reading-header-btn')) return;
      if (this.transcriber.isEngineRunning()) {
        document.removeEventListener('pointerdown', onPointer, true);
        this._recognitionGesture = null;
        return;
      }
      // desktop は死んだマイクのあとに認識を起こす。タップの先走りで getUserMedia より前に start しない。
      if (!this._isIOSDevice() && this.recorder.needsRecovery()) return;
      this.transcriber.continueListening();
    };
    this._recognitionGesture = onPointer;
    document.addEventListener('pointerdown', onPointer, true);
  }
,

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
    const ios = this._isIOSDevice();
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
,

  /**
   * 読み取りが止まったあとに、残っているテキストを消さず認識を付け直す。
   * desktop は生きているストリームを使い、死んでいれば録音経路で取り直してから認識する。
   * iOS はタップの同期区間で continuous:false の認識を先に start する。
   * @private
   */
  async _resumeReading() {
    if (!this.isRecording || this._userPaused || this._stopPromise) return;
    const ios = this._isIOSDevice();
    const captureDown = this.recorder.needsRecovery();

    const kicked = this.transcriber.manualResumeListening(true);
    this.transcriber.reattachAfterSharedMic({ micContended: true });
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
        this._reattachLiveSttAfterMic();
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

    this._reattachLiveSttAfterMic();
    this._syncResumeReading();
  }
,

  /**
   * 録音ストリーム取得後、落ちた／ゾンビの認識を付け直す。
   * @private
   */
  _reattachLiveSttAfterMic() {
    if (!this.isRecording || this._userPaused) return;
    if (this.transcriber.inIosPhraseGap && this.transcriber.inIosPhraseGap()) return;
    if (!this.recorder || this.recorder.state !== 'recording') return;
    const now = Date.now();
    if (now - this._lastMicReattachAt < 400) return;
    this._lastMicReattachAt = now;
    if (!this.transcriber.isEngineRunning() || this.transcriber.isZombieEngine()) {
      this.transcriber.reattachAfterSharedMic({ micContended: true });
    }
    if ((!this.transcriber.isEngineRunning() || this.transcriber.isZombieEngine()) && this._isIOSDevice()) {
      this.transcriber.manualResumeListening(false);
    }
  }
,

  /**
   * 再開タップ後しばらく、認識が落ちたら自動で付け直す（iOS の遅れ対策）。
   * @private
   */
  _armResumeBoost() {
    if (this._resumeBoostTimer) clearInterval(this._resumeBoostTimer);
    let ticks = 0;
    const tick = () => {
      ticks++;
      if (!this.isRecording || this._userPaused || ticks > 20) {
        clearInterval(this._resumeBoostTimer);
        this._resumeBoostTimer = null;
        return;
      }
      if (!this.transcriber.inUserResumeGrace()) return;
      if (this.transcriber.isEngineRunning() && !this.transcriber.isZombieEngine()) return;
      if (this.transcriber.awaitingStartAck() && !this.transcriber.isZombieEngine()) return;
      this.transcriber.reattachAfterSharedMic({ micContended: true });
      if (!this.transcriber.isEngineRunning()) {
        this.transcriber.manualResumeListening(false);
      }
      this._syncResumeReading();
    };
    this._resumeBoostTimer = setInterval(tick, 400);
  }
,

  /**
   * 認識が落ちている、または録音トラックが切れているときだけ「再開」を出す。
   * @private
   */
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
  }
,

  /**
   * 録音は動いているのに認識だけ付いていないとき、同じジェスチャ内で付け直す。
   * @private
   */
  _ensureLiveRecognition() {
    if (!this.isRecording || this._userPaused) return;
    if (this.transcriber.inUserResumeGrace()) {
      if (this.transcriber.isZombieEngine() || this.transcriber.isCaptionStalled()) {
        this._reattachLiveSttAfterMic();
      } else if (this.transcriber.awaitingStartAck() || this.transcriber.isEngineRunning()) {
        return;
      }
    }
    if (this.recorder && this.recorder.state === 'recording') {
      const live = this.transcriber.isEngineRunning();
      const interim = (this.transcriber.interimTranscript || '').trim();
      const stale = this.transcriber.msSinceResult() > 2500;
      if (!live || (stale && !interim)) {
        this._reattachLiveSttAfterMic();
        return;
      }
    }
    if (this.transcriber.awaitingStartAck()) return;
    if (this.transcriber.isEngineRunning() && !this.transcriber.isCaptionStalled()) return;
    if (this.transcriber.needsResume()) this.transcriber.continueListening();
  }
,

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
    this._syncResumeReading();
    if (this.transcriber._resumeNeeded) return;
    if (this.transcriber.inUserResumeGrace()) {
      if (this.transcriber.isZombieEngine() || this.transcriber.isCaptionStalled()) {
        this.transcriber.reattachAfterSharedMic({ micContended: true });
      }
      this._syncResumeReading();
      return;
    }
    if (this.recorder && this.recorder.state === 'recording' && !this.transcriber.isEngineRunning()
      && !this.transcriber.inUserResumeGrace() && !this.transcriber.awaitingStartAck()) {
      this._reattachLiveSttAfterMic();
    }
    if (this.transcriber.isCaptionStalled()) {
      this.transcriber.reviveLiveCaption();
      this._syncResumeReading();
    }
  }
,

  /**
   * 録音ストリームの音量だけを見る。認識が落ちている隙間や、結果が来ない小さい声で付け直す。
   * SpeechRecognition 用に別の getUserMedia は開かない。
   * @private
   */
  _startSpeechWatch() {
    this._stopSpeechWatch();
    this._speechProfile = Transcriber.speechWatchProfile(
      this.transcriber.language,
      this._isIOSDevice()
    );
    this._speechFloor = this._speechProfile.floor;
    this._stallFloor = this._speechProfile.stallFloor ?? this._speechProfile.floor;
    this._speechHotMs = 0;
    this._stallHotMs = 0;
    this._speechWatch = setInterval(() => this._pollSpeechLevel(), 200);
  }
,

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
,

  /**
   * ビジュアライザが繋がらなくても字幕の死活を見る。
   * @private
   */
  _startCaptionWatch() {
    this._stopCaptionWatch();
    const ms = this._isIOSDevice() ? 800 : 1000;
    this._captionWatch = setInterval(() => this._checkCaptionHealth(), ms);
  }
,

  /**
   * @private
   */
  _stopCaptionWatch() {
    if (this._captionWatch) {
      clearInterval(this._captionWatch);
      this._captionWatch = null;
    }
  }
,

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

    if (this.transcriber.isZombieEngine()) {
      if (!this.transcriber.inIosPhraseGap()) {
        this.transcriber.reattachAfterSharedMic({ micContended: true });
      }
      this._speechHotMs = 0;
      this._stallHotMs = 0;
      return;
    }
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

};

if (typeof window !== 'undefined') window.VoiceScribeRecordingHealth = VoiceScribeRecordingHealth;
if (typeof module !== 'undefined' && module.exports) module.exports = VoiceScribeRecordingHealth;
