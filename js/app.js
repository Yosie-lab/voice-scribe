/**
 * VoiceScribe — メインアプリケーションコントローラー (VoiceScribeApp)
 * 各モジュール（Storage, Recorder, Transcriber, Whisper, Visualizer, UI）を統合管理
 */

/** @type {string} 設定画面とコンソールで確認するビルド番号 */
const APP_BUILD = 'v96';

class VoiceScribeApp {
  constructor() {
    this.storage = new StorageManager();
    this.recorder = new AudioRecorder();
    this.transcriber = new Transcriber();
    this.whisper = new WhisperService();
    this.whisperLive = new WhisperLive();
    this._offlineWhisperFallback = false;
    this._offlineWhisperSession = false;
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
    this._lastMicReattachAt = 0;
    this._iosSttWarmupTimer = null;

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
      this._bindOfflineWhisper();

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

      this._haltLiveTranscription();

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
    if (this._usesOfflineWhisper()) {
      this.whisperLive.clearText();
      this._bestTranscript = '';
      this.ui.updateTranscript('', '', this.isRecording);
      return;
    }
    const keepListening = this.isRecording && !this._userPaused && this.transcriber.isListening;
    this.transcriber.reset();
    if (keepListening) {
      this.transcriber.continueListening();
    }
    this.ui.updateTranscript('', '', this.isRecording);
  }

  /**
   * オフライン Whisper の字幕とダウンロード表示。Web Speech が標準。
   * @private
   */
  _bindOfflineWhisper() {
    if (!this.whisperLive) return;
    this.whisperLive.onTranscript = (finalText) => {
      if (!this.isRecording || this._userPaused || !this._usesOfflineWhisper()) return;
      const text = finalText || '';
      this._bestTranscript = this._longerText(this._bestTranscript, text);
      this.ui.updateTranscript(text, '', true);
    };
    this.whisperLive.onStatus = (info) => {
      const text = info && info.text ? info.text : '';
      const busy = !!(info && info.busy);
      if (this.ui) this.ui.setWhisperLiveStatus(text, busy || this.isRecording);
    };
  }


  /**
   * 画面ロック / 復帰。Wake Lock は使わない。サイドボタンのロックは iOS がマイクを止める。
   * @private
   */
  _bindRecordingLifecycle() {
    const onHide = () => this._onRecordingHidden();
    const onShow = () => {
      if (!this.isRecording) {
        this._syncViewportHeight();
        this._ensureLiveTranscriptionIdle();
      }
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
      this._autoRecoverLiveStt();
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
        this._autoRecoverLiveStt();
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
    if (this._usesOfflineWhisper()) {
      const stream = this.recorder.stream;
      if (this.whisperLive && stream) await this.whisperLive.attachStream(stream);
      this.ui.setRecordingStatus('recording');
      return;
    }
    // マイクを取り直したあとに認識を付ける。先に start すると desktop Chrome は abort する。
    if (captureDown && !this._isIOSDevice()) {
      this.transcriber.continueListening();
    } else {
      this.transcriber.resumeAfterBackground();
    }
    this.ui.setRecordingStatus('recording');
    this._armRecognitionGesture();
    this._autoRecoverLiveStt();
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
      ' を開く → ⚙️ でビルド v95 を確認 → 共有 → ホーム画面に追加。',
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

Object.assign(VoiceScribeApp.prototype, VoiceScribeRecordingHealth);
Object.assign(VoiceScribeApp.prototype, VoiceScribeRecordingSession);

// =====================================
// アプリケーション起動
// =====================================
document.addEventListener('DOMContentLoaded', async () => {
  const app = new VoiceScribeApp();
  await app.init();

  // Service Worker登録と自動更新
  if ('serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.register('./sw.js?v=96');
      console.log('Service Worker 登録完了:', registration.scope);
      if (registration.update) {
        registration.update();
      }
    } catch (error) {
      console.warn('Service Worker 登録失敗:', error);
    }
  }
});
