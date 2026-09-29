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
    this._endingSession = null;
    this._userPaused = false;
    this._captureInterrupted = false;
    this._muteGraceTimer = null;
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
      this._setupListView();
      this._setupDetailView();
      this._installLifecycleGuards();

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
        if (this.isRecording) {
          if (!this.recorder.isCaptureAlive()) {
            this._endRecordingSession({ interrupted: true });
          }
          return;
        }
        this._transcriptEpoch++;
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
    this.recorder.onCaptureLost = () => {
      if (!this.isRecording) return;
      this._endRecordingSession({ interrupted: true });
    };
    this.recorder.onCaptureResumed = () => {
      this._resumeLiveCapture();
    };
    this.recorder.onCaptureMuted = () => {
      if (!this.isRecording) return;
      this._captureInterrupted = true;
      this.transcriber.hold();
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
    if (this._endingSession) {
      await this._endingSession;
      return;
    }
    if (this.isRecording) {
      await this._endRecordingSession({ interrupted: false });
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
    this._captureInterrupted = false;
    this._clearMuteGrace();
    // Screen Wake Lock は使わない。iOS の割り込みは audioSession の state で受ける。
    this._setAudioSessionType('play-and-record');
    this.currentRecordingId = StorageManager.generateId();
    this.ui.setRecordingStatus('recording');
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
        this._setAudioSessionType('auto');
        return;
      }
      if (this.visualizer && stream) {
        this.visualizer.stopIdleAnimation();
        await this.visualizer.connectStream(stream);
      }
    } catch (recErr) {
      console.warn('MediaRecorder start warning:', recErr);
    }

    if (!this.isRecording) {
      this._setAudioSessionType('auto');
      return;
    }

    if (!recognitionFirst) {
      try {
        this.transcriber.start();
      } catch (e) {
        console.warn('SpeechRecognition start warning:', e);
      }
    }

    this._setLanguageButtonsEnabled(false);

    this.ui.showToast('🎙️ 録音中（お話しください）', 'success', 2000);
  }

  /**
   * 録音を停止して保存する。画面ロック等の割り込みもここへ寄せ、UI を必ず待機状態に戻す。
   * @param {{ interrupted?: boolean }} [options]
   * @returns {Promise<void>}
   * @private
   */
  _endRecordingSession(options) {
    if (this._endingSession) return this._endingSession;
    const interrupted = !!(options && options.interrupted);
    this._endingSession = this._endRecordingSessionBody(interrupted)
      .catch((error) => {
        console.error('録音終了エラー:', error);
        this.isRecording = false;
        if (this.ui) this.ui.showToast('録音の終了処理に失敗しました', 'error');
        this._userPaused = false;
        this._captureInterrupted = false;
        this._clearMuteGrace();
        this._stopTimer();
        this.transcriber.stop();
        this._setLanguageButtonsEnabled(true);
        this._setAudioSessionType('auto');
        if (this.ui) {
          this.ui.setRecordingStatus('standby');
          if (this.ui.hideWhisperOverlay) this.ui.hideWhisperOverlay();
        }
      })
      .finally(() => {
        this._endingSession = null;
      });
    return this._endingSession;
  }

  /**
   * @param {boolean} interrupted
   * @private
   */
  async _endRecordingSessionBody(interrupted) {
    this._clearMuteGrace();
    this._userPaused = false;
    this._captureInterrupted = false;

    let transcript = (this.transcriber.getFullTranscript() || '').trim();
    if (!transcript) {
      const textEl = document.getElementById('transcript-text');
      if (textEl) {
        transcript = (textEl.innerText || textEl.textContent || '').trim();
      }
    }

    const activeLangBtn = document.querySelector('.lang-btn.active');
    const language = activeLangBtn ? activeLangBtn.dataset.lang : 'ja-JP';
    const duration = this.recorder.getElapsedTime() || 0;

    this.transcriber.stop();
    // Stop / Whisper を待つ前に操作を戻す。ロック後の Clear・再生がここで死んでいた。
    this.isRecording = false;
    this._stopTimer();
    this._setLanguageButtonsEnabled(true);
    this.ui.setRecordingStatus('standby');
    this.ui.updateTranscript(transcript, '', false);

    let audioBlob = null;
    let audioMime = 'audio/mp4';
    try {
      const recResult = await this.recorder.stop();
      if (recResult) {
        audioBlob = recResult.blob;
        audioMime = recResult.mimeType || 'audio/mp4';
      }
    } catch (e) {
      console.warn('Recorder stop warning:', e);
    }

    if (this.visualizer) {
      try {
        this.visualizer.disconnect();
        this.visualizer.startIdleAnimation();
      } catch (e) {
        console.warn('Visualizer disconnect warning:', e);
      }
    }

    this._setAudioSessionType('auto');

    const epoch = this._transcriptEpoch;
    if (transcript || audioBlob) {
      let finalTranscript = transcript;

      // 割り込み時は Whisper オーバーレイで操作を塞がない。詳細画面から再変換できる。
      if (!interrupted && this.whisper.hasApiKey() && audioBlob) {
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

      if (interrupted) {
        this.ui.showToast('録音が中断されました。ここまでを保存しました。一覧から再生できます。', 'info', 4000);
      } else {
        this.ui.showToast('✅ 録音と文字起こしを保存しました', 'success');
      }

      if (epoch === this._transcriptEpoch) {
        this.ui.updateTranscript(finalTranscript, '', false);
      }
    } else if (interrupted) {
      this.ui.showToast('録音が中断されました', 'info', 3000);
      if (epoch === this._transcriptEpoch) {
        this.ui.updateTranscript(transcript, '', false);
      }
    } else if (epoch === this._transcriptEpoch) {
      this.ui.updateTranscript(transcript, '', false);
    }

    this.ui.updateTimer(0);
  }

  /**
   * @param {boolean} enabled
   * @private
   */
  _setLanguageButtonsEnabled(enabled) {
    document.querySelectorAll('.lang-btn').forEach((btn) => {
      btn.style.pointerEvents = enabled ? '' : 'none';
      btn.style.opacity = enabled ? '' : '0.5';
    });
  }

  /**
   * Safari の audio session（AVAudioSession 相当）。未対応ブラウザでは何もしない。
   * @param {'auto'|'playback'|'play-and-record'} type
   * @private
   */
  _setAudioSessionType(type) {
    const session = navigator.audioSession;
    if (!session) return;
    try {
      if (session.type !== type) session.type = type;
    } catch (error) {
      console.warn('audioSession type 設定をスキップ:', error);
    }
  }

  /**
   * 画面ロック / バックグラウンド / 音声割り込みを監視する。
   * @private
   */
  _installLifecycleGuards() {
    const markInterrupted = () => {
      if (!this.isRecording) return;
      this._captureInterrupted = true;
      this.transcriber.hold();
      if (!this.recorder.isCaptureAlive()) {
        this._endRecordingSession({ interrupted: true });
      }
    };

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        markInterrupted();
      } else {
        this._reconcileRecordingSession();
      }
    });

    window.addEventListener('pagehide', markInterrupted);
    window.addEventListener('pageshow', () => this._reconcileRecordingSession());
    document.addEventListener('freeze', markInterrupted);
    document.addEventListener('resume', () => this._reconcileRecordingSession());

    const session = navigator.audioSession;
    if (session && typeof session.addEventListener === 'function') {
      session.addEventListener('statechange', () => {
        if (!this.isRecording) return;
        if (session.state === 'interrupted') {
          this._captureInterrupted = true;
          this.transcriber.hold();
        } else {
          this._reconcileRecordingSession();
        }
      });
    }
  }

  /**
   * ロック解除後、キャプチャが生きていれば続行し、死んでいれば保存して操作を戻す。
   * @private
   */
  _reconcileRecordingSession() {
    if (!this.isRecording || this._endingSession) return;

    if (!this.recorder.isCaptureAlive()) {
      this._endRecordingSession({ interrupted: true });
      return;
    }

    const native = this.recorder.syncNativeState();

    if (this._captureInterrupted && this.recorder.isInputMuted()) {
      const showPaused = native === 'paused' || this._userPaused;
      this.ui.setRecordingStatus(showPaused ? 'paused' : 'recording');
      if (showPaused) this._stopTimer();
      this.transcriber.hold();
      this._scheduleMuteGrace();
      return;
    }

    if (this._userPaused || native === 'paused') {
      this.ui.setRecordingStatus('paused');
      this.transcriber.hold();
      this._stopTimer();
      return;
    }

    this._resumeLiveCapture();
  }

  /**
   * ロック直後はトラックが muted のまま残ることがある。少し待ってから死活を決める。
   * @private
   */
  _scheduleMuteGrace() {
    if (this._muteGraceTimer) return;
    this._muteGraceTimer = setTimeout(() => {
      this._muteGraceTimer = null;
      if (!this.isRecording || this._endingSession) return;
      if (!this.recorder.isCaptureAlive() || this.recorder.isInputMuted()) {
        this._endRecordingSession({ interrupted: true });
        return;
      }
      this._resumeLiveCapture();
    }, 700);
  }

  /**
   * @private
   */
  _clearMuteGrace() {
    if (this._muteGraceTimer) {
      clearTimeout(this._muteGraceTimer);
      this._muteGraceTimer = null;
    }
  }

  /**
   * マイクがまだ生きているときの復帰。確定テキストは消さない。
   * @private
   */
  _resumeLiveCapture() {
    if (!this.isRecording || this._endingSession || this._userPaused) return;
    if (!this.recorder.isCaptureAlive() || this.recorder.isInputMuted()) return;

    this._clearMuteGrace();
    const native = this.recorder.syncNativeState();
    if (native === 'paused') {
      this.ui.setRecordingStatus('paused');
      this.transcriber.hold();
      this._stopTimer();
      return;
    }

    this._captureInterrupted = false;
    this.transcriber.releaseHold();
    this.ui.setRecordingStatus('recording');
    this._startTimer();
    if (this.visualizer) this.visualizer.resume();
  }

  /**
   * 一時停止/再開を切り替え
   * @private
   */
  async _togglePause() {
    if (!this.isRecording) return;
    if (this._endingSession) {
      await this._endingSession;
      return;
    }

    if (!this.recorder.isCaptureAlive() || (this._captureInterrupted && this.recorder.isInputMuted())) {
      await this._endRecordingSession({ interrupted: true });
      return;
    }

    const native = this.recorder.getNativeState();

    if (native === 'recording') {
      const paused = this.recorder.pause();
      if (!paused) {
        await this._endRecordingSession({ interrupted: true });
        return;
      }
      this._userPaused = true;
      this.transcriber.pauseListening();
      this._stopTimer();
      this.ui.setRecordingStatus('paused');
      if (this.visualizer) this.visualizer.startIdleAnimation();
      return;
    }

    if (native === 'paused') {
      const resumed = this.recorder.resume();
      if (!resumed) {
        await this._endRecordingSession({ interrupted: true });
        return;
      }
      this._userPaused = false;
      this._captureInterrupted = false;
      this.transcriber.resumeListening();
      this._startTimer();
      this.ui.setRecordingStatus('recording');
      if (this.visualizer && this.recorder.stream) {
        this.visualizer.stopIdleAnimation();
        await this.visualizer.connectStream(this.recorder.stream);
      }
      return;
    }

    await this._endRecordingSession({ interrupted: true });
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

    if (this._endingSession) {
      await this._endingSession;
    } else if (this.isRecording && !this.recorder.isCaptureAlive()) {
      await this._endRecordingSession({ interrupted: true });
    } else if (this.isRecording && this._captureInterrupted && this.recorder.isInputMuted()) {
      await this._endRecordingSession({ interrupted: true });
    }

    this._setAudioSessionType(this.isRecording ? 'play-and-record' : 'auto');

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

      const ext = recording.mimeType && recording.mimeType.includes('webm') ? 'webm' : 'mp4';
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
