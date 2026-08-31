/**
 * VoiceScribe — 音声録音モジュール (AudioRecorder)
 * MediaRecorder API によるマイク音声のキャプチャとBlob生成を担当
 */

class AudioRecorder {
  constructor() {
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.stream = null;
    this.state = 'inactive'; // 'inactive' | 'recording' | 'paused'
    this.startTime = null;
    this.pausedDuration = 0;
    this.pauseStartTime = null;
    this.mimeType = '';

    // コールバック
    this.onError = null;
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
   * 音声録音を開始
   * @returns {Promise<MediaStream>}
   */
  async start() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      this.audioChunks = [];
      this.mimeType = AudioRecorder.getSupportedMimeType();

      const options = this.mimeType ? { mimeType: this.mimeType } : {};
      this.mediaRecorder = new MediaRecorder(this.stream, options);

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      this.mediaRecorder.onerror = (event) => {
        console.error('MediaRecorder エラー:', event.error);
        if (this.onError) {
          this.onError('録音中にエラーが発生しました。');
        }
      };

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
   * 録音を一時停止
   */
  pause() {
    if (this.mediaRecorder && this.state === 'recording') {
      this.mediaRecorder.pause();
      this.state = 'paused';
      this.pauseStartTime = Date.now();
    }
  }

  /**
   * 録音を再開
   */
  resume() {
    if (this.mediaRecorder && this.state === 'paused') {
      this.mediaRecorder.resume();
      this.state = 'recording';
      if (this.pauseStartTime) {
        this.pausedDuration += Date.now() - this.pauseStartTime;
        this.pauseStartTime = null;
      }
    }
  }

  /**
   * 録音を停止し、Blobデータを返す
   * @returns {Promise<{blob: Blob, mimeType: string, duration: number}>}
   */
  async stop() {
    return new Promise((resolve) => {
      const duration = this.getElapsedTime();

      if (!this.mediaRecorder || this.state === 'inactive') {
        this._cleanupStream();
        resolve({
          blob: null,
          mimeType: this.mimeType || 'audio/mp4',
          duration: duration
        });
        return;
      }

      this.mediaRecorder.onstop = () => {
        const mime = this.mimeType || (this.audioChunks[0] ? this.audioChunks[0].type : 'audio/mp4');
        const blob = this.audioChunks.length > 0
          ? new Blob(this.audioChunks, { type: mime })
          : null;

        this._cleanupStream();
        this.state = 'inactive';

        console.log(`音声録音停止 (サイズ: ${blob ? blob.size : 0} bytes, 時間: ${duration}秒)`);
        resolve({
          blob: blob,
          mimeType: mime,
          duration: duration
        });
      };

      try {
        this.mediaRecorder.stop();
      } catch {
        this._cleanupStream();
        this.state = 'inactive';
        resolve({
          blob: null,
          mimeType: this.mimeType || 'audio/mp4',
          duration: duration
        });
      }
    });
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
   * マイクストリームを確実に解放
   * @private
   */
  _cleanupStream() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
  }
}

// グローバルエクスポート
window.AudioRecorder = AudioRecorder;
