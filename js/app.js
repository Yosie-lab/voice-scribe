/**
 * VoiceScribe — メインアプリケーションコントローラー (VoiceScribeApp)
 * 各モジュール（Storage, Recorder, Transcriber, Whisper, Visualizer, UI）を統合管理
 */

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
    this._wakeLock = null;
    this._wakeLockRequest = null;
    this._backgrounded = false;
    this._recoverTimer = null;
    this._recoverGen = 0;
    this._recoverAttempts = 0;
    this._recovering = false;
    this._whisperBusy = false;
    this._stopPromise = null;
    this._speechWatch = null;
    this._speechFloor = 0.012;
    this._speechHotMs = 0;

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
      this._setupListView();
      this._setupDetailView();

      // 音声認識対応状況の確認
      this._checkTranscriptionSupport();

      // 録音一覧の初回読み込み
      await this._refreshRecordingsList();

      console.log('VoiceScribe 初期化完了');
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

    // クリアボタン
    const clearBtn = document.getElementById('clear-transcript-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (this.isRecording) return;
        this.ui.updateTranscript('', '', false);
        this.transcriber.reset();
      });
    }

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
      if (document.visibilityState === 'hidden') {
        this._backgrounded = true;
        return;
      }
      this._scheduleForegroundWork();
    };
    this.transcriber.onError = (message) => {
      this.ui.showToast(message, 'error');
    };
  }

  /**
   * 録音の開始/停止を切り替え
   * @private
   */
  async _toggleRecording() {
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
  async _startRecording() {
    this.isRecording = true;
    this._userPaused = false;
    this._recoverAttempts = 0;
    this.currentRecordingId = StorageManager.generateId();
    this.ui.setRecordingStatus('recording');
    this._acquireWakeLock();
    this._startTimer();
    this.ui.updateTranscript('', '', true);

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
      try {
        this.transcriber.start();
      } catch (e) {
        console.warn('SpeechRecognition start warning:', e);
      }
    }

    try {
      const stream = await this.recorder.start();
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
      try {
        this.transcriber.start();
      } catch (e) {
        console.warn('SpeechRecognition start warning:', e);
      }
    }

    if (!this.isRecording) return;
    this._startSpeechWatch();

    // 言語ボタンを一時無効化
    document.querySelectorAll('.lang-btn').forEach((btn) => {
      btn.style.pointerEvents = 'none';
      btn.style.opacity = '0.5';
    });

    this.ui.showToast('🎙️ 録音中（お話しください）', 'success', 2000);
  }

  /**
   * 録音を停止して保存（Groq Whisper連携付き）
   * @private
   */
  async _stopRecording() {
    if (this._stopPromise) return this._stopPromise;
    this._stopPromise = this._stopRecordingBody().finally(() => {
      this._stopPromise = null;
    });
    return this._stopPromise;
  }

  /**
   * 録音を停止して保存（Groq Whisper連携付き）
   * 途中で失敗しても、Clear / 再生が触れる待機状態に戻す。
   * @private
   */
  async _stopRecordingBody() {
    this._stopSpeechWatch();
    this._recoverGen++;
    if (this._recoverTimer) {
      clearTimeout(this._recoverTimer);
      this._recoverTimer = null;
    }

    let transcript = (this.transcriber.getFullTranscript() || '').trim();
    if (!transcript) {
      const textEl = document.getElementById('transcript-text');
      if (textEl) {
        transcript = (textEl.innerText || textEl.textContent || '').trim();
      }
    }

    this.transcriber.stop();

    let audioBlob = null;
    let audioMime = 'audio/mp4';
    let duration = this.recorder.getElapsedTime() || 0;
    try {
      const recResult = await this.recorder.stop();
      if (recResult) {
        audioBlob = recResult.blob;
        audioMime = recResult.mimeType || 'audio/mp4';
        if (typeof recResult.duration === 'number') duration = recResult.duration;
      }
    } catch (e) {
      console.warn('Recorder stop warning:', e);
    }

    this._finishRecordingUi(transcript);

    try {
      const activeLangBtn = document.querySelector('.lang-btn.active');
      const language = activeLangBtn ? activeLangBtn.dataset.lang : 'ja-JP';

      if (transcript || audioBlob) {
        let finalTranscript = transcript;

        if (this.whisper.hasApiKey() && audioBlob) {
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

        const recording = {
          id: this.currentRecordingId,
          title: this._generateTitle(finalTranscript, language),
          audioBlob: audioBlob,
          mimeType: audioMime,
          transcript: finalTranscript,
          language: language,
          duration: duration,
          createdAt: Date.now()
        };

        await this.storage.save(recording);
        await this._refreshRecordingsList();
        this.ui.showToast('✅ 録音と文字起こしを保存しました', 'success');
        this.ui.updateTranscript(finalTranscript, '', false);
      }

      this.ui.updateTimer(0);
    } catch (error) {
      console.error('録音停止エラー:', error);
      this._finishRecordingUi(transcript);
      this._whisperBusy = false;
      if (this.ui.hideWhisperOverlay) this.ui.hideWhisperOverlay();
    }
  }

  /**
   * 録音フラグと操作ボタンを待機状態へ戻す。
   * @param {string} [transcript]
   * @private
   */
  _finishRecordingUi(transcript) {
    this.isRecording = false;
    this._userPaused = false;
    this._backgrounded = false;
    this._stopSpeechWatch();
    this._releaseWakeLock();
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
    if (typeof transcript === 'string') {
      this.ui.updateTranscript(transcript, '', false);
    }
    if (this._recognitionGesture) {
      document.removeEventListener('pointerdown', this._recognitionGesture, true);
      this._recognitionGesture = null;
    }
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
      if (target && target.closest && target.closest('#record-btn, #pause-btn, #clear-transcript-btn')) return;
      if (this.transcriber.isEngineRunning()) {
        document.removeEventListener('pointerdown', onPointer, true);
        this._recognitionGesture = null;
        return;
      }
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
      return;
    }

    this._userPaused = false;
    let stream = this.recorder.stream;
    if (!this.recorder.resume()) {
      try {
        stream = await this.recorder.ensureCapture();
      } catch (error) {
        console.warn('再開に失敗:', error);
        this._userPaused = true;
        this.recorder.state = 'paused';
        this.ui.setRecordingStatus('paused');
        if (pauseBtn) pauseBtn.textContent = '▶️';
        this.ui.showToast('マイクを再開できませんでした。', 'error');
        return;
      }
    }

    this.transcriber.continueListening();
    this._startTimer();
    this.ui.setRecordingStatus('recording');
    if (pauseBtn) pauseBtn.textContent = '⏸️';
    if (this.visualizer && stream) {
      this.visualizer.stopIdleAnimation();
      await this.visualizer.connectStream(stream);
    }
  }

  /**
   * 録音ストリームの音量だけを見る。認識が落ちている隙間や、結果が来ない小さい声で付け直す。
   * SpeechRecognition 用に別の getUserMedia は開かない。
   * @private
   */
  _startSpeechWatch() {
    this._stopSpeechWatch();
    this._speechFloor = 0.012;
    this._speechHotMs = 0;
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
  }

  /**
   * @private
   */
  _pollSpeechLevel() {
    if (!this.isRecording || this._userPaused || document.visibilityState === 'hidden') {
      this._speechHotMs = 0;
      return;
    }
    if (!this.visualizer || typeof this.visualizer.getSpeechLevel !== 'function') return;
    const level = this.visualizer.getSpeechLevel();
    if (level == null || Number.isNaN(level)) return;

    const speaking = level > Math.max(0.018, this._speechFloor * 3.2);
    if (!speaking) {
      this._speechFloor = this._speechFloor * 0.96 + level * 0.04;
      this._speechHotMs = 0;
      return;
    }

    this._speechHotMs += 200;
    if (this._speechHotMs < 600) return;

    if (!this.transcriber.isEngineRunning()) {
      this.transcriber.nudge('gap');
      this._speechHotMs = 0;
      return;
    }
    // 走り始めの発話は切らない。2秒以上、結果も speechstart も無いときだけ付け直す。
    if (this._speechHotMs >= 2000 && this.transcriber.msSinceResult() >= 2500) {
      this.transcriber.nudge('stall');
      this._speechHotMs = 0;
    }
  }

  /**
   * 録音タイマーを開始
   * @private
   */
  _startTimer() {
    this._stopTimer();
    this.timerInterval = setInterval(() => {
      const elapsed = this.recorder.getElapsedTime();
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
   * 画面ロック / 復帰。Wake Lock は自動スリープを止めるだけで、
   * サイドボタンのロックは iOS がマイクを止める。復帰で同じセッションを付け直す。
   * @private
   */
  _bindRecordingLifecycle() {
    const onHide = () => this._onRecordingHidden();
    const onShow = () => this._scheduleForegroundWork();
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
    this.recorder.flush();
    if (!this._userPaused) this.transcriber.holdForBackground();
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
    if (!this.isRecording) return;
    await this._acquireWakeLock();
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
    if (!wasBackground && !captureDown && this.transcriber.isEngineRunning()) {
      this._recoverAttempts = 0;
      this._startTimer();
      this.ui.setRecordingStatus('recording');
      return;
    }

    this.ui.setRecordingStatus('recording');
    this._startTimer();

    if (captureDown) {
      this._recoverAttempts++;
      if (this._recoverAttempts > 3) {
        this.ui.showToast('画面ロック後にマイクへ復帰できませんでした。ここまでの録音を保存します。', 'info', 4000);
        await this._stopRecording();
        return;
      }
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
        this.ui.showToast('画面ロック後にマイクへ復帰できませんでした。ここまでの録音を保存します。', 'info', 4000);
        await this._stopRecording();
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
    this.transcriber.resumeAfterBackground();
    this.ui.setRecordingStatus('recording');
    this._armRecognitionGesture();
  }

  /**
   * 録音中だけ画面の自動ロックを止める。未対応・拒否でも録音は続ける。
   * @private
   */
  async _acquireWakeLock() {
    if (!this.isRecording) return;
    if (document.visibilityState === 'hidden') return;
    if (!navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') return;
    if (this._wakeLock && this._wakeLock.released) this._wakeLock = null;
    if (this._wakeLock || this._wakeLockRequest) return;
    try {
      this._wakeLockRequest = navigator.wakeLock.request('screen');
      const lock = await this._wakeLockRequest;
      this._wakeLockRequest = null;
      if (!this.isRecording || document.visibilityState === 'hidden') {
        try { await lock.release(); } catch { /* 無視 */ }
        return;
      }
      this._wakeLock = lock;
      lock.addEventListener('release', () => {
        if (this._wakeLock === lock) this._wakeLock = null;
      });
    } catch (error) {
      this._wakeLockRequest = null;
      this._wakeLock = null;
      console.warn('Wake Lock を取得できませんでした:', error);
    }
  }

  /**
   * @private
   */
  _releaseWakeLock() {
    const lock = this._wakeLock;
    this._wakeLock = null;
    this._wakeLockRequest = null;
    if (!lock) return;
    lock.release().catch(() => {});
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
      const recording = await this.storage.getById(this.currentDetailId);
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
      const recording = await this.storage.getById(id);
      if (!recording) {
        this.ui.showToast('録音データが見つかりません。', 'error');
        return;
      }

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
      const recording = await this.storage.getById(this.currentDetailId);
      if (!recording || !recording.audioBlob) {
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
      const recording = await this.storage.getById(this.currentDetailId);
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
      const registration = await navigator.serviceWorker.register('./sw.js');
      console.log('Service Worker 登録完了:', registration.scope);
      if (registration.update) {
        registration.update();
      }
    } catch (error) {
      console.warn('Service Worker 登録失敗:', error);
    }
  }
});
