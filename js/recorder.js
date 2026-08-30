/**
 * VoiceScribe — 録音機能（MediaRecorder API）
 * iOS/Android両対応の音声録音を担当
 */

class AudioRecorder {
  constructor() {
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.stream = null;
    this.mimeType = '';
    this.isRecording = false;
    this.isPaused = false;
    this.startTime = 0;
    this.pausedDuration = 0;
    this.pauseStart = 0;

    // コールバック
    this.onDataAvailable = null;
    this.onStop = null;
    this.onError = null;
  }

  /**
   * 対応するMIMEタイプを検出
   * iOS Safariはwebmをサポートしない場合がある
   * @returns {string}
   */
  static detectMimeType() {
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
      'audio/wav'
    ];

    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        console.log(`対応MIMEタイプ: ${type}`);
        return type;
      }
    }
    // フォールバック（デフォルトに任せる）
    console.warn('対応MIMEタイプが見つかりません。デフォルトを使用します。');
    return '';
  }

  /**
   * マイクの権限を取得し、ストリームを初期化
   * @returns {Promise<MediaStream>}
   */
  async initStream() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 44100
        }
      });
      return this.stream;
    } catch (error) {
      console.error('マイクアクセスエラー:', error);
      if (this.onError) this.onError('マイクへのアクセスが拒否されました。設定からマイクの権限を許可してください。');
      throw error;
    }
  }

  /**
   * 録音を開始
   * @returns {Promise<MediaStream>} - ビジュアライザー用にストリームを返す
   */
  async start() {
    if (this.isRecording) return this.stream;

    // ストリームがなければ初期化
    if (!this.stream) {
      await this.initStream();
    }

    this.audioChunks = [];
    this.mimeType = AudioRecorder.detectMimeType();

    const options = {};
    if (this.mimeType) {
      options.mimeType = this.mimeType;
    }

    this.mediaRecorder = new MediaRecorder(this.stream, options);

    // 実際に使用されるMIMEタイプを記録
    this.mimeType = this.mediaRecorder.mimeType;

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.audioChunks.push(event.data);
        if (this.onDataAvailable) this.onDataAvailable(event.data);
      }
    };

    this.mediaRecorder.onstop = () => {
      const audioBlob = new Blob(this.audioChunks, { type: this.mimeType });
      if (this.onStop) this.onStop(audioBlob, this.mimeType);
    };

    this.mediaRecorder.onerror = (event) => {
      console.error('MediaRecorder エラー:', event.error);
      if (this.onError) this.onError('録音中にエラーが発生しました。');
    };

    // 1秒ごとにデータチャンクを取得（より安定した録音のため）
    this.mediaRecorder.start(1000);
    this.isRecording = true;
    this.isPaused = false;
    this.startTime = Date.now();
    this.pausedDuration = 0;

    console.log('録音開始');
    return this.stream;
  }

  /**
   * 録音を停止
   * @returns {Promise<{blob: Blob, mimeType: string}>}
   */
  stop() {
    return new Promise((resolve) => {
      if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        resolve(null);
        return;
      }

      const originalOnStop = this.onStop;
      this.onStop = (blob, mimeType) => {
        this.isRecording = false;
        this.isPaused = false;
        // ストリームを停止
        this.releaseStream();
        if (originalOnStop) originalOnStop(blob, mimeType);
        resolve({ blob, mimeType });
      };

      this.mediaRecorder.stop();
      console.log('録音停止');
    });
  }

  /**
   * 録音を一時停止
   */
  pause() {
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.pause();
      this.isPaused = true;
      this.pauseStart = Date.now();
      console.log('録音一時停止');
    }
  }

  /**
   * 録音を再開
   */
  resume() {
    if (this.mediaRecorder && this.mediaRecorder.state === 'paused') {
      this.mediaRecorder.resume();
      this.isPaused = false;
      this.pausedDuration += Date.now() - this.pauseStart;
      console.log('録音再開');
    }
  }

  /**
   * 経過時間を取得（秒）
   * @returns {number}
   */
  getElapsedTime() {
    if (!this.isRecording) return 0;
    const now = this.isPaused ? this.pauseStart : Date.now();
    return Math.floor((now - this.startTime - this.pausedDuration) / 1000);
  }

  /**
   * メディアストリームを解放
   */
  releaseStream() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
  }

  /**
   * マイク権限の確認
   * @returns {Promise<boolean>}
   */
  static async checkPermission() {
    try {
      const result = await navigator.permissions.query({ name: 'microphone' });
      return result.state === 'granted';
    } catch {
      // permissions API非対応の場合（iOS Safari）
      return false;
    }
  }

  /**
   * MediaRecorder APIの対応確認
   * @returns {boolean}
   */
  static isSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  }
}

// グローバルエクスポート
window.AudioRecorder = AudioRecorder;
