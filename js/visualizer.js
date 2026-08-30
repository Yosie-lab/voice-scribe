/**
 * VoiceScribe — 音声波形ビジュアライザー
 * Web Audio APIを使用してリアルタイム波形を描画
 */

class AudioVisualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.audioContext = null;
    this.analyser = null;
    this.source = null;
    this.animationId = null;
    this.dataArray = null;
    this.isActive = false;

    // ビジュアライザー設定（コンパクトなミニ音量バー）
    this.barCount = 7;
    this.barGap = 2.5;
    this.smoothingFactor = 0.7;

    // Canvas解像度の設定
    this._setupCanvas();
    window.addEventListener('resize', () => this._setupCanvas());
  }

  /**
   * Canvas解像度をデバイスピクセル比に合わせて設定
   * @private
   */
  _setupCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.scale(dpr, dpr);
    this.width = rect.width;
    this.height = rect.height;
  }

  /**
   * メディアストリームに接続して解析を開始
   * @param {MediaStream} stream - マイクのMediaStream
   */
  connectStream(stream) {
    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 64;
      this.analyser.smoothingTimeConstant = this.smoothingFactor;

      this.source = this.audioContext.createMediaStreamSource(stream);
      this.source.connect(this.analyser);

      this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
      this.isActive = true;

      this._setupCanvas();
      this._draw();
      console.log('ミニ音量メーター開始');
    } catch (error) {
      console.error('ビジュアライザーエラー:', error);
    }
  }

  /**
   * ビジュアライザーを停止
   */
  disconnect() {
    this.isActive = false;

    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }

    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }

    this._drawIdle();
    console.log('ミニ音量メーター停止');
  }

  /**
   * 波形を描画するメインループ（極小シアンミニレベルメーター）
   * @private
   */
  _draw() {
    if (!this.isActive) return;

    this.animationId = requestAnimationFrame(() => this._draw());

    this.analyser.getByteFrequencyData(this.dataArray);

    this.ctx.clearRect(0, 0, this.width, this.height);

    const totalWidth = this.width;
    const barWidth = Math.max(2, (totalWidth - this.barGap * (this.barCount - 1)) / this.barCount);
    const maxBarHeight = this.height * 0.85;

    for (let i = 0; i < this.barCount; i++) {
      const dataIndex = Math.min(this.dataArray.length - 1, i * 2);
      const rawVal = this.dataArray[dataIndex] / 255;
      const value = Math.max(0.15, rawVal);

      const barHeight = Math.max(3, value * maxBarHeight);
      const x = i * (barWidth + this.barGap);
      const y = (this.height - barHeight) / 2;

      // 洗練されたエレクトリックシアン〜アイスブルーグラデーション
      this.ctx.beginPath();
      this.ctx.roundRect(x, y, barWidth, barHeight, barWidth / 2);
      
      if (rawVal > 0.4) {
        this.ctx.fillStyle = '#00f0ff';
        this.ctx.shadowColor = 'rgba(0, 240, 255, 0.6)';
        this.ctx.shadowBlur = 6;
      } else {
        this.ctx.fillStyle = 'rgba(0, 220, 255, 0.55)';
        this.ctx.shadowBlur = 0;
      }
      this.ctx.fill();
    }
  }

  /**
   * 待機状態の静かなミニバー
   * @private
   */
  _drawIdle() {
    if (!this.width || !this.height) this._setupCanvas();
    this.ctx.clearRect(0, 0, this.width, this.height);

    const barWidth = Math.max(2, (this.width - this.barGap * (this.barCount - 1)) / this.barCount);

    for (let i = 0; i < this.barCount; i++) {
      const x = i * (barWidth + this.barGap);
      const barHeight = 2.5;
      const y = (this.height - barHeight) / 2;

      this.ctx.beginPath();
      this.ctx.roundRect(x, y, barWidth, barHeight, 1);
      this.ctx.fillStyle = 'rgba(0, 220, 255, 0.2)';
      this.ctx.fill();
    }
  }

  /**
   * 待機アニメーション（録音していない時）
   */
  startIdleAnimation() {
    this.isActive = false;

    const drawFrame = () => {
      if (this.isActive) return;
      this._drawIdle();
      this._idleAnimationId = requestAnimationFrame(drawFrame);
    };

    drawFrame();
  }

  /**
   * 待機アニメーションを停止
   */
  stopIdleAnimation() {
    if (this._idleAnimationId) {
      cancelAnimationFrame(this._idleAnimationId);
      this._idleAnimationId = null;
    }
  }

  /**
   * 録音済み音声の波形を静的に描画（詳細画面用）
   * @param {Blob} audioBlob - 音声データ
   * @param {HTMLCanvasElement} targetCanvas - 描画先キャンバス
   */
  static async drawStaticWaveform(audioBlob, targetCanvas) {
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const arrayBuffer = await audioBlob.arrayBuffer();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

      const ctx = targetCanvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const rect = targetCanvas.getBoundingClientRect();
      targetCanvas.width = rect.width * dpr;
      targetCanvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);

      const width = rect.width;
      const height = rect.height;
      const data = audioBuffer.getChannelData(0);
      const step = Math.ceil(data.length / width);
      const centerY = height / 2;

      ctx.clearRect(0, 0, width, height);

      for (let i = 0; i < width; i++) {
        let min = 1.0;
        let max = -1.0;

        for (let j = 0; j < step; j++) {
          const datum = data[i * step + j];
          if (datum < min) min = datum;
          if (datum > max) max = datum;
        }

        const barHeight = Math.max(1, (max - min) * centerY * 0.9);
        const y = centerY - barHeight / 2;

        // グラデーションカラー
        const progress = i / width;
        const hue = 260 + progress * 60;
        const alpha = 0.4 + Math.abs(max - min) * 0.6;

        ctx.fillStyle = `hsla(${hue}, 80%, 60%, ${alpha})`;
        ctx.fillRect(i, y, 1, barHeight);
      }

      audioContext.close();
    } catch (error) {
      console.error('波形描画エラー:', error);
    }
  }
}

// グローバルエクスポート
window.AudioVisualizer = AudioVisualizer;
