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

    // ビジュアライザー設定
    this.barCount = 64;
    this.barGap = 2;
    this.smoothingFactor = 0.85;

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
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = this.smoothingFactor;

      this.source = this.audioContext.createMediaStreamSource(stream);
      this.source.connect(this.analyser);

      this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
      this.isActive = true;

      this._draw();
      console.log('ビジュアライザー開始');
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

    // フェードアウトして消去
    this._drawIdle();
    console.log('ビジュアライザー停止');
  }

  /**
   * 波形を描画するメインループ
   * @private
   */
  _draw() {
    if (!this.isActive) return;

    this.animationId = requestAnimationFrame(() => this._draw());

    this.analyser.getByteFrequencyData(this.dataArray);

    // Canvas消去
    this.ctx.clearRect(0, 0, this.width, this.height);

    const centerY = this.height / 2;
    const barWidth = (this.width - this.barGap * (this.barCount - 1)) / this.barCount;
    const maxBarHeight = this.height * 0.8;

    for (let i = 0; i < this.barCount; i++) {
      // 周波数データのインデックスをマッピング
      const dataIndex = Math.floor((i / this.barCount) * this.dataArray.length);
      const value = this.dataArray[dataIndex] / 255;

      const barHeight = Math.max(2, value * maxBarHeight);
      const x = i * (barWidth + this.barGap);
      const y = centerY - barHeight / 2;

      // グラデーションカラー（紫→シアン）
      const hue = 260 + (i / this.barCount) * 60;  // 260（紫）→ 320
      const saturation = 70 + value * 30;
      const lightness = 40 + value * 30;
      const alpha = 0.5 + value * 0.5;

      // バーの角丸描画
      this.ctx.beginPath();
      this.ctx.roundRect(x, y, barWidth, barHeight, barWidth / 2);
      this.ctx.fillStyle = `hsla(${hue}, ${saturation}%, ${lightness}%, ${alpha})`;
      this.ctx.fill();

      // グローエフェクト
      if (value > 0.5) {
        this.ctx.shadowColor = `hsla(${hue}, 100%, 60%, 0.4)`;
        this.ctx.shadowBlur = 8;
        this.ctx.fill();
        this.ctx.shadowBlur = 0;
      }
    }
  }

  /**
   * 待機状態の静かな波形を描画
   * @private
   */
  _drawIdle() {
    this.ctx.clearRect(0, 0, this.width, this.height);

    const centerY = this.height / 2;
    const barWidth = (this.width - this.barGap * (this.barCount - 1)) / this.barCount;

    for (let i = 0; i < this.barCount; i++) {
      const x = i * (barWidth + this.barGap);
      // 微妙な波形を表示
      const wave = Math.sin((i / this.barCount) * Math.PI * 4 + Date.now() * 0.002) * 0.5 + 0.5;
      const barHeight = 2 + wave * 4;
      const y = centerY - barHeight / 2;

      this.ctx.beginPath();
      this.ctx.roundRect(x, y, barWidth, barHeight, barWidth / 2);
      this.ctx.fillStyle = 'rgba(124, 77, 255, 0.15)';
      this.ctx.fill();
    }
  }

  /**
   * 待機アニメーション（録音していない時）
   */
  startIdleAnimation() {
    this.isActive = false; // 録音用のアニメーションを停止

    const drawFrame = () => {
      if (this.isActive) return; // 録音が始まったら停止
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
