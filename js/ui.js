/**
 * VoiceScribe — UI制御モジュール (UIManager)
 * DOM操作、イベントリスナー、画面遷移、トースト通知、モーダル管理を担当
 */

class UIManager {
  constructor() {
    // 各ビューのDOM参照
    this.views = {
      record: document.getElementById('view-record'),
      list: document.getElementById('view-list'),
      detail: document.getElementById('view-detail')
    };

    // ナビゲーションアイテム（下部タブおよびヘッダータブ対応）
    this.navItems = document.querySelectorAll('.nav-tab-btn, .nav-item');

    // 現在のアクティブビュー
    this.currentView = 'record';

    // トースト通知コンテナ
    this.toastContainer = document.getElementById('toast-container');

    // 確認モーダル
    this.modalOverlay = document.getElementById('modal-overlay');

    // フォントサイズ段階（sm, md, lg, xl）
    this.fontSizes = ['sm', 'md', 'lg', 'xl'];
    this.currentFontIndex = 2; // デフォルト: lg（1サイズ大きく）

    // 設定モーダル
    this.settingsModal = document.getElementById('settings-modal-overlay');

    // Whisper解析中オーバーレイ
    this.whisperOverlay = document.getElementById('whisper-processing-overlay');

    this._initFontControls();
    this._initQuickCopy();
    this._initSettingsModal();
    this._applyFontSize();
  }

  /**
   * フォントサイズ変更ボタンの初期化（録音画面＆詳細画面）
   * @private
   */
  _initFontControls() {
    // 録音画面
    const decBtn = document.getElementById('font-decrease-btn');
    const incBtn = document.getElementById('font-increase-btn');

    // 詳細画面
    const detailDecBtn = document.getElementById('detail-font-decrease-btn');
    const detailIncBtn = document.getElementById('detail-font-increase-btn');

    const handleDecrease = () => {
      if (this.currentFontIndex > 0) {
        this.currentFontIndex--;
        this._applyFontSize();
      }
    };

    const handleIncrease = () => {
      if (this.currentFontIndex < this.fontSizes.length - 1) {
        this.currentFontIndex++;
        this._applyFontSize();
      }
    };

    if (decBtn) decBtn.addEventListener('click', handleDecrease);
    if (incBtn) incBtn.addEventListener('click', handleIncrease);
    if (detailDecBtn) detailDecBtn.addEventListener('click', handleDecrease);
    if (detailIncBtn) detailIncBtn.addEventListener('click', handleIncrease);

    this._applyFontSize();
  }

  /**
   * 現在のフォントサイズクラスを適用（録音画面 & 詳細画面）
   * @private
   */
  _applyFontSize() {
    const textEl = document.getElementById('transcript-text');
    const detailTextEl = document.getElementById('detail-transcript-text');

    this.fontSizes.forEach(size => {
      if (textEl) textEl.classList.remove(`font-size-${size}`);
      if (detailTextEl) detailTextEl.classList.remove(`font-size-${size}`);
    });

    const currentSizeClass = `font-size-${this.fontSizes[this.currentFontIndex]}`;
    if (textEl) textEl.classList.add(currentSizeClass);
    if (detailTextEl) detailTextEl.classList.add(currentSizeClass);
  }

  /**
   * 録音画面のクイックコピーボタンの初期化
   * @private
   */
  _initQuickCopy() {
    const copyBtn = document.getElementById('quick-copy-btn');
    if (!copyBtn) return;

    copyBtn.addEventListener('click', async () => {
      const textEl = document.getElementById('transcript-text');
      const text = textEl ? textEl.innerText.trim() : '';

      if (!text) {
        this.showToast('コピーするテキストがありません', 'info');
        return;
      }

      await UIManager.copyToClipboard(text);
      this.showToast('📋 テキストをクリップボードにコピーしました', 'success');
    });
  }

  /**
   * ナビゲーションの初期化
   */
  initNavigation() {
    this.navItems.forEach((item) => {
      item.addEventListener('click', () => {
        const targetView = item.dataset.view;
        if (targetView) {
          this.switchView(targetView);
        }
      });
    });
  }

  /**
   * ビューを切り替え
   * @param {'record'|'list'|'detail'} viewName
   */
  switchView(viewName) {
    // 前のビューを非アクティブ化
    Object.values(this.views).forEach((view) => {
      if (view) view.classList.remove('active');
    });

    // ナビゲーションボタンのアクティブ状態を更新
    this.navItems.forEach((item) => {
      item.classList.toggle('active', item.dataset.view === viewName);
    });

    // 新しいビューをアクティブ化
    if (this.views[viewName]) {
      this.views[viewName].classList.add('active');
    }

    this.currentView = viewName;
  }

  /**
   * 録音ステータスUIを更新
   * @param {'standby'|'recording'|'paused'} state
   */
  setRecordingStatus(state) {
    const recordBtn = document.getElementById('record-btn');
    const btnText = document.getElementById('record-btn-text');
    const pauseBtn = document.getElementById('pause-btn');
    const timerEl = document.getElementById('timer-display');

    if (state === 'recording') {
      if (recordBtn) recordBtn.classList.add('recording');
      if (btnText) btnText.textContent = '録音停止';
      if (pauseBtn) {
        pauseBtn.style.display = 'inline-flex';
        pauseBtn.textContent = '⏸️';
      }
      if (timerEl) timerEl.classList.add('recording');
    } else if (state === 'paused') {
      if (recordBtn) recordBtn.classList.add('recording');
      if (btnText) btnText.textContent = '録音停止';
      if (pauseBtn) {
        pauseBtn.style.display = 'inline-flex';
        pauseBtn.textContent = '▶️';
      }
      if (timerEl) timerEl.classList.remove('recording');
    } else {
      if (recordBtn) recordBtn.classList.remove('recording');
      if (btnText) btnText.textContent = '録音開始';
      if (pauseBtn) {
        pauseBtn.style.display = 'none';
      }
      if (timerEl) timerEl.classList.remove('recording');
    }
  }

  /**
   * 文字起こしテキストをリアルタイム描画
   * @param {string} finalText - 確定テキスト
   * @param {string} interimText - 暫定テキスト（発話中の言葉）
   * @param {boolean} isRecording - 録音中かどうか
   */
  updateTranscript(finalText, interimText, isRecording = false) {
    const textEl = document.getElementById('transcript-text');
    const placeholderEl = document.getElementById('transcript-placeholder');
    const charCountEl = document.getElementById('char-count');
    const clearBtn = document.getElementById('clear-transcript-btn');
    const wrapper = document.getElementById('transcript-content-wrapper');

    if (!textEl) return;

    const totalText = (finalText || '') + (interimText || '');

    // 文字数カウント更新
    if (charCountEl) {
      charCountEl.textContent = totalText.length;
    }

    // クリアボタン表示制御
    if (clearBtn) {
      clearBtn.style.display = totalText.length > 0 && !isRecording ? 'inline-flex' : 'none';
    }

    // 空状態のハンドリング
    if (!finalText && !interimText) {
      if (placeholderEl) placeholderEl.style.display = isRecording ? 'none' : 'block';
      textEl.innerHTML = isRecording ? '<span class="transcript-cursor"></span>' : '';
      return;
    }

    if (placeholderEl) placeholderEl.style.display = 'none';

    // HTML構築（XSS対策エスケープ済み）
    let html = '';
    if (finalText) {
      html += `<span class="final">${UIManager.escapeHtml(finalText)}</span>`;
    }
    if (interimText) {
      html += `<span class="interim">${UIManager.escapeHtml(interimText)}</span>`;
    }
    if (isRecording) {
      html += '<span class="transcript-cursor"></span>';
    }

    textEl.innerHTML = html;

    // 自動スクロール（最新の発話にスムーズ追従）
    if (wrapper) {
      wrapper.scrollTop = wrapper.scrollHeight;
    }
  }

  /**
   * タイマー表示を更新
   * @param {number} seconds - 経過秒数
   */
  updateTimer(seconds) {
    const timerEl = document.getElementById('timer-display');
    if (timerEl) {
      timerEl.textContent = UIManager.formatTime(seconds);
    }
  }

  /**
   * 秒数を MM:SS 形式にフォーマット
   * @param {number} totalSeconds
   * @returns {string}
   */
  static formatTime(totalSeconds) {
    const safeSec = Math.max(0, Math.floor(totalSeconds || 0));
    const minutes = Math.floor(safeSec / 60);
    const seconds = safeSec % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  /**
   * 日時を日本語形式でフォーマット
   * @param {number} timestamp
   * @returns {string}
   */
  static formatDate(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();

    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = date.toDateString() === yesterday.toDateString();

    const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
    const weekday = weekdays[date.getDay()];
    const time = date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    const month = date.getMonth() + 1;
    const day = date.getDate();

    if (isToday) return `今日 ${time} (${month}/${day})`;
    if (isYesterday) return `昨日 ${time} (${month}/${day})`;

    if (date.getFullYear() === now.getFullYear()) {
      return `${month}/${day}(${weekday}) ${time}`;
    }

    return `${date.getFullYear()}/${month}/${day} ${time}`;
  }

  /**
   * 録音一覧を描画（2行コンパクト表示）
   * @param {Array} recordings - 録音データ一覧
   * @param {Object} callbacks - {onDetail, onDelete}
   */
  renderRecordingsList(recordings, callbacks) {
    const listEl = document.getElementById('recordings-list');
    const countEl = document.getElementById('recordings-count');

    if (!listEl) return;

    if (countEl) {
      countEl.textContent = `${recordings.length} 件の録音`;
    }

    // 空状態
    if (recordings.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🎙️</div>
          <div class="empty-state-title">録音がありません</div>
          <div class="empty-state-desc">録音タブで録音を開始してみましょう</div>
        </div>
      `;
      return;
    }

    listEl.innerHTML = recordings
      .map((rec) => {
        const transcript = (rec.transcript || '').trim();
        const dateStr = UIManager.formatDate(rec.createdAt);
        const duration = UIManager.formatTime(rec.duration || 0);
        const langIcon = rec.language === 'ja-JP' ? '🇯🇵' : '🇺🇸';
        const previewText = transcript || '（音声メモのみ）';

        return `
          <div class="recording-card" data-id="${rec.id}" id="card-${rec.id}">
            <div class="card-icon">🎙️</div>
            <div class="card-info">
              <!-- 1行目: 日時・時間・言語 -->
              <div class="card-top-row">
                <span class="card-date-badge">📅 ${dateStr}</span>
                <span class="card-duration-badge">⏱️ ${duration}</span>
                <span class="card-lang-badge">${langIcon}</span>
              </div>

              <!-- 2行目: コンパクトな2行テキストプレビュー -->
              <div class="card-compact-text ${!transcript ? 'empty-memo' : ''}">
                ${UIManager.escapeHtml(previewText)}
              </div>
            </div>

            <!-- アクション -->
            <div class="card-actions">
              <span class="card-arrow-icon" title="詳細を見る">›</span>
              <button class="card-action-btn card-delete-btn delete" data-action="delete" data-id="${rec.id}" title="削除" aria-label="録音を削除">🗑️</button>
            </div>
          </div>
        `;
      })
      .join('');
  }

  /**
   * 録音詳細ビューを表示
   * @param {Object} recording - 録音データ
   */
  showDetail(recording) {
    const titleEl = document.getElementById('detail-title');
    const dateEl = document.getElementById('detail-date');
    const transcriptEl = document.getElementById('detail-transcript-text');
    const charCountEl = document.getElementById('detail-char-count');

    if (titleEl) titleEl.textContent = recording.title || '録音';
    if (dateEl) dateEl.textContent = UIManager.formatDate(recording.createdAt);

    const transcript = (recording.transcript || '').trim();

    // 文字数カウント更新
    if (charCountEl) {
      charCountEl.textContent = `${transcript.length}文字`;
    }

    if (transcriptEl) {
      if (transcript) {
        transcriptEl.textContent = transcript;
        transcriptEl.classList.remove('detail-transcript-empty');
      } else {
        transcriptEl.textContent = '文字起こしテキストはありません（音声メモのみ）';
        transcriptEl.classList.add('detail-transcript-empty');
      }
    }

    // 現在のフォントサイズを再適用
    this._applyFontSize();

    this.switchView('detail');
  }

  /**
   * トースト通知を表示
   * @param {string} message - 表示メッセージ
   * @param {'success'|'error'|'info'} type - 通知タイプ
   * @param {number} duration - 表示時間（ms）
   */
  showToast(message, type = 'info', duration = 3000) {
    if (!this.toastContainer) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    this.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('removing');
      setTimeout(() => {
        toast.remove();
      }, 300);
    }, duration);
  }

  /**
   * 削除等の確認モーダルを表示
   * @param {Object} options - {icon, title, description, confirmText, onConfirm}
   */
  showConfirmModal(options) {
    if (!this.modalOverlay) return;

    const iconEl = this.modalOverlay.querySelector('.modal-icon');
    const titleEl = this.modalOverlay.querySelector('.modal-title');
    const descEl = this.modalOverlay.querySelector('.modal-desc');
    const confirmBtn = this.modalOverlay.querySelector('.modal-btn.danger');
    const cancelBtn = this.modalOverlay.querySelector('.modal-btn:not(.danger)');

    if (iconEl) iconEl.textContent = options.icon || '⚠️';
    if (titleEl) titleEl.textContent = options.title || '確認';
    if (descEl) descEl.textContent = options.description || '';
    if (confirmBtn) confirmBtn.textContent = options.confirmText || '削除';

    this.modalOverlay.classList.add('visible');

    const cleanup = () => {
      this.modalOverlay.classList.remove('visible');
      confirmBtn.removeEventListener('click', handleConfirm);
      cancelBtn.removeEventListener('click', handleCancel);
    };

    const handleConfirm = () => {
      cleanup();
      if (options.onConfirm) options.onConfirm();
    };

    const handleCancel = () => {
      cleanup();
    };

    confirmBtn.addEventListener('click', handleConfirm);
    cancelBtn.addEventListener('click', handleCancel);

    this.modalOverlay.addEventListener('click', (e) => {
      if (e.target === this.modalOverlay) handleCancel();
    }, { once: true });
  }

  /**
   * Groq設定モーダルの初期化
   * @private
   */
  _initSettingsModal() {
    const settingsBtn = document.getElementById('header-settings-btn');
    const closeBtn = document.getElementById('settings-modal-close');
    const toggleVisBtn = document.getElementById('toggle-key-visibility-btn');
    const keyInput = document.getElementById('groq-api-key-input');
    const testBtn = document.getElementById('test-groq-btn');
    const saveBtn = document.getElementById('save-settings-btn');
    const statusBox = document.getElementById('settings-status-box');

    if (!settingsBtn || !this.settingsModal) return;

    // 開く
    settingsBtn.addEventListener('click', () => {
      if (window.app && window.app.whisper) {
        if (keyInput) keyInput.value = window.app.whisper.apiKey || '';
      }
      if (statusBox) statusBox.innerHTML = '';
      this.settingsModal.classList.add('active');
    });

    // 閉じる
    const closeSettings = () => {
      this.settingsModal.classList.remove('active');
    };
    if (closeBtn) closeBtn.addEventListener('click', closeSettings);
    this.settingsModal.addEventListener('click', (e) => {
      if (e.target === this.settingsModal) closeSettings();
    });

    // APIキーの表示/非表示切り替え
    if (toggleVisBtn && keyInput) {
      toggleVisBtn.addEventListener('click', () => {
        const isPwd = keyInput.type === 'password';
        keyInput.type = isPwd ? 'text' : 'password';
        toggleVisBtn.textContent = isPwd ? '🙈' : '👁️';
      });
    }

    // 接続テスト
    if (testBtn) {
      testBtn.addEventListener('click', async () => {
        const key = keyInput ? keyInput.value.trim() : '';
        if (!key) {
          if (statusBox) statusBox.innerHTML = '<span class="status-err">⚠️ APIキーを入力してください</span>';
          return;
        }
        testBtn.disabled = true;
        testBtn.textContent = '⏳ テスト中...';
        if (statusBox) statusBox.innerHTML = '<span class="status-info">Groq APIに接続中...</span>';

        const whisper = window.app ? window.app.whisper : new WhisperService();
        const result = await whisper.testConnection(key);

        testBtn.disabled = false;
        testBtn.textContent = '🔄 接続テスト';

        if (statusBox) {
          if (result.success) {
            statusBox.innerHTML = `<span class="status-ok">${result.message}</span>`;
          } else {
            statusBox.innerHTML = `<span class="status-err">${result.message}</span>`;
          }
        }
      });
    }

    // 保存
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        const key = keyInput ? keyInput.value.trim() : '';

        if (window.app && window.app.whisper) {
          window.app.whisper.saveApiKey(key);
        }

        this.showToast('💾 設定を保存しました', 'success');
        closeSettings();
      });
    }
  }

  /**
   * Whisper解析中オーバーレイを表示
   */
  showWhisperOverlay() {
    if (this.whisperOverlay) {
      this.whisperOverlay.classList.add('active');
    }
  }

  /**
   * Whisper解析中オーバーレイを非表示
   */
  hideWhisperOverlay() {
    if (this.whisperOverlay) {
      this.whisperOverlay.classList.remove('active');
    }
  }

  /**
   * クリップボードへコピー（フォールバック付き）
   * @param {string} text
   * @returns {Promise<boolean>}
   */
  static async copyToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // フォールバックへ移行
    }

    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      return true;
    } catch (e) {
      console.error('クリップボードコピー失敗:', e);
      return false;
    }
  }

  /**
   * HTMLエスケープ（XSS対策）
   * @param {string} str
   * @returns {string}
   */
  static escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

// グローバルエクスポート
window.UIManager = UIManager;
