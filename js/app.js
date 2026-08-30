/**
 * VoiceScribe — メインアプリケーション
 * 各モジュールを統合し、アプリ全体のフローを制御
 */

class VoiceScribeApp {
  constructor() {
    this.storage = new StorageManager();
    this.recorder = new AudioRecorder();
    this.transcriber = new Transcriber();
    this.ui = null;
    this.visualizer = null;

    // アプリ状態
    this.isRecording = false;
    this.currentRecordingId = null;
    this.currentDetailId = null;
    this.timerInterval = null;
    this.currentAudio = null; // 再生中のAudioオブジェクト
    this.playbackInterval = null;
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

      // 各種イベントリスナーの設定
      this._setupRecordView();
      this._setupListView();
      this._setupDetailView();

      // 文字起こし機能の利用可能性を確認
      this._checkTranscriptionSupport();

      // 録音一覧を初期読み込み
      await this._refreshRecordingsList();

      console.log('VoiceScribe 初期化完了');
    } catch (error) {
      console.error('初期化エラー:', error);
    }
  }

  /**
   * 文字起こし機能のサポート状況を確認してUIに反映
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
  // 録音ビュー
  // =====================================

  /**
   * 録音ビューのイベントリスナーを設定
   * @private
   */
  _setupRecordView() {
    // 録音ボタン
    const recordBtn = document.getElementById('record-btn');
    if (recordBtn) {
      recordBtn.addEventListener('click', () => this._toggleRecording());
    }

    // 言語切替ボタン
    const langBtns = document.querySelectorAll('.lang-btn');
    langBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        if (this.isRecording) return; // 録音中は変更不可
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
   * 録音を開始（iOS Safari同期起動＆完全フェイルセーフ設計）
   * @private
   */
  async _startRecording() {
    this.isRecording = true;
    this.currentRecordingId = StorageManager.generateId();
    this.ui.setRecordingStatus('recording');
    this._startTimer();
    this.ui.updateTranscript('', '', true);

    // プレースホルダーを即座に非表示
    const placeholderEl = document.getElementById('transcript-placeholder');
    if (placeholderEl) {
      placeholderEl.style.display = 'none';
    }

    // 1. 文字起こしエンジンをタップ直後に同期起動（iOS Safari必須）
    this.transcriber.onResult = (finalText, interimText) => {
      this.ui.updateTranscript(finalText, interimText, true);
    };

    try {
      this.transcriber.start();
    } catch (e) {
      console.warn('SpeechRecognition start warning:', e);
    }

    // 2. 音声録音（MediaRecorder）を起動（失敗しても文字起こしは継続）
    try {
      const stream = await this.recorder.start();
      if (this.visualizer && stream) {
        this.visualizer.stopIdleAnimation();
        await this.visualizer.connectStream(stream);
      }
    } catch (recErr) {
      console.warn('MediaRecorder warning (文字起こし単独で継続):', recErr);
    }

    // 言語ボタンの一時無効化
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

      // 録音停止
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
          console.warn('Visualizer stop warning:', e);
        }
      }

      // UI更新
      this.ui.setRecordingStatus('standby');

      // 言語選択を再有効化
      document.querySelectorAll('.lang-btn').forEach((btn) => {
        btn.style.pointerEvents = '';
        btn.style.opacity = '';
      });

      const activeLangBtn = document.querySelector('.lang-btn.active');
      const language = activeLangBtn ? activeLangBtn.dataset.lang : 'ja-JP';
      const duration = this.recorder.getElapsedTime() || 0;

      // データを保存（テキストまたは音声のいずれかがあれば保存）
      if (transcript || audioBlob) {
        const recording = {
          id: this.currentRecordingId,
          title: this._generateTitle(transcript, language),
          audioBlob: audioBlob,
          mimeType: audioMime,
          transcript: transcript,
          language: language,
          duration: duration,
          createdAt: Date.now()
        };

        await this.storage.save(recording);
        await this._refreshRecordingsList();
        this.ui.showToast('✅ 録音を保存しました', 'success');
      }

      // 確定テキストを表示状態で残す
      this.ui.updateTranscript(transcript, '', false);
      this.ui.updateTimer(0);
    } catch (error) {
      console.error('録音停止エラー:', error);
      this.isRecording = false;
      this.ui.setRecordingStatus('standby');
      this._stopTimer();
    }
  }

  /**
   * 一時停止/再開を切り替え
   * @private
   */
  _togglePause() {
    if (!this.isRecording) return;

    if (this.recorder.isPaused) {
      this.recorder.resume();
      this.ui.setRecordingStatus('recording');
      this.ui.showToast('▶️ 録音を再開しました', 'info');
    } else {
      this.recorder.pause();
      this.ui.setRecordingStatus('paused');
      this.ui.showToast('⏸️ 録音を一時停止しました', 'info');
    }
  }

  /**
   * タイマーを開始
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
   * タイマーを停止
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
   * @param {string} transcript - 文字起こしテキスト
   * @param {string} language - 言語コード
   * @returns {string}
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
      const firstLine = transcript.split(/[。\.\n]/)[0].trim();
      if (firstLine.length > 0) {
        return firstLine.substring(0, 30) + (firstLine.length > 30 ? '...' : '');
      }
    }

    return `録音 ${dateStr}`;
  }

  // =====================================
  // 一覧ビュー
  // =====================================

  /**
   * 一覧ビューのイベントリスナーを設定
   * @private
   */
  _setupListView() {
    // 検索入力
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
      let debounceTimer;
      searchInput.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          const query = searchInput.value;
          const results = await this.storage.search(query);
          this.ui.renderRecordingsList(results, this._getListCallbacks());
        }, 300);
      });
    }

    // 一覧タブに切り替えた時にリフレッシュ
    const listNavItem = document.querySelector('[data-view="list"]');
    if (listNavItem) {
      listNavItem.addEventListener('click', () => {
        this._refreshRecordingsList();
      });
    }
  }

  /**
   * 録音一覧をリフレッシュ
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
   * 一覧のコールバックを取得
   * @private
   * @returns {Object}
   */
  _getListCallbacks() {
    return {
      onDetail: (id) => this._openDetail(id),
      onDelete: (id) => this._confirmDelete(id)
    };
  }

  /**
   * 削除確認ダイアログを表示
   * @param {string} id - 録音ID
   * @private
   */
  _confirmDelete(id) {
    this.ui.showConfirmModal({
      icon: '🗑️',
      title: '録音を削除しますか？',
      description: 'この操作は取り消せません。録音データと文字起こしテキストが完全に削除されます。',
      confirmText: '削除する',
      onConfirm: async () => {
        try {
          await this.storage.delete(id);
          await this._refreshRecordingsList();
          this.ui.showToast('録音を削除しました', 'success');

          // 詳細ビューで開いていた場合は一覧に戻る
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
  // 詳細ビュー
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

    // スキップボタン
    const skipBackBtn = document.getElementById('skip-back-btn');
    const skipFwdBtn = document.getElementById('skip-fwd-btn');
    if (skipBackBtn) {
      skipBackBtn.addEventListener('click', () => this._skipPlayback(-10));
    }
    if (skipFwdBtn) {
      skipFwdBtn.addEventListener('click', () => this._skipPlayback(10));
    }

    // プログレスバー
    const progressBar = document.getElementById('player-progress');
    if (progressBar) {
      progressBar.addEventListener('click', (e) => this._seekPlayback(e));
    }

    // テキストコピー
    const detailCopyBtn = document.getElementById('detail-copy-btn');
    if (detailCopyBtn) {
      detailCopyBtn.addEventListener('click', () => this._copyDetailText());
    }

    // テキストダウンロード
    const exportTextBtn = document.getElementById('export-text-btn');
    if (exportTextBtn) {
      exportTextBtn.addEventListener('click', () => this._exportText());
    }

    // 音声ダウンロード
    const exportAudioBtn = document.getElementById('export-audio-btn');
    if (exportAudioBtn) {
      exportAudioBtn.addEventListener('click', () => this._exportAudio());
    }
  }

  /**
   * 詳細ビューを開く
   * @param {string} id - 録音ID
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

      // UIに表示
      this.ui.showDetail(recording);

      // 波形を描画
      const waveformCanvas = document.getElementById('player-waveform-canvas');
      if (waveformCanvas && recording.audioBlob) {
        AudioVisualizer.drawStaticWaveform(recording.audioBlob, waveformCanvas);
      }

      // プレイヤーの時間をリセット
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
      if (!recording || !recording.audioBlob) return;

      const url = URL.createObjectURL(recording.audioBlob);
      this.currentAudio = new Audio(url);

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
   * 再生時間を更新するタイマーを開始
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
    this._stopPlaybackTimer();

    const playBtn = document.getElementById('play-btn');
    if (playBtn) playBtn.textContent = '▶️';
  }

  /**
   * 再生位置をスキップ
   * @param {number} seconds - スキップ秒数（正: 前進, 負: 後退）
   * @private
   */
  _skipPlayback(seconds) {
    if (this.currentAudio) {
      this.currentAudio.currentTime = Math.max(
        0,
        Math.min(this.currentAudio.duration, this.currentAudio.currentTime + seconds)
      );
    }
  }

  /**
   * プログレスバーをクリックして再生位置を変更
   * @param {MouseEvent} event
   * @private
   */
  _seekPlayback(event) {
    if (!this.currentAudio || !this.currentAudio.duration) return;

    const bar = event.currentTarget;
    const rect = bar.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const ratio = x / rect.width;

    this.currentAudio.currentTime = ratio * this.currentAudio.duration;
  }

  /**
   * 詳細画面の文字起こしテキストをクリップボードにコピー
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

      await navigator.clipboard.writeText(text);
      this.ui.showToast('📋 全文テキストをコピーしました', 'success');
    } catch (err) {
      console.warn('クリップボードコピー失敗、フォールバック試行:', err);
      // フォールバック（execCommand）
      try {
        const textEl = document.getElementById('detail-transcript-text');
        if (textEl) {
          const range = document.createRange();
          range.selectNodeContents(textEl);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          document.execCommand('copy');
          selection.removeAllRanges();
          this.ui.showToast('📋 全文テキストをコピーしました', 'success');
          return;
        }
      } catch (fallbackErr) {
        console.error('コピー失敗:', fallbackErr);
      }
      this.ui.showToast('コピーに失敗しました。長押しで選択してください。', 'error');
    }
  }

  /**
   * テキストをエクスポート
   * @private
   */
  async _exportText() {
    try {
      const recording = await this.storage.getById(this.currentDetailId);
      if (!recording || !recording.transcript) {
        this.ui.showToast('エクスポートするテキストがありません。', 'error');
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
   * 音声をエクスポート
   * @private
   */
  async _exportAudio() {
    try {
      const recording = await this.storage.getById(this.currentDetailId);
      if (!recording || !recording.audioBlob) {
        this.ui.showToast('エクスポートする音声がありません。', 'error');
        return;
      }

      // MIMEタイプから拡張子を推定
      let ext = 'webm';
      if (recording.mimeType) {
        if (recording.mimeType.includes('mp4')) ext = 'mp4';
        else if (recording.mimeType.includes('ogg')) ext = 'ogg';
        else if (recording.mimeType.includes('wav')) ext = 'wav';
      }

      const url = URL.createObjectURL(recording.audioBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${recording.title || '録音'}.${ext}`;
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

  // Service Worker登録
  if ('serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.register('./sw.js');
      console.log('Service Worker 登録完了:', registration.scope);
    } catch (error) {
      console.warn('Service Worker 登録失敗:', error);
    }
  }
});
