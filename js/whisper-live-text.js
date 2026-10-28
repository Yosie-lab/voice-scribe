/**
 * VoiceScribe — オフライン Whisper のモデル選択とチャンク結合。
 * ブラウザのライブ字幕と node ハーネスの両方から使う。推論はしない。
 *
 * 窓は 4 秒、送りは 3 秒（1 秒重ね）。重ねた日本語は Transcriber.mergeJapaneseOverlap
 * と polishJaCommitted で畳む（PR #13 / #15 と同じ重複除去）。
 */
const WhisperLiveText = {
  CACHE_VERSION: '96',
  SAMPLE_RATE: 16000,
  WINDOW_SEC: 4,
  HOP_SEC: 3,
  MIN_FLUSH_SEC: 0.8,
  /** この RMS 未満のホップは無音として推論しない（tiny の無音ハルシネーション避け） */
  SPEECH_RMS: 0.008,
  STORAGE_ENABLED: 'voicescribe_offline_whisper',
  STORAGE_MODEL: 'voicescribe_offline_whisper_model',
  TRANSFORMERS_VERSION: '3.8.1',
  MODELS: {
    tiny: {
      id: 'onnx-community/whisper-tiny',
      bytes: 45 * 1024 * 1024,
      label: 'tiny（約45MB）'
    },
    base: {
      id: 'onnx-community/whisper-base',
      bytes: 82 * 1024 * 1024,
      label: 'base（約82MB）'
    },
    small: {
      id: 'onnx-community/whisper-small',
      bytes: 255 * 1024 * 1024,
      label: 'small（約255MB）'
    }
  },
  HALLUCINATIONS: [
    'ご視聴ありがとうございました',
    'ご視聴ありがとうございます',
    '字幕視聴ありがとうございました',
    'チャンネル登録よろしくお願いします',
    'ご清聴ありがとうございました',
    '音楽',
    '拍手',
    'thanksforwatching',
    'thankyouforwatching'
  ],

  /**
   * 設定がオンのときだけ Web Speech を止める。未設定はオフ。
   * @param {boolean} enabled
   * @returns {boolean}
   */
  blocksWebSpeech(enabled) {
    return enabled === true;
  },

  /**
   * @param {{ getItem?: (key: string) => string|null }} storage
   * @returns {boolean}
   */
  readEnabled(storage) {
    try {
      return !!(storage && storage.getItem && storage.getItem(this.STORAGE_ENABLED) === '1');
    } catch {
      return false;
    }
  },

  /**
   * @param {string} preference auto | tiny | base | small
   * @param {{ ios?: boolean, deviceMemory?: number }} env
   * @returns {'tiny'|'base'|'small'}
   */
  pickModel(preference, env) {
    const ios = !!(env && env.ios);
    const mem = env && typeof env.deviceMemory === 'number' ? env.deviceMemory : 0;
    const pref = preference || 'auto';
    if (pref === 'tiny') return 'tiny';
    if (pref === 'base') return 'base';
    if (pref === 'small') {
      if (ios) return 'tiny';
      if (mem && mem < 8) return 'base';
      return 'small';
    }
    if (ios) return 'tiny';
    if (mem && mem < 4) return 'tiny';
    return 'base';
  },

  /**
   * @param {'ja-JP'|'en-US'|string} appLanguage
   * @returns {'ja'|'en'}
   */
  whisperLanguage(appLanguage) {
    return appLanguage === 'en-US' ? 'en' : 'ja';
  },

  /**
   * @param {string} key
   * @returns {{ id: string, bytes: number, label: string, key: string }}
   */
  modelInfo(key) {
    const picked = this.MODELS[key] ? key : 'tiny';
    return Object.assign({ key: picked }, this.MODELS[picked]);
  },

  /**
   * @param {ArrayLike<number>} samples
   * @returns {number}
   */
  rms(samples) {
    const n = samples ? samples.length : 0;
    if (!n) return 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const s = samples[i] || 0;
      sum += s * s;
    }
    return Math.sqrt(sum / n);
  },

  /**
   * @param {ArrayLike<number>} samples
   * @returns {boolean}
   */
  chunkIsSpeech(samples) {
    return this.rms(samples) >= this.SPEECH_RMS;
  },

  /**
   * @param {string} text
   * @returns {string}
   */
  plain(text) {
    return (text || '')
      .toLowerCase()
      .replace(/[\s\u3000。、！？!?.,[\]()（）「」『』・…\-]+/g, '');
  },

  /**
   * チャンク全体が無音ハルシネーションの定型だけなら捨てる。文中の語は残す。
   * @param {string} text
   * @returns {boolean}
   */
  isHallucination(text) {
    const folded = this.plain(text);
    if (!folded) return true;
    return this.HALLUCINATIONS.indexOf(folded) !== -1;
  },

  /**
   * @param {string} committed
   * @param {string} incoming
   * @param {'ja'|'en'} [language]
   * @returns {string}
   */
  merge(committed, incoming, language) {
    const lang = language === 'en' ? 'en' : 'ja';
    const right = (incoming || '').replace(/\s+/g, ' ').trim();
    const left = (committed || '').trim();
    if (this.isHallucination(right)) return left;
    if (!right) return left;
    if (!left) return lang === 'ja' ? this.polish(right) : right;
    if (lang === 'en') {
      if (left.endsWith(right)) return left;
      return `${left} ${right}`.replace(/\s+/g, ' ').trim();
    }
    const api = this._jaApi();
    const foldedLeft = this.plain(left);
    const foldedRight = this.plain(right);
    if (foldedRight && foldedLeft.endsWith(foldedRight)) return this.polish(left);
    const overlapped = api.mergeJapaneseOverlap(left, right);
    return this.polish(overlapped || (left + right));
  },

  /**
   * @param {string} text
   * @returns {string}
   */
  polish(text) {
    const api = this._jaApi();
    if (api.polishJaCommitted) return api.polishJaCommitted(text, '');
    return (text || '').trim();
  },

  /**
   * @param {Float32Array|ArrayLike<number>} input
   * @param {number} fromRate
   * @param {number} toRate
   * @returns {Float32Array}
   */
  resampleLinear(input, fromRate, toRate) {
    const src = input || [];
    if (!src.length || !fromRate || !toRate || fromRate === toRate) {
      return src instanceof Float32Array ? src : Float32Array.from(src);
    }
    const ratio = fromRate / toRate;
    const outLen = Math.max(1, Math.floor(src.length / ratio));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const s0 = src[i0] || 0;
      const s1 = src[Math.min(src.length - 1, i0 + 1)] || 0;
      out[i] = s0 + (s1 - s0) * frac;
    }
    return out;
  },

  /**
   * @returns {typeof Transcriber}
   * @private
   */
  _jaApi() {
    if (typeof Transcriber !== 'undefined' && Transcriber.mergeJapaneseOverlap) return Transcriber;
    return require('./transcriber.js');
  }
};

if (typeof window !== 'undefined') window.WhisperLiveText = WhisperLiveText;
if (typeof module !== 'undefined' && module.exports) module.exports = WhisperLiveText;
