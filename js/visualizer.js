/**
 * VoiceScribe — 音声ビジュアライザー (AudioVisualizer)
 * Web Audio API (AnalyserNode) を使用したリアルタイム波形描画および静的波形描画
 */

class AudioVisualizer {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
    this.audioCtx = null;
    this.analyser = null;
    this.source = null;
    this.animationId = null;
    this.idleAnimationId = null;
    this.dataArray = null;

    if (this.canvas) {
      this._setupHiDPI();
    }
  }

  /**
   * Retinaディスプレイ対応の高解像度スケーリング
   * @private
   */
  _setupHiDPI() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const width = rect.width || 300;
    const height = rect.height || 60;

    this.canvas.width = width * dpr;
    this.canvas.height = height * dpr;
    if (this.ctx) {
      this.ctx.scale(dpr, dpr);
    }
    this.displayWidth = width;
    this.displayHeight = height;
  }

  /**
   * マイクストリームを接続してリアルタイム波形描画を開始
   * @param {MediaStream} stream
   */
  async connectStream(stream) {
    try {
      this.disconnect();

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;

      this.audioCtx = new AudioContextClass();
      if (this.audioCtx.state === 'suspended') {
        await this.audioCtx.resume();
      }

      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.8;

      this.source = this.audioCtx.createMediaStreamSource(stream);
      this.source.connect(this.analyser);

      const bufferLength = this.analyser.frequencyBinCount;
      this.dataArray = new Uint8Array(bufferLength);

      this._draw();
    } catch (error) {
      console.warn('ビジュアライザー接続警告:', error);
    }
  }

  /**
   * リアルタイム波形を描画
   * @private
   */
  _draw() {
    if (!this.analyser || !this.ctx) return;

    this.animationId = requestAnimationFrame(() => this._draw());
    this.analyser.getByteFrequencyData(this.dataArray);

    const width = this.displayWidth || 300;
    const height = this.displayHeight || 60;

    this.ctx.clearRect(0, 0, width, height);

    const barCount = 32;
    const barWidth = (width / barCount) * 0.65;
    const gap = (width / barCount) * 0.35;
    const step = Math.floor(this.dataArray.length / barCount);

    for (let i = 0; i < barCount; i++) {
      const value = this.dataArray[i * step] || 0;
      const percent = value / 255;
      const barHeight = Math.max(3, percent * (height - 8));
      const x = i * (barWidth + gap) + gap / 2;
      const y = (height - barHeight) / 2;

      // ネオンシアンのグラデーションバー
      const gradient = this.ctx.createLinearGradient(0, y, 0, y + barHeight);
      gradient.addColorStop(0, '#00f0ff');
      gradient.addColorStop(1, '#0070f3');

      this.ctx.fillStyle = gradient;
      this.ctx.beginPath();
      this.ctx.roundRect(x, y, barWidth, barHeight, 2);
      this.ctx.fill();
    }
  }

  /**
   * アイドル状態の波形アニメーション（穏やかな波）
   */
  startIdleAnimation() {
    this.stopIdleAnimation();
    if (!this.ctx) return;

    let phase = 0;
    const drawIdle = () => {
      this.idleAnimationId = requestAnimationFrame(drawIdle);
      phase += 0.03;

      const width = this.displayWidth || 300;
      const height = this.displayHeight || 60;

      this.ctx.clearRect(0, 0, width, height);

      const barCount = 28;
      const barWidth = (width / barCount) * 0.6;
      const gap = (width / barCount) * 0.4;

      for (let i = 0; i < barCount; i++) {
        const sinVal = Math.sin(phase + (i * 0.35));
        const barHeight = 4 + Math.abs(sinVal) * 8;
        const x = i * (barWidth + gap) + gap / 2;
        const y = (height - barHeight) / 2;

        this.ctx.fillStyle = 'rgba(0, 240, 255, 0.25)';
        this.ctx.beginPath();
        this.ctx.roundRect(x, y, barWidth, barHeight, 2);
        this.ctx.fill();
      }
    };

    drawIdle();
  }

  /**
   * アイドルアニメーションを停止
   */
  stopIdleAnimation() {
    if (this.idleAnimationId) {
      cancelAnimationFrame(this.idleAnimationId);
      this.idleAnimationId = null;
    }
  }

  /**
   * ビジュアライザーを切断・リソース解放
   */
  disconnect() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    this.stopIdleAnimation();

    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        // 無視
      }
      this.source = null;
    }

    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      try {
        this.audioCtx.close();
      } catch {
        // 無視
      }
      this.audioCtx = null;
    }

    if (this.ctx) {
      this.ctx.clearRect(0, 0, this.displayWidth || 300, this.displayHeight || 60);
    }
  }

  /**
   * 静的波形を描画（詳細画面のプレイヤー波形用）
   * @param {Blob} audioBlob
   * @param {HTMLCanvasElement} canvas
   */
  static async drawStaticWaveform(audioBlob, canvas) {
    if (!canvas || !audioBlob) return;

    try {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const width = rect.width || 300;
      const height = rect.height || 60;

      canvas.width = width * dpr;
      canvas.height = height * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);

      const arrayBuffer = await audioBlob.arrayBuffer();
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioContextClass();
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      audioCtx.close();

      const rawData = audioBuffer.getChannelData(0);
      const samples = 48;
      const blockSize = Math.floor(rawData.length / samples);
      const filteredData = [];

      for (let i = 0; i < samples; i++) {
        let blockStart = blockSize * i;
        let sum = 0;
        for (let j = 0; j < blockSize; j++) {
          sum += Math.abs(rawData[blockStart + j] || 0);
        }
        filteredData.push(sum / blockSize);
      }

      const maxVal = Math.max(...filteredData) || 1;
      const barWidth = (width / samples) * 0.65;
      const gap = (width / samples) * 0.35;

      ctx.clearRect(0, 0, width, height);

      for (let i = 0; i < samples; i++) {
        const normalized = filteredData[i] / maxVal;
        const barHeight = Math.max(3, normalized * (height - 10));
        const x = i * (barWidth + gap) + gap / 2;
        const y = (height - barHeight) / 2;

        const gradient = ctx.createLinearGradient(0, y, 0, y + barHeight);
        gradient.addColorStop(0, '#00f0ff');
        gradient.addColorStop(1, '#0070f3');

        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.roundRect(x, y, barWidth, barHeight, 2);
        ctx.fill();
      }
    } catch (e) {
      console.warn('静的波形描画フォールバック:', e);
      // 簡易波形フォールバック
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = 'rgba(0, 240, 255, 0.4)';
        ctx.fillRect(0, canvas.height / 2 - 2, canvas.width, 4);
      }
    }
  }
}

// グローバルエクスポート
window.AudioVisualizer = AudioVisualizer;
