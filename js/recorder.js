/**
 * VoiceScribe — 音声録音モジュール (AudioRecorder)
 * MediaRecorder API によるマイク音声のキャプチャとBlob生成を担当
 */

class AudioRecorder {
  constructor() {
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.segments = [];
    this.stream = null;
    this.state = 'inactive'; // 'inactive' | 'recording' | 'paused'
    this.startTime = null;
    this.pausedDuration = 0;
    this.pauseStartTime = null;
    this.mimeType = '';
    this._userStop = false;
    this._restarting = false;
    this._ensureToken = 0;
    this._ensurePromise = null;

    // コールバック
    this.onError = null;
    this.onInterrupted = null;
  }

  /**
   * サポートされている最適なMIMEタイプを検出
   * @returns {string}
   */
  static getSupportedMimeType() {
    const types = [
      'audio/mp4',
      'audio/aac',
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus'
    ];

    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) {
      return '';
    }

    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    }
    return '';
  }

  /**
   * 録音用マイク。SpeechRecognition は別キャプチャなので、ここを増幅しても
   * 認識入力そのものには乗らない。共有デバイスの AGC / 抑制だけを強める。
   * ideal なので非対応でも getUserMedia は失敗させない。
   * @returns {MediaTrackConstraints}
   */
  static speechAudioConstraints() {
    return {
      echoCancellation: { ideal: true },
      noiseSuppression: { ideal: true },
      autoGainControl: { ideal: true },
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 48000 },
      googAutoGainControl: true,
      googNoiseSuppression: true,
      googHighpassFilter: true,
      googEchoCancellation: true
    };
  }

  /**
   * 音声録音を開始
   * @returns {Promise<MediaStream>}
   */
  async start() {
    try {
      this._userStop = false;
      this._ensureToken++;
      this.segments = [];
      this._configureAudioSession(true);

      this.stream = await this._openMic();

      this.audioChunks = [];
      this.mimeType = AudioRecorder.getSupportedMimeType();
      this._watchStream(this.stream);

      const options = this.mimeType ? { mimeType: this.mimeType } : {};
      this.mediaRecorder = new MediaRecorder(this.stream, options);
      this._attachRecorder(this.mediaRecorder);

      this.mediaRecorder.start(1000);
      this.state = 'recording';
      this.startTime = Date.now();
      this.pausedDuration = 0;
      this.pauseStartTime = null;

      console.log(`音声録音開始 (MIME: ${this.mimeType || 'デフォルト'})`);
      return this.stream;
    } catch (error) {
      console.error('マイクアクセスエラー:', error);
      let message = 'マイクにアクセスできませんでした。';
      if (error.name === 'NotAllowedError') {
        message = 'マイクの使用が許可されていません。設定でマイクを許可してください。';
      } else if (error.name === 'NotFoundError') {
        message = 'マイクが見つかりませんでした。';
      }
      if (this.onError) this.onError(message);
      throw error;
    }
  }

  /**
   * 画面オフで死んだキャプチャを、同じ経過時間・同じチャンク列のまま付け直す。
   * @returns {Promise<MediaStream|null>}
   */
  async ensureCapture() {
    if (this._userStop || this.state === 'inactive') return null;
    if (this._ensurePromise) return this._ensurePromise;
    this._ensurePromise = this._ensureCaptureInner().finally(() => {
      this._ensurePromise = null;
    });
    return this._ensurePromise;
  }

  /**
   * マイクが生きていて MediaRecorder が recording / paused か。
   * @returns {boolean}
   */
  needsRecovery() {
    if (this._userStop || this.state === 'inactive') return false;
    const track = this.stream && this.stream.getAudioTracks()[0];
    const trackLive = !!(track && track.readyState === 'live');
    const rec = this.mediaRecorder;
    if (this.state === 'paused') {
      return !(rec && rec.state === 'paused' && trackLive);
    }
    return !(rec && rec.state === 'recording' && trackLive);
  }

  /**
   * ロック直前に、溜まっているバッファをチャンクへ出す。録音自体は止めない。
   */
  flush() {
    const rec = this.mediaRecorder;
    if (!rec || rec.state !== 'recording' || typeof rec.requestData !== 'function') return;
    try {
      rec.requestData();
    } catch {
      // 未対応、またはすでに停止済み
    }
  }

  /**
   * 録音を一時停止
   * @returns {boolean}
   */
  pause() {
    if (!this.mediaRecorder || this.state !== 'recording') return false;
    if (this.mediaRecorder.state !== 'recording') return false;
    try {
      this.mediaRecorder.pause();
    } catch (error) {
      console.warn('録音の一時停止に失敗:', error);
      return false;
    }
    this.state = 'paused';
    this.pauseStartTime = Date.now();
    return true;
  }

  /**
   * 録音を再開
   * @returns {boolean}
   */
  resume() {
    if (!this.mediaRecorder || this.mediaRecorder.state !== 'paused') return false;
    try {
      this.mediaRecorder.resume();
    } catch (error) {
      console.warn('録音の再開に失敗:', error);
      return false;
    }
    this.state = 'recording';
    if (this.pauseStartTime) {
      this.pausedDuration += Date.now() - this.pauseStartTime;
      this.pauseStartTime = null;
    }
    return true;
  }

  /**
   * 録音を停止し、Blobデータを返す。
   * iOS が先に MediaRecorder を殺していても、それまでのチャンクは捨てない。
   * @returns {Promise<{blob: Blob|null, mimeType: string, duration: number}>}
   */
  async stop() {
    this._userStop = true;
    this._ensureToken++;
    const duration = this.getElapsedTime();
    this._configureAudioSession(false);

    await this._haltRecorder(false);
    this._sealOpenChunks();
    this._cleanupStream();
    this.state = 'inactive';

    const finalized = await this._finalizeBlob();
    console.log(`音声録音停止 (サイズ: ${finalized.blob ? finalized.blob.size : 0} bytes, 時間: ${duration}秒)`);
    return {
      blob: finalized.blob,
      mimeType: finalized.mimeType,
      duration
    };
  }

  /**
   * 経過時間（秒）を取得
   * @returns {number}
   */
  getElapsedTime() {
    if (!this.startTime) return 0;

    let totalElapsed = Date.now() - this.startTime - this.pausedDuration;
    if (this.state === 'paused' && this.pauseStartTime) {
      totalElapsed -= (Date.now() - this.pauseStartTime);
    }

    return Math.max(0, Math.floor(totalElapsed / 1000));
  }

  /**
   * @private
   */
  async _ensureCaptureInner() {
    const token = ++this._ensureToken;
    this._configureAudioSession(true);

    if (this.state === 'paused' && !this.needsRecovery()) return this.stream;
    if (this.state === 'recording' && !this.needsRecovery()) return this.stream;

    await this._haltRecorder(true);
    this._sealOpenChunks();
    if (this._userStop || token !== this._ensureToken) return null;

    const track = this.stream && this.stream.getAudioTracks()[0];
    if (!track || track.readyState !== 'live') {
      this._cleanupStream();
      this.stream = await this._openMic();
      this._watchStream(this.stream);
    }

    if (this._userStop || token !== this._ensureToken) {
      this._cleanupStream();
      return null;
    }

    this.mimeType = this.mimeType || AudioRecorder.getSupportedMimeType();
    const options = this.mimeType ? { mimeType: this.mimeType } : {};
    this.mediaRecorder = new MediaRecorder(this.stream, options);
    this._attachRecorder(this.mediaRecorder);
    if (this._userStop || token !== this._ensureToken) {
      this.mediaRecorder = null;
      this._cleanupStream();
      return null;
    }
    this.mediaRecorder.start(1000);
    if (this.pauseStartTime) {
      this.pausedDuration += Date.now() - this.pauseStartTime;
      this.pauseStartTime = null;
    }
    this.state = 'recording';
    if (!this.startTime) this.startTime = Date.now();
    return this.stream;
  }

  /**
   * @param {boolean} restarting
   * @private
   */
  _haltRecorder(restarting) {
    return new Promise((resolve) => {
      const rec = this.mediaRecorder;
      if (!rec || rec.state === 'inactive') {
        resolve();
        return;
      }
      this._restarting = restarting;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this._restarting = false;
        resolve();
      };
      rec.onstop = finish;
      try {
        if (rec.state === 'recording' && typeof rec.requestData === 'function') {
          rec.requestData();
        }
        rec.stop();
      } catch {
        finish();
      }
    });
  }

  /**
   * @param {MediaRecorder} recorder
   * @private
   */
  _attachRecorder(recorder) {
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        this.audioChunks.push(event.data);
      }
    };
    recorder.onerror = (event) => {
      console.error('MediaRecorder エラー:', event.error);
      if (this.onError) this.onError('録音中にエラーが発生しました。');
    };
    recorder.onstop = () => {
      if (this._userStop || this._restarting) return;
      this._sealOpenChunks();
      if (this.onInterrupted) this.onInterrupted();
    };
  }

  /**
   * @param {MediaStream} stream
   * @private
   */
  _watchStream(stream) {
    const track = stream && stream.getAudioTracks()[0];
    if (!track) return;
    track.onended = () => {
      if (this._userStop || this._restarting) return;
      if (this.state === 'inactive') return;
      if (this.onInterrupted) this.onInterrupted();
    };
  }

  /**
   * @private
   */
  _sealOpenChunks() {
    if (!this.audioChunks.length) return;
    const mime = this.mimeType || this.audioChunks[0].type || 'audio/mp4';
    this.segments.push(new Blob(this.audioChunks, { type: mime }));
    this.audioChunks = [];
  }

  /**
   * @returns {Promise<{blob: Blob|null, mimeType: string}>}
   * @private
   */
  async _finalizeBlob() {
    this._sealOpenChunks();
    const parts = this.segments.filter((blob) => blob && blob.size > 0);
    this.segments = [];
    const fallbackMime = this.mimeType || 'audio/mp4';
    if (parts.length === 0) return { blob: null, mimeType: fallbackMime };
    if (parts.length === 1) return { blob: parts[0], mimeType: parts[0].type || fallbackMime };
    try {
      const wav = await AudioRecorder.concatToWav(parts);
      return { blob: wav, mimeType: 'audio/wav' };
    } catch (error) {
      console.warn('録音セグメントの結合に失敗:', error);
      const largest = parts.reduce((best, blob) => (blob.size > best.size ? blob : best), parts[0]);
      return { blob: largest, mimeType: largest.type || fallbackMime };
    }
  }

  /**
   * ロック前後で MediaRecorder が分かれたとき、再生できる1本の WAV に繋ぐ。
   * @param {Blob[]} blobs
   * @returns {Promise<Blob>}
   */
  static async concatToWav(blobs) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error('AudioContext unavailable');
    const ctx = new AudioContextClass();
    try {
      const buffers = [];
      for (const blob of blobs) {
        const raw = await blob.arrayBuffer();
        buffers.push(await ctx.decodeAudioData(raw.slice(0)));
      }
      const channels = Math.max(...buffers.map((buffer) => buffer.numberOfChannels));
      const rate = buffers[0].sampleRate;
      const length = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
      const merged = ctx.createBuffer(channels, length, rate);
      let offset = 0;
      for (const buffer of buffers) {
        for (let ch = 0; ch < channels; ch++) {
          const src = buffer.getChannelData(Math.min(ch, buffer.numberOfChannels - 1));
          merged.getChannelData(ch).set(src, offset);
        }
        offset += buffer.length;
      }
      return AudioRecorder.encodeWav(merged);
    } finally {
      try {
        await ctx.close();
      } catch {
        // 無視
      }
    }
  }

  /**
   * @param {AudioBuffer} audioBuffer
   * @returns {Blob}
   */
  static encodeWav(audioBuffer) {
    const channels = audioBuffer.numberOfChannels;
    const rate = audioBuffer.sampleRate;
    const length = audioBuffer.length;
    const blockAlign = channels * 2;
    const dataSize = length * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    const channelData = [];
    for (let ch = 0; ch < channels; ch++) channelData.push(audioBuffer.getChannelData(ch));
    let offset = 44;
    for (let i = 0; i < length; i++) {
      for (let ch = 0; ch < channels; ch++) {
        const sample = Math.max(-1, Math.min(1, channelData[ch][i] || 0));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  /**
   * 録音用にマイクを1本だけ開く。認識用の別キャプチャは作らない。
   * 強い制約が拒否されたときだけ、従来の AGC 指定で開き直す。
   * @returns {Promise<MediaStream>}
   * @private
   */
  async _openMic() {
    const advanced = { audio: AudioRecorder.speechAudioConstraints() };
    const basic = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    };
    try {
      const stream = await navigator.mediaDevices.getUserMedia(advanced);
      this._tuneSpeechTrack(stream);
      return stream;
    } catch (error) {
      const name = error && error.name;
      if (name === 'NotAllowedError' || name === 'NotFoundError' || name === 'NotReadableError') throw error;
      const stream = await navigator.mediaDevices.getUserMedia(basic);
      this._tuneSpeechTrack(stream);
      return stream;
    }
  }

  /**
   * ブラウザが AGC を落とていたら、同じトラックへ付け直す。
   * @param {MediaStream} stream
   * @private
   */
  _tuneSpeechTrack(stream) {
    const track = stream && stream.getAudioTracks()[0];
    if (!track || typeof track.applyConstraints !== 'function') return;
    const settings = typeof track.getSettings === 'function' ? track.getSettings() : {};
    const explicitOff = ['autoGainControl', 'noiseSuppression', 'echoCancellation']
      .some((key) => settings[key] === false);
    if (!explicitOff) return;
    track.applyConstraints({
      echoCancellation: { ideal: true },
      noiseSuppression: { ideal: true },
      autoGainControl: { ideal: true },
      channelCount: { ideal: 1 }
    }).catch(() => {});
  }

  /**
   * iOS 16.4+ の audio session。失敗しても録音は続ける。
   * @param {boolean} active
   * @private
   */
  _configureAudioSession(active) {
    const session = navigator.audioSession;
    if (!session) return;
    try {
      session.type = active ? 'play-and-record' : 'auto';
    } catch (error) {
      console.warn('audioSession:', error);
    }
  }

  /**
   * マイクストリームを確実に解放
   * @private
   */
  _cleanupStream() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => {
        track.onended = null;
        track.stop();
      });
      this.stream = null;
    }
  }
}

// グローバルエクスポート
window.AudioRecorder = AudioRecorder;
