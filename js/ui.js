/**
 * VoiceScribe — UI制御
 * DOM操作、イベントリスナー、画面遷移、通知を管理
 */

class UIManager {
  constructor() {
    // ビューの参照
    this.views = {
      record: document.getElementById('view-record'),
      list: document.getElementById('view-list'),
      detail: document.getElementById('view-detail')
    };

    // ナビゲーションボタン
    this.navItems = document.querySelectorAll('.nav-tab-btn, .nav-item');

    // 現在のビュー
    this.currentView = 'record';

    // トーストコンテナ
    this.toastContainer = document.getElementById('toast-container');

    // モーダル
    this.modalOverlay = document.getElementById('modal-overlay');

    // フォントサイズ段階（sm, md, lg, xl）
    this.fontSizes = ['sm', 'md', 'lg', 'xl'];
    this.currentFontIndex = 1; // デフォルト: md (1.25rem)

    this._initFontControls();
    this._initQuickCopy();
  }

  /**
   * フォントサイズ変更ボタンの初期化
   * @private
   */
  _initFontControls() {
    const decBtn = document.getElementById('font-decrease-btn');
    const incBtn = document.getElementById('font-increase-btn');
    const textEl = document.getElementById('transcript-text');

    if (decBtn) {
      decBtn.addEventListener('click', () => {
        if (this.currentFontIndex > 0) {
          this.currentFontIndex--;
          this._applyFontSize();
        }
      });
    }

    if (incBtn) {
      incBtn.addEventListener('click', () => {
        if (this.currentFontIndex < this.fontSizes.length - 1) {
          this.currentFontIndex++;
          this._applyFontSize();
        }
      });
    }

    this._applyFontSize();
  }

  /**
   * 現在のフォントサイズクラスを適用
   * @private
   */
  _applyFontSize() {
    const textEl = document.getElementById('transcript-text');
    if (!textEl) return;

    this.fontSizes.forEach(size => textEl.classList.remove(`font-size-${size}`));
    textEl.classList.add(`font-size-${this.fontSizes[this.currentFontIndex]}`);
  }

  /**
   * ワンタップコピーボタンの初期化
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

      try {
        await navigator.clipboard.writeText(text);
        this.showToast('📋 テキストをクリップボードにコピーしました', 'success');
      } catch {
        this.showToast('コピーに失敗しました', 'error');
      }
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
   * @param {string} viewName - 'record' | 'list' | 'detail'
   */
  switchView(viewName) {
    // 前のビューを非アクティブに
    Object.values(this.views).forEach((view) => {
      if (view) view.classList.remove('active');
    });

    // ナビゲーションのアクティブ状態を更新
    this.navItems.forEach((item) => {
      item.classList.toggle('active', item.dataset.view === viewName);
    });

    // 新しいビューをアクティブに
    if (this.views[viewName]) {
      this.views[viewName].classList.add('active');
    }

    this.currentView = viewName;
  }

  /**
   * 録音ステータスを更新
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
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  /**
   * 日時をフォーマット（見分けやすい詳細フォーマット）
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

    // 同じ年なら月日+曜日+時間
    if (date.getFullYear() === now.getFullYear()) {
      return `${month}/${day}(${weekday}) ${time}`;
    }

    // 異なる年なら年月日+時間
    return `${date.getFullYear()}/${month}/${day} ${time}`;
  }

  /**
   * 録音カード一覧を描画
   * @param {Array} recordings - 録音データの配列
   * @param {Object} callbacks - {onPlay, onDelete, onDetail}
   */
  renderRecordingsList(recordings, callbacks) {
    const listEl = document.getElementById('recordings-list');
    const countEl = document.getElementById('recordings-count');

    if (!listEl) return;

    // 件数表示
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

        let firstPhrase = '';
        let restText = '';

        if (transcript) {
          // 句読点や改行で出だしのフレーズを抽出
          const match = transcript.match(/^([^。！？\.\n\?\!]{1,40}[。！？\.\n\?\!]?)/);
          if (match && match[0]) {
            firstPhrase = match[0].trim();
            restText = transcript.substring(firstPhrase.length).trim();
          } else {
            firstPhrase = transcript.substring(0, 35) + (transcript.length > 35 ? '...' : '');
            restText = transcript.substring(35).trim();
          }
          if (restText.length > 80) {
            restText = restText.substring(0, 80) + '...';
          }
        } else {
          firstPhrase = '（音声メモのみ）';
        }

        return `
          <div class="recording-card" data-id="${rec.id}" id="card-${rec.id}">
            <div class="card-icon">🎙️</div>
            <div class="card-info">
              <!-- 最上部: 見分けやすい日時バッジ ＆ 時間 -->
              <div class="card-top-row">
                <span class="card-date-badge">📅 ${dateStr}</span>
                <span class="card-duration-badge">⏱️ ${duration}</span>
                <span class="card-lang-badge">${langIcon}</span>
              </div>

              <!-- 話した内容の出だし（中身が一目でわかる） -->
              <div class="card-speech-start">
                <span class="quote-mark">“</span>
                <span class="speech-text">${UIManager.escapeHtml(firstPhrase)}</span>
                <span class="quote-mark">”</span>
              </div>

              <!-- 続きの文章（あれば表示） -->
              ${restText ? `<div class="card-preview">${UIManager.escapeHtml(restText)}</div>` : ''}
            </div>
            <div class="card-actions">
              <button class="card-action-btn delete" data-action="delete" data-id="${rec.id}" title="削除">🗑️</button>
            </div>
          </div>
        `;
      })
      .join('');

    // イベントリスナーを設定
    listEl.querySelectorAll('.recording-card').forEach((card) => {
      // カード全体クリックで詳細へ
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-action="delete"]')) return;
        const id = card.dataset.id;
        if (callbacks.onDetail) callbacks.onDetail(id);
      });
    });

    // 削除ボタン
    listEl.querySelectorAll('[data-action="delete"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        if (callbacks.onDelete) callbacks.onDelete(id);
      });
    });
  }

  /**
   * 詳細ビューを表示
   * @param {Object} recording - 録音データ
   */
  showDetail(recording) {
    const titleEl = document.getElementById('detail-title');
    const dateEl = document.getElementById('detail-date');
    const transcriptEl = document.getElementById('detail-transcript-text');

    if (titleEl) titleEl.textContent = recording.title || '録音';
    if (dateEl) dateEl.textContent = UIManager.formatDate(recording.createdAt);

    if (transcriptEl) {
      if (recording.transcript) {
        transcriptEl.textContent = recording.transcript;
        transcriptEl.classList.remove('detail-transcript-empty');
      } else {
        transcriptEl.textContent = '文字起こしテキストはありません';
        transcriptEl.classList.add('detail-transcript-empty');
      }
    }

    this.switchView('detail');
  }

  /**
   * トースト通知を表示
   * @param {string} message - メッセージ
   * @param {string} type - 'success' | 'error' | 'info'
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
   * 確認モーダルを表示
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

    // オーバーレイクリックでも閉じる
    this.modalOverlay.addEventListener('click', (e) => {
      if (e.target === this.modalOverlay) handleCancel();
    }, { once: true });
  }

  /**
   * HTMLエスケープ
   * @param {string} str
   * @returns {string}
   */
  static escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}

// グローバルエクスポート
window.UIManager = UIManager;
