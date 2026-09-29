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
    this._expectingStop = false;
    this._lossNotified = false;

    // コールバック
    this.onError = null;
    // OS がマイクを切ったとき（画面ロック、割り込み）。引数は理由文字列。
    this.onCaptureLost = null;
    this.onCaptureMuted = null;
    // ミュート解除などでキャプチャが戻ったとき。
    this.onCaptureResumed = null;
    this._stopPromise = null;
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
      this._expectingStop = false;
      this._lossNotified = false;
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
        this._markCaptureLost('recorder-error');
      };

      // 画面ロックなどで UA が録音を止めたときは、自分から stop() していなくても拾う。
      this.mediaRecorder.onstop = () => {
        this._markCaptureLost('recorder-stop');
      };

      this.stream.getAudioTracks().forEach((track) => {
        track.addEventListener('ended', () => this._markCaptureLost('track-ended'));
        track.addEventListener('mute', () => {
          const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
          const session = navigator.audioSession;
          const interrupted = !!(session && session.state === 'interrupted');
          if ((hidden || interrupted) && this.onCaptureMuted) this.onCaptureMuted();
        });
        track.addEventListener('unmute', () => {
          if (this.onCaptureResumed && this.isCaptureAlive() && !this.isInputMuted()) {
            this.onCaptureResumed();
          }
        });
      });

      // 1秒ごとにチャンクを残す。onstop が来なくてもロック時点までの音声を組み立てられる。
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
  /**
   * 録音を一時停止
   * @returns {boolean} 一時停止できた、または既に paused だった
   */
  pause() {
    if (!this.mediaRecorder) return false;
    const native = this.mediaRecorder.state;
    if (native === 'paused') {
      if (this.state !== 'paused') {
        this.state = 'paused';
        this.pauseStartTime = Date.now();
      }
      return true;
    }
    if (native !== 'recording') return false;
    try {
      this.mediaRecorder.pause();
      this.state = 'paused';
      this.pauseStartTime = Date.now();
      return true;
    } catch (error) {
      console.warn('MediaRecorder pause失敗:', error);
      return false;
    }
  }

  /**
   * 録音を再開
   * @returns {boolean}
   */
  resume() {
    if (!this.mediaRecorder) return false;
    if (this.mediaRecorder.state === 'recording') {
      this._applyNativeRecording();
      return true;
    }
    if (this.mediaRecorder.state !== 'paused') return false;
    try {
      this.mediaRecorder.resume();
      this._applyNativeRecording();
      return true;
    } catch (error) {
      console.warn('MediaRecorder resume失敗:', error);
      return false;
    }
  }

  /**
   * 録音を停止し、Blobデータを返す
   * @returns {Promise<{blob: Blob, mimeType: string, duration: number}>}
   */
  stop() {
    if (this._stopPromise) return this._stopPromise;
    this._expectingStop = true;
    this._stopPromise = this._stopBody().finally(() => {
      this._stopPromise = null;
    });
    return this._stopPromise;
  }

  /**
   * @returns {Promise<{blob: Blob|null, mimeType: string, duration: number}>}
   * @private
   */
  async _stopBody() {
    const duration = this.getElapsedTime();
    const mime = this.mimeType || 'audio/mp4';

    const finish = () => {
      const blob = this._assembleBlob();
      this.audioChunks = [];
      this._cleanupStream();
      this.state = 'inactive';
      console.log(`音声録音停止 (サイズ: ${blob ? blob.size : 0} bytes, 時間: ${duration}秒)`);
      return { blob, mimeType: blob ? blob.type || mime : mime, duration };
    };

    const recorder = this.mediaRecorder;
    if (!recorder || recorder.state === 'inactive') {
      return finish();
    }

    return new Promise((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(finish());
      };

      const timer = setTimeout(() => {
        console.warn('MediaRecorder.stop が完了しなかったため、取得済みチャンクで終了します');
        settle();
      }, 1500);

      recorder.onstop = () => settle();

      try {
        if (recorder.state === 'recording' && typeof recorder.requestData === 'function') {
          recorder.requestData();
        }
      } catch (error) {
        console.warn('MediaRecorder.requestData 失敗:', error);
      }

      try {
        recorder.stop();
      } catch (error) {
        console.warn('MediaRecorder.stop 失敗。取得済みチャンクを返します:', error);
        settle();
      }
    });
  }

  /**
   * OS 割り込みでキャプチャが死んだことを一度だけ通知する。
   * stop() 中の onstop では通知しない。
   * @param {string} reason
   * @private
   */
  _markCaptureLost(reason) {
    if (this._lossNotified || this._expectingStop) return;
    if (this.getNativeState() === 'inactive' && reason !== 'recorder-stop' && reason !== 'track-ended' && reason !== 'recorder-error') {
      return;
    }
    this._lossNotified = true;
    if (this.state === 'paused' && this.pauseStartTime) {
      this.pausedDuration += Date.now() - this.pauseStartTime;
      this.pauseStartTime = null;
    }
    this.state = 'inactive';
    console.warn('録音キャプチャが中断されました:', reason);
    if (this.onCaptureLost) this.onCaptureLost(reason);
  }

  /**
   * @private
   */
  _applyNativeRecording() {
    this.state = 'recording';
    if (this.pauseStartTime) {
      this.pausedDuration += Date.now() - this.pauseStartTime;
      this.pauseStartTime = null;
    }
  }

  /**
   * 溜まったチャンクから Blob を作る。チャンクが無ければ null。
   * @returns {Blob|null}
   * @private
   */
  _assembleBlob() {
    if (!this.audioChunks.length) return null;
    const mime = this.mimeType || this.audioChunks[0].type || 'audio/mp4';
    return new Blob(this.audioChunks, { type: mime });
  }

  /**
   * MediaRecorder の実際の state
   * @returns {'inactive'|'recording'|'paused'}
   */
  getNativeState() {
    if (!this.mediaRecorder) return 'inactive';
    return this.mediaRecorder.state || 'inactive';
  }

  /**
   * マイクがまだ録れているか。画面ロック後に state だけ recording のゾンビを弾く。
   * @returns {boolean}
   */
  isCaptureAlive() {
    const native = this.getNativeState();
    if (native !== 'recording' && native !== 'paused') return false;
    if (!this.stream) return false;
    return this.stream.getAudioTracks().some((track) => track.readyState === 'live');
  }

  /**
   * 入力トラックがすべてミュート、または live でない
   * @returns {boolean}
   */
  isInputMuted() {
    if (!this.stream) return true;
    const tracks = this.stream.getAudioTracks();
    if (!tracks.length) return true;
    return tracks.every((track) => track.muted || track.readyState !== 'live');
  }

  /**
   * UA 側の pause/recording にタイマー用 state を合わせる
   * @returns {'inactive'|'recording'|'paused'}
   */
  syncNativeState() {
    const native = this.getNativeState();
    if (native === 'paused' && this.state !== 'paused') {
      this.state = 'paused';
      this.pauseStartTime = Date.now();
    } else if (native === 'recording' && this.state === 'paused') {
      this._applyNativeRecording();
    } else if (native === 'inactive') {
      this.state = 'inactive';
    }
    return native;
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
