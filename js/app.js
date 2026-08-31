/**
 * VoiceScribe — メインアプリケーションコントローラー
 * 各モジュール（Storage, Recorder, Transcriber, Visualizer, UI）を統合管理
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
   * 文字起こし機能の対応状況およびiOSスタンドアロンモードを確認
   * @private
   */
  _checkTranscriptionSupport() {
    // iOSスタンドアロンPWAモードの検知
    const isStandalone = window.navigator.standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches;

    const standaloneBanner = document.getElementById('standalone-banner');
    if (isStandalone && standaloneBanner) {
      standaloneBanner.style.display = 'flex';
    }

    const { available, reason } = Transcriber.checkAvailability();
    const unsupportedEl = document.getElementById('transcript-unsupported');

    if (!available && unsupportedEl && !isStandalone) {
      unsupportedEl.classList.add('visible');
      const msgEl = unsupportedEl.querySelector('.unsupported-msg');
      if (msgEl) msgEl.textContent = reason;
    }
  }

  // =====================================
  // 録音ビューの制御
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

    // 録音エラーコールバック
    this.recorder.onError = (message) => {
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
    this.currentRecordingId = StorageManager.generateId();
    this.ui.setRecordingStatus('recording');
    this._startTimer();
    this.ui.updateTranscript('', '', true);

    // プレースホルダーを非表示
    const placeholderEl = document.getElementById('transcript-placeholder');
    if (placeholderEl) {
      placeholderEl.style.display = 'none';
    }

    // 1. 文字起こしエンジンを同期起動（iOS Safari必須）
    this.transcriber.onResult = (finalText, interimText) => {
      this.ui.updateTranscript(finalText, interimText, true);
    };

    try {
      this.transcriber.start();
    } catch (e) {
      console.warn('SpeechRecognition start warning:', e);
    }

    // 2. 音声録音（MediaRecorder）を起動（失敗時も文字起こしは継続）
    try {
      const stream = await this.recorder.start();
      if (this.visualizer && stream) {
        this.visualizer.stopIdleAnimation();
        await this.visualizer.connectStream(stream);
      }
    } catch (recErr) {
      console.warn('MediaRecorder start warning:', recErr);
    }

    // 言語ボタンを一時無効化
    document.querySelectorAll('.lang-btn').forEach((btn) => {
      btn.style.pointerEvents = 'none';
      btn.style.opacity = '0.5';
    });

    this.ui.showToast('🎙️ 録音中（お話しください）', 'success', 2000);
  }

  /**
   * 録音を停止して保存（完全フェイルセーフ）
   * @private
   */
  async _stopRecording() {
    try {
      // 1. 停止前に文字起こしテキストを確実に取得
      let transcript = (this.transcriber.getFullTranscript() || '').trim();

      // 画面上のテキストからもフォールバック取得
      if (!transcript) {
        const textEl = document.getElementById('transcript-text');
        if (textEl) {
          transcript = (textEl.innerText || textEl.textContent || '').trim();
        }
      }

      // 文字起こし停止
      this.transcriber.stop();

      // 音声録音停止
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

      this.isRecording = false;
      this._stopTimer();

      // ビジュアライザー停止
      if (this.visualizer) {
        try {
          this.visualizer.disconnect();
          this.visualizer.startIdleAnimation();
        } catch (e) {
          console.warn('Visualizer disconnect warning:', e);
        }
      }

      // UI更新
      this.ui.setRecordingStatus('standby');

      // 言語選択ボタンを再有効化
      document.querySelectorAll('.lang-btn').forEach((btn) => {
        btn.style.pointerEvents = '';
        btn.style.opacity = '';
      });

      const activeLangBtn = document.querySelector('.lang-btn.active');
      const language = activeLangBtn ? activeLangBtn.dataset.lang : 'ja-JP';
      const duration = this.recorder.getElapsedTime() || 0;

      // データを保存（テキストまたは音声のいずれかがあれば保存）
      if (transcript || audioBlob) {
        let finalTranscript = transcript;

        // Groq Whisper APIキーがある場合、録音音声から100%忠実な文字起こしを爆速実行
        if (this.whisper.hasApiKey() && audioBlob) {
          try {
            this.ui.showWhisperOverlay();
            const whisperText = await this.whisper.transcribeAudio(audioBlob, language);
            if (whisperText && whisperText.trim()) {
              finalTranscript = whisperText.trim();
            }
          } catch (whisperErr) {
            console.warn('Whisper自動文字起こし警告（Safariテキストを使用）:', whisperErr);
            this.ui.showToast(`Whisperスキップ: ${whisperErr.message}`, 'info', 3000);
          } finally {
            this.ui.hideWhisperOverlay();
          }
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

        // 画面のテキストも最新に更新
        this.ui.updateTranscript(finalTranscript, '', false);
      } else {
        this.ui.updateTranscript(transcript, '', false);
      }

      this.ui.updateTimer(0);
    } catch (error) {
      console.error('録音停止エラー:', error);
      this.isRecording = false;
      this.ui.setRecordingStatus('standby');
      this._stopTimer();
      if (this.ui.hideWhisperOverlay) this.ui.hideWhisperOverlay();
    }
  }

  /**
   * 一時停止/再開を切り替え
   * @private
   */
  async _togglePause() {
    if (!this.isRecording) return;

    const pauseBtn = document.getElementById('pause-btn');

    if (this.recorder.state === 'recording') {
      this.recorder.pause();
      this.transcriber.stop();
      this._stopTimer();
      this.ui.setRecordingStatus('paused');
      if (pauseBtn) pauseBtn.textContent = '▶️';
      if (this.visualizer) this.visualizer.startIdleAnimation();
      this.ui.showToast('録音を一時停止しました', 'info');
    } else if (this.recorder.state === 'paused') {
      this.recorder.resume();
      this.transcriber.start();
      this._startTimer();
      this.ui.setRecordingStatus('recording');
      if (pauseBtn) pauseBtn.textContent = '⏸️';
      if (this.visualizer && this.recorder.stream) {
        this.visualizer.stopIdleAnimation();
        await this.visualizer.connectStream(this.recorder.stream);
      }
      this.ui.showToast('録音を再開しました', 'info');
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
    }, 500);
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
   * 録音タイトルを自動生成
   * @param {string} transcript
   * @param {string} language
   * @returns {string}
   * @private
   */
  _generateTitle(transcript, language) {
    const now = new Date();
    const dateStr = now.toLocaleDateString('ja-JP', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    if (transcript && transcript.length > 0) {
      const firstLine = transcript.split(/[。\.\n！？\!\?]/)[0].trim();
      if (firstLine.length > 0) {
        return firstLine.substring(0, 25) + (firstLine.length > 25 ? '...' : '');
      }
    }

    return `録音 ${dateStr}`;
  }

  // =====================================
  // 一覧ビューの制御
  // =====================================

  /**
   * 一覧ビューのイベントリスナーを設定
   * @private
   */
  _setupListView() {
    // 検索入力（デバウンス付き）
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
      let debounceTimer;
      searchInput.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          const query = searchInput.value;
          const results = await this.storage.search(query);
          this.ui.renderRecordingsList(results, this._getListCallbacks());
        }, 250);
      });
    }

    // タブ切替時に自動リフレッシュ
    const listNavItems = document.querySelectorAll('[data-view="list"]');
    listNavItems.forEach((item) => {
      item.addEventListener('click', () => {
        this._refreshRecordingsList();
      });
    });
  }

  /**
   * 録音一覧を最新状態に更新
   * @private
   */
  async _refreshRecordingsList() {
    try {
      const recordings = await this.storage.getAll();
      this.ui.renderRecordingsList(recordings, this._getListCallbacks());
    } catch (error) {
      console.error('一覧読み込みエラー:', error);
    }
  }

  /**
   * 一覧操作用コールバックオブジェクトを取得
   * @returns {Object}
   * @private
   */
  _getListCallbacks() {
    return {
      onDetail: (id) => this._openDetail(id),
      onDelete: (id) => this._confirmDelete(id)
    };
  }

  /**
   * 削除確認ダイアログを表示
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
  // 詳細ビューの制御
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
    } catch (error) {
      console.error('詳細表示エラー:', error);
      this.ui.showToast('データの読み込みに失敗しました。', 'error');
    }
  }

  /**
   * 再生/停止を切り替え
   * @private
   */
  async _togglePlayback() {
    const playBtn = document.getElementById('play-btn');

    if (this.currentAudio && !this.currentAudio.paused) {
      this.currentAudio.pause();
      if (playBtn) playBtn.textContent = '▶️';
      this._stopPlaybackTimer();
      return;
    }

    if (this.currentAudio && this.currentAudio.paused && this.currentAudio.currentTime > 0) {
      this.currentAudio.play();
      if (playBtn) playBtn.textContent = '⏸️';
      this._startPlaybackTimer();
      return;
    }

    // 新規再生
    try {
      const recording = await this.storage.getById(this.currentDetailId);
      if (!recording || !recording.audioBlob) {
        this.ui.showToast('再生できる音声データがありません。', 'info');
        return;
      }

      this._cleanupAudioUrl();
      this.currentAudioUrl = URL.createObjectURL(recording.audioBlob);
      this.currentAudio = new Audio(this.currentAudioUrl);

      this.currentAudio.onended = () => {
        if (playBtn) playBtn.textContent = '▶️';
        this._stopPlaybackTimer();
        const progressFill = document.getElementById('player-progress-fill');
        if (progressFill) progressFill.style.width = '100%';
      };

      this.currentAudio.onerror = () => {
        this.ui.showToast('音声の再生に失敗しました。', 'error');
        if (playBtn) playBtn.textContent = '▶️';
      };

      await this.currentAudio.play();
      if (playBtn) playBtn.textContent = '⏸️';
      this._startPlaybackTimer();
    } catch (error) {
      console.error('再生エラー:', error);
      this.ui.showToast('音声の再生に失敗しました。', 'error');
    }
  }

  /**
   * 再生タイマーを開始
   * @private
   */
  _startPlaybackTimer() {
    this._stopPlaybackTimer();
    this.playbackInterval = setInterval(() => {
      if (!this.currentAudio) return;

      const currentTimeEl = document.getElementById('player-current-time');
      const progressFill = document.getElementById('player-progress-fill');

      if (currentTimeEl) {
        currentTimeEl.textContent = UIManager.formatTime(this.currentAudio.currentTime);
      }

      if (progressFill && this.currentAudio.duration) {
        const progress = (this.currentAudio.currentTime / this.currentAudio.duration) * 100;
        progressFill.style.width = `${progress}%`;
      }
    }, 100);
  }

  /**
   * 再生タイマーを停止
   * @private
   */
  _stopPlaybackTimer() {
    if (this.playbackInterval) {
      clearInterval(this.playbackInterval);
      this.playbackInterval = null;
    }
  }

  /**
   * 再生を完全に停止
   * @private
   */
  _stopPlayback() {
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
    }
    this._cleanupAudioUrl();
    this._stopPlaybackTimer();

    const playBtn = document.getElementById('play-btn');
    if (playBtn) playBtn.textContent = '▶️';
  }

  /**
   * オーディオBlobのURLを解放（メモリリーク防止）
   * @private
   */
  _cleanupAudioUrl() {
    if (this.currentAudioUrl) {
      URL.revokeObjectURL(this.currentAudioUrl);
      this.currentAudioUrl = null;
    }
  }

  /**
   * 再生位置をスキップ
   * @param {number} seconds
   * @private
   */
  _skipPlayback(seconds) {
    if (this.currentAudio) {
      this.currentAudio.currentTime = Math.max(
        0,
        Math.min(this.currentAudio.duration || 0, this.currentAudio.currentTime + seconds)
      );
    }
  }

  /**
   * シークバーをクリックして再生位置を変更
   * @param {MouseEvent} event
   * @private
   */
  _seekPlayback(event) {
    if (!this.currentAudio || !this.currentAudio.duration) return;

    const bar = event.currentTarget;
    const rect = bar.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, x / rect.width));

    this.currentAudio.currentTime = ratio * this.currentAudio.duration;
  }

  /**
   * 詳細画面のテキストをクリップボードにコピー
   * @private
   */
  async _copyDetailText() {
    try {
      const recording = await this.storage.getById(this.currentDetailId);
      const text = recording && recording.transcript ? recording.transcript.trim() : '';

      if (!text) {
        this.ui.showToast('コピーするテキストがありません。', 'info');
        return;
      }

      const success = await UIManager.copyToClipboard(text);
      if (success) {
        this.ui.showToast('📋 全文テキストをコピーしました', 'success');
      } else {
        this.ui.showToast('コピーに失敗しました。長押しで選択してください。', 'error');
      }
    } catch (err) {
      console.error('テキストコピーエラー:', err);
      this.ui.showToast('コピー中にエラーが発生しました。', 'error');
    }
  }

  /**
   * テキストファイルをエクスポート
   * @private
   */
  async _exportText() {
    try {
      const recording = await this.storage.getById(this.currentDetailId);
      if (!recording || !recording.transcript) {
        this.ui.showToast('エクスポートするテキストがありません。', 'info');
        return;
      }

      const blob = new Blob([recording.transcript], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${recording.title || '録音'}_テキスト.txt`;
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
   * 音声ファイルをエクスポート
   * @private
   */
  async _exportAudio() {
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
