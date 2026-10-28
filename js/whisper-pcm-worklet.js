/**
 * VoiceScribe — 既存 MediaStream を 16 kHz mono に落とす。
 * AudioWorklet はモジュールを import できないので、リサンプルはここに閉じる。
 */
class WhisperPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = new Float32Array(48000);
    this.pendingLen = 0;
    this.pos = 0;
    this.out = new Float32Array(1600);
    this.outLen = 0;
    this.ratio = sampleRate / 16000;
  }

  /**
   * @param {number} sample
   * @private
   */
  _emit(sample) {
    this.out[this.outLen++] = sample;
    if (this.outLen < this.out.length) return;
    const full = this.out;
    this.out = new Float32Array(1600);
    this.outLen = 0;
    this.port.postMessage(full, [full.buffer]);
  }

  /**
   * @param {Float32Array[][]} inputs
   * @returns {boolean}
   */
  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels[0]) return true;
    const frames = channels[0].length;
    const nch = channels.length;
    const need = this.pendingLen + frames;
    if (need > this.pending.length) {
      const next = new Float32Array(Math.max(need, this.pending.length * 2));
      next.set(this.pending.subarray(0, this.pendingLen));
      this.pending = next;
    }
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < nch; c++) sum += channels[c][i] || 0;
      this.pending[this.pendingLen++] = sum / nch;
    }
    const ratio = this.ratio > 0 ? this.ratio : 1;
    while (this.pos + 1 < this.pendingLen) {
      const i0 = Math.floor(this.pos);
      const frac = this.pos - i0;
      const s0 = this.pending[i0];
      const s1 = this.pending[i0 + 1];
      this._emit(s0 + (s1 - s0) * frac);
      this.pos += ratio;
    }
    const drop = Math.floor(this.pos);
    if (drop > 0) {
      this.pending.copyWithin(0, drop, this.pendingLen);
      this.pendingLen -= drop;
      this.pos -= drop;
    }
    return true;
  }
}

registerProcessor('whisper-pcm', WhisperPcmProcessor);
