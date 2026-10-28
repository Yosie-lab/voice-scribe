/**
 * VoiceScribe — 既存マイクストリームのオフライン Whisper ライブ字幕。
 * getUserMedia は開かない。Web Speech にも GainNode を渡さない。
 * 無音ゲインは AudioWorklet を回すための吸い込みだけで、スピーカーには出さない。
 */
class WhisperLive {
  constructor() {
    this.worker = null;
    this.audioCtx = null;
    this._source = null;
    this._worklet = null;
    this._sink = null;
    this._pcm = new Float32Array(0);
    this._since = 0;
    this._queue = [];
    this._busy = false;
    this._paused = false;
    this._running = false;
    this._session = 0;
    this._job = 0;
    this._waiters = new Map();
    this._prefix = '';
    this.committed = '';
    this.language = 'ja';
    this.device = '';
    this.modelKey = 'tiny';
    this.onTranscript = null;
    this.onStatus = null;
    this._progress = new Map();
  }

  /**
   * @returns {boolean}
   */
  isEnabled() {
    return WhisperLiveText.readEnabled(this._storage());
  }

  /**
   * @returns {string}
   */
  modelPreference() {
    try {
      const value = this._storage().getItem(WhisperLiveText.STORAGE_MODEL);
      return value || 'auto';
    } catch {
      return 'auto';
    }
  }

  /**
   * 設定の保存。録音中の経路切替はしない。
   * @param {boolean} enabled
   * @param {string} [preference]
   */
  saveSettings(enabled, preference) {
    const storage = this._storage();
    try {
      storage.setItem(WhisperLiveText.STORAGE_ENABLED, enabled ? '1' : '0');
      if (preference) storage.setItem(WhisperLiveText.STORAGE_MODEL, preference);
    } catch (error) {
      console.warn('オフラインWhisper設定を保存できません:', error);
    }
    if (!enabled && !this._running) this.release();
  }

  /**
   * クリックの同期区間で AudioContext を作る（iOS は await のあとだと resume が無視される）。
   */
  primeFromUserGesture() {
    if (!this.isEnabled()) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      try {
        this.audioCtx = new Ctx({ sampleRate: WhisperLiveText.SAMPLE_RATE });
      } catch {
        this.audioCtx = new Ctx();
      }
    }
    const pending = this.audioCtx.resume();
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  }

  /**
   * トグルを入れた時点でモデル取得を始める。
   * @returns {Promise<boolean>}
   */
  preload() {
    if (!this.isEnabled() || this._running) return Promise.resolve(false);
    const key = this._pickedKey();
    this.modelKey = key;
    return this._load(key);
  }

  /**
   * @param {string} text
   */
  setPrefix(text) {
    this._prefix = text || '';
  }

  /**
   * @param {'ja'|'en'} language
   */
  setLanguage(language) {
    this.language = language === 'en' ? 'en' : 'ja';
  }

  /**
   * @returns {string}
   */
  getTranscript() {
    return (this.committed || '').trim();
  }

  clearText() {
    this._prefix = '';
    this.committed = '';
    this._emitTranscript('');
  }

  /**
   * @param {boolean} paused
   */
  setPaused(paused) {
    this._paused = !!paused;
    if (!this.audioCtx) return;
    const op = paused ? this.audioCtx.suspend() : this.audioCtx.resume();
    if (op && typeof op.catch === 'function') op.catch(() => {});
  }

  /**
   * @param {MediaStream} stream
   * @returns {Promise<boolean>}
   */
  async start(stream) {
    this._session += 1;
    const session = this._session;
    this._queue = [];
    this._pcm = new Float32Array(0);
    this._since = 0;
    this._paused = false;
    this.committed = this._prefix || '';
    this._running = true;
    this._emitTranscript(this.committed);
    this.modelKey = this._pickedKey();
    const loaded = await this._load(this.modelKey);
    if (!loaded || session !== this._session) {
      if (session === this._session) this._running = false;
      return false;
    }
    try {
      await this._connect(stream);
    } catch (error) {
      console.warn('オフラインWhisperの音声グラフに失敗:', error);
      this._setStatus('音声グラフを開始できません', false);
      this._running = false;
      return false;
    }
    if (session !== this._session) return false;
    this._setStatus(this._readyLabel(), true);
    return true;
  }

  /**
   * マイクを取り直したとき、同じグラフに差し替える。
   * @param {MediaStream} stream
   */
  async attachStream(stream) {
    if (!this._running || !stream) return;
    try {
      await this._connect(stream);
    } catch (error) {
      console.warn('オフラインWhisperの付け直しに失敗:', error);
    }
  }

  /**
   * 残りの発話を待ってからグラフを外す。テキストは残す。
   * @returns {Promise<void>}
   */
  async finish() {
    const session = this._session;
    this._paused = true;
    this._emitWindow(true);
    const deadline = Date.now() + 25000;
    while (session === this._session && (this._busy || this._queue.length) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    this.stopCapture();
  }

  stopCapture() {
    this._running = false;
    this._paused = true;
    if (this._source) {
      try { this._source.disconnect(); } catch { /* 済み */ }
      this._source = null;
    }
    if (this.audioCtx && this.audioCtx.state === 'running') {
      const pending = this.audioCtx.suspend();
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    }
  }

  release() {
    this._session += 1;
    this.stopCapture();
    this._queue = [];
    this._busy = false;
    this._waiters.clear();
    if (this._worklet) {
      try { this._worklet.disconnect(); } catch { /* 済み */ }
      this._worklet = null;
    }
    this._sink = null;
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      const pending = this.audioCtx.close();
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    }
    this.audioCtx = null;
    if (this.worker) {
      try { this.worker.postMessage({ type: 'release' }); } catch { /* 終了済み */ }
      this.worker.terminate();
      this.worker = null;
    }
    this.device = '';
    this._setStatus('', false);
  }

  /**
   * @param {string} key
   * @returns {Promise<boolean>}
   * @private
   */
  _load(key) {
    const info = WhisperLiveText.modelInfo(key);
    this._ensureWorker();
    this._progress.clear();
    this._setStatus(`${info.label} を準備しています`, true);
    return new Promise((resolve) => {
      const session = this._session;
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      const timer = setTimeout(() => {
        this.worker.removeEventListener('message', onMessage);
        this._setStatus('モデルの準備がタイムアウトしました', false);
        finish(false);
      }, 180000);
      const onMessage = (event) => {
        const msg = event.data || {};
        if (msg.type === 'progress') this._noteProgress(info, msg);
        if (msg.type === 'ready' && msg.modelId === info.id) {
          clearTimeout(timer);
          this.device = msg.device || 'wasm';
          this._setStatus(this._readyLabel(), false);
          this.worker.removeEventListener('message', onMessage);
          finish(true);
        }
        if (msg.type === 'error' && !msg.id) {
          clearTimeout(timer);
          this._setStatus(msg.message || 'モデルを読めません', false);
          this.worker.removeEventListener('message', onMessage);
          finish(false);
        }
      };
      this.worker.addEventListener('message', onMessage);
      this.worker.postMessage({ type: 'load', modelId: info.id });
    });
  }

  /**
   * @private
   */
  _ensureWorker() {
    if (this.worker) return;
    const version = WhisperLiveText.CACHE_VERSION;
    const url = new URL(`js/whisper-live-worker.js?v=${version}`, window.location.href);
    this.worker = new Worker(url, { type: 'module' });
    this.worker.onmessage = (event) => this._onWorker(event.data || {});
    this.worker.onerror = (event) => {
      console.warn('オフラインWhisper worker:', event.message || event);
      this._setStatus('推論ワーカーを開始できません', false);
    };
  }

  /**
   * @param {object} msg
   * @private
   */
  _onWorker(msg) {
    if (msg.type === 'progress') {
      this._noteProgress(WhisperLiveText.modelInfo(this.modelKey), msg);
      return;
    }
    if (msg.type === 'status' && msg.text) {
      this._setStatus(msg.text, true);
      return;
    }
    if (msg.type === 'ready') {
      this.device = msg.device || this.device;
      if (!this._running) this._setStatus(this._readyLabel(), false);
      return;
    }
    if (msg.type === 'text' || msg.type === 'error') {
      const waiter = this._waiters.get(msg.id);
      this._waiters.delete(msg.id);
      this._busy = false;
      if (msg.type === 'text' && msg.session === this._session) {
        this.device = msg.device || this.device;
        this.committed = WhisperLiveText.merge(this.committed, msg.text, this.language);
        this._emitTranscript(this.committed);
        const audioSec = msg.samples ? msg.samples / WhisperLiveText.SAMPLE_RATE : 0;
        if (audioSec > 0 && msg.ms) {
          const rtf = (msg.ms / 1000) / audioSec;
          this._setStatus(`${this._readyLabel()} · ${Math.round(msg.ms)}ms / ${audioSec.toFixed(1)}s (RTF ${rtf.toFixed(2)})`, true);
        }
      } else if (msg.type === 'error') {
        this._setStatus(msg.message || '区間の認識に失敗しました', true);
      }
      if (waiter) waiter();
      this._pump();
    }
  }

  /**
   * @param {{ label: string, bytes: number }} info
   * @param {object} msg
   * @private
   */
  _noteProgress(info, msg) {
    if (!msg || msg.status === 'progress') {
      const file = msg.file || 'model';
      this._progress.set(file, {
        loaded: msg.loaded || 0,
        total: msg.total || 0
      });
    }
    let loaded = 0;
    let total = 0;
    this._progress.forEach((row) => {
      loaded += row.loaded || 0;
      total += row.total || 0;
    });
    const denom = total || info.bytes;
    const mb = (n) => (n / (1024 * 1024)).toFixed(0);
    if (msg && msg.status === 'done' && loaded && denom && loaded >= denom * 0.98) {
      this._setStatus(`${info.label} をキャッシュしました`, false);
      return;
    }
    if (denom) this._setStatus(`${info.label} を取得中 ${mb(loaded)} / ${mb(denom)} MB`, true);
  }

  /**
   * @param {MediaStream} stream
   * @private
   */
  async _connect(stream) {
    this.primeFromUserGesture();
    if (!this.audioCtx) throw new Error('AudioContext がありません');
    if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
    if (!this._worklet) {
      const version = WhisperLiveText.CACHE_VERSION;
      const url = new URL(`js/whisper-pcm-worklet.js?v=${version}`, window.location.href);
      await this.audioCtx.audioWorklet.addModule(url);
      this._worklet = new AudioWorkletNode(this.audioCtx, 'whisper-pcm');
      this._worklet.port.onmessage = (event) => this._onPcm(event.data);
      this._sink = this.audioCtx.createGain();
      this._sink.gain.value = 0;
      this._worklet.connect(this._sink);
      this._sink.connect(this.audioCtx.destination);
    }
    if (this._source) {
      try { this._source.disconnect(); } catch { /* 済み */ }
    }
    this._source = this.audioCtx.createMediaStreamSource(stream);
    this._source.connect(this._worklet);
    this._paused = false;
  }

  /**
   * @param {Float32Array} chunk
   * @private
   */
  _onPcm(chunk) {
    if (!this._running || this._paused || !chunk || !chunk.length) return;
    const merged = new Float32Array(this._pcm.length + chunk.length);
    merged.set(this._pcm, 0);
    merged.set(chunk, this._pcm.length);
    this._pcm = merged;
    this._since += chunk.length;
    const hop = WhisperLiveText.SAMPLE_RATE * WhisperLiveText.HOP_SEC;
    if (this._since >= hop) this._emitWindow(false);
  }

  /**
   * @param {boolean} flush
   * @private
   */
  _emitWindow(flush) {
    const rate = WhisperLiveText.SAMPLE_RATE;
    const win = rate * WhisperLiveText.WINDOW_SEC;
    const overlap = rate * (WhisperLiveText.WINDOW_SEC - WhisperLiveText.HOP_SEC);
    const minFlush = rate * WhisperLiveText.MIN_FLUSH_SEC;
    if (!flush && this._since < rate * WhisperLiveText.HOP_SEC) return;
    if (flush && this._since < minFlush) {
      this._since = 0;
      return;
    }
    const hopFrom = Math.max(0, this._pcm.length - this._since);
    const hopAudio = this._pcm.subarray(hopFrom);
    const from = Math.max(0, this._pcm.length - win);
    const window = this._pcm.slice(from);
    const keepFrom = Math.max(0, this._pcm.length - overlap);
    this._pcm = this._pcm.slice(keepFrom);
    this._since = 0;
    if (!WhisperLiveText.chunkIsSpeech(hopAudio)) return;
    this._enqueue(window);
  }

  /**
   * @param {Float32Array} pcm
   * @private
   */
  _enqueue(pcm) {
    this._queue.push({ pcm, session: this._session });
    if (this._queue.length > 2) {
      this._queue.splice(0, this._queue.length - 2);
      this._setStatus('認識が遅れているので古い区間を飛ばしました', true);
    }
    this._pump();
  }

  /**
   * @private
   */
  _pump() {
    if (this._busy || !this._queue.length || !this.worker) return;
    const job = this._queue.shift();
    if (!job || job.session !== this._session) {
      this._pump();
      return;
    }
    this._busy = true;
    const id = ++this._job;
    const info = WhisperLiveText.modelInfo(this.modelKey);
    this._waiters.set(id, () => {});
    this.worker.postMessage({
      type: 'transcribe',
      id,
      session: job.session,
      modelId: info.id,
      language: this.language,
      pcm: job.pcm
    }, [job.pcm.buffer]);
  }

  /**
   * @param {string} text
   * @private
   */
  _emitTranscript(text) {
    if (this.onTranscript) this.onTranscript(text, '');
  }

  /**
   * @returns {string}
   * @private
   */
  _readyLabel() {
    const info = WhisperLiveText.modelInfo(this.modelKey);
    const device = this.device || 'wasm';
    return `オフラインWhisper ${info.key} · ${device}`;
  }

  /**
   * @param {string} text
   * @param {boolean} busy
   * @private
   */
  _setStatus(text, busy) {
    if (this.onStatus) this.onStatus({ text: text || '', busy: !!busy });
  }

  /**
   * @returns {'tiny'|'base'|'small'}
   * @private
   */
  _pickedKey() {
    return WhisperLiveText.pickModel(this.modelPreference(), this._deviceEnv());
  }

  /**
   * @returns {{ ios: boolean, deviceMemory: number }}
   * @private
   */
  _deviceEnv() {
    const ua = navigator.userAgent || '';
    const ios = /iPhone|iPad|iPod/.test(ua)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const mem = typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : 0;
    return { ios, deviceMemory: mem };
  }

  /**
   * @returns {Storage}
   * @private
   */
  _storage() {
    return window.localStorage;
  }
}

if (typeof window !== 'undefined') window.WhisperLive = WhisperLive;
