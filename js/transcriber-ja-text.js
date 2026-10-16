const TranscriberPolicy = typeof module !== 'undefined'
  ? require('./transcriber-policy.js')
  : (typeof window !== 'undefined' ? window.TranscriberPolicy : {});

function transcriberPolicy() {
  if (typeof Transcriber !== 'undefined') return Transcriber;
  return TranscriberPolicy;
}

/**
 * VoiceScribe — 日本語テキスト確定・重複除去
 */
const TranscriberJaText = {
  pickTranscript(result, language) {
    if (language === 'ja-JP') return TranscriberJaText._pickTranscriptJa(result);
    return TranscriberJaText._pickTranscriptEn(result);
  },
  /**
   * confidence が全て 0 のブラウザ（Chrome に多い）では、順位を信用する。
   * @param {SpeechRecognitionResult|Array<{transcript?: string, confidence?: number}>} result
   * @returns {string}
   */
  _pickTranscriptEn(result) {
    if (!result || !result.length) return '';
    const n = Math.min(result.length, 3);
    let anyConfidence = false;
    for (let i = 0; i < n; i++) {
      const confidence = result[i] && typeof result[i].confidence === 'number' ? result[i].confidence : 0;
      if (confidence > 0) anyConfidence = true;
    }

    if (anyConfidence) {
      let bestText = (result[0] && result[0].transcript) || '';
      let bestScore = -1;
      for (let i = 0; i < n; i++) {
        const alt = result[i];
        if (!alt) continue;
        const text = alt.transcript || '';
        const trimmed = text.trim();
        if (!trimmed) continue;
        const score = alt.confidence + Math.min(trimmed.length, 40) * 0.0008;
        if (score > bestScore) {
          bestScore = score;
          bestText = text;
        }
      }
      return bestText;
    }

    const primary = (result[0] && result[0].transcript) || '';
    const base = primary.trim();
    if (!base) {
      for (let i = 1; i < n; i++) {
        const text = (result[i] && result[i].transcript) || '';
        if (text.trim()) return text;
      }
      return primary;
    }

    for (let i = 1; i < n; i++) {
      const text = (result[i] && result[i].transcript) || '';
      const trimmed = text.trim();
      if (!trimmed.startsWith(base)) continue;
      const rawExtra = trimmed.slice(base.length);
      const extra = rawExtra.trim();
      // 空白や句読点を含む伸びは別文なので採用しない。尻切れの続きだけ足す。
      if (extra && extra.length <= 12 && !/[\s。、！？!?]/.test(rawExtra)) return text;
    }
    return primary;
  },
  /**
   * 日本語は信頼度 0 が多く、早口の続きが 12 字を超える。最長の尻だけ足す。
   * 数字表記（3 / 三）の差では尻を捨てない。空白 1 つだけの区切りはモーラの続きとみなす。
   * @param {SpeechRecognitionResult|Array<{transcript?: string, confidence?: number}>} result
   * @returns {string}
   */
  _pickTranscriptJa(result) {
    if (!result || !result.length) return '';
    const n = Math.min(result.length, 5);
    let anyConfidence = false;
    for (let i = 0; i < n; i++) {
      const confidence = result[i] && typeof result[i].confidence === 'number' ? result[i].confidence : 0;
      if (confidence > 0) anyConfidence = true;
    }

    if (anyConfidence) {
      let bestText = (result[0] && result[0].transcript) || '';
      let bestConf = 0;
      let bestScore = -1;
      const scoreN = Math.min(n, 3);
      for (let i = 0; i < scoreN; i++) {
        const alt = result[i];
        if (!alt) continue;
        const text = alt.transcript || '';
        const trimmed = text.trim();
        if (!trimmed) continue;
        const confidence = typeof alt.confidence === 'number' ? alt.confidence : 0;
        const score = confidence + Math.min(trimmed.length, 40) * 0.0008;
        if (score > bestScore) {
          bestScore = score;
          bestText = text;
          bestConf = confidence;
        }
      }
      return TranscriberJaText._extendJaTail(bestText, result, n, bestConf);
    }

    const primary = (result[0] && result[0].transcript) || '';
    const base = primary.trim();
    if (!base) {
      for (let i = 1; i < n; i++) {
        const text = (result[i] && result[i].transcript) || '';
        if (text.trim()) return text;
      }
      return primary;
    }
    return TranscriberJaText._extendJaTail(primary, result, n, 0);
  },
  /**
   * 漢数字との対応。長さは変えない。
   * @param {string} text
   * @returns {string}
   */
  _foldJaDigits(text) {
    const digits = '〇一二三四五六七八九';
    return (text || '')
      .replace(/[0-9]/g, (ch) => digits[ch.charCodeAt(0) - 48])
      .replace(/[０-９]/g, (ch) => digits[ch.charCodeAt(0) - 0xFF10]);
  },
  /**
   * @param {string} primary
   * @param {SpeechRecognitionResult|Array<{transcript?: string, confidence?: number}>} result
   * @param {number} n
   * @param {number} bestConf
   * @returns {string}
   */
  _extendJaTail(primary, result, n, bestConf) {
    const base = (primary || '').trim();
    if (!base) return primary || '';
    const foldBase = TranscriberJaText._foldJaDigits(base);
    let best = primary;
    let bestExtra = 0;
    for (let i = 1; i < n; i++) {
      const alt = result[i];
      if (!alt) continue;
      const confidence = typeof alt.confidence === 'number' ? alt.confidence : 0;
      if (bestConf > 0 && confidence > 0 && confidence < bestConf - 0.12) continue;
      const trimmed = (alt.transcript || '').trim();
      if (!trimmed) continue;
      const folded = TranscriberJaText._foldJaDigits(trimmed);
      if (!folded.startsWith(foldBase)) continue;
      const rawExtra = trimmed.slice(foldBase.length);
      const extra = rawExtra.trim();
      if (!extra || extra.length > 24) continue;
      if ((rawExtra.match(/[ \t\u3000]/g) || []).length > 1) continue;
      if (!/^[ \t\u3000]*[^ \t\u3000。、！？!?]+$/.test(rawExtra)) continue;
      if (extra.length <= bestExtra) continue;
      bestExtra = extra.length;
      const prefix = trimmed.slice(0, foldBase.length).replace(/[ \t\u3000]+$/g, '');
      best = prefix + extra;
    }
    return best;
  },
  /**
   * 確定チャンクの末尾と次チャンクの頭が同じとき、繰り返したモーラを一度だけ残す。
   * @param {string} left
   * @param {string} right
   * @returns {string}
   */
  mergeJapaneseOverlap(left, right) {
    const a = (left || '').replace(/[。、！？!?\s\u3000]+$/g, '');
    const b = (right || '').replace(/^[。、！？!?\s\u3000]+/, '');
    if (!a || !b) return '';
    const fa = TranscriberJaText._foldJaDigits(a);
    const fb = TranscriberJaText._foldJaDigits(b);
    if (fa === fb) return a;
    const max = Math.min(fa.length, fb.length, transcriberPolicy().jaOverlapMax);
    for (let len = max; len >= 4; len--) {
      if (fa.slice(-len) === fb.slice(0, len)) return a.slice(0, -len) + b;
    }
    // 全文が「えー」「えっと」だけのとき、次が同じ頭なら繰り返さず伸ばす。1文字は「あ」+「明日」になるので足さない。
    if (fa.length >= 2 && fa.length < 4 && fb.startsWith(fa)) return b;
    return '';
  },
  /**
   * 日本語の暫定が確定にならず空になったとき、その暫定を残す。
   * 認識器が返していない語は作らない。1文字の途中結果と、英語の暫定は残さない。
   * @param {string} language
   * @param {string} previousInterim
   * @param {string} currentFinal
   * @param {string} currentInterim
   * @returns {string}
   */
  salvageWipedInterim(language, previousInterim, currentFinal, currentInterim) {
    if (language !== 'ja-JP') return '';
    if ((currentFinal || '').trim()) return '';
    if ((currentInterim || '').trim()) return '';
    const pending = (previousInterim || '').trim();
    if (pending.length < 2) return '';
    return pending;
  },
  /**
   * 日本語の暫定が、別発話の結果に置き換わって isFinal にならなかったとき、前の暫定を残す。
   * 伸び・縮み、頭への補足、同じ区間の書き換え（今日 / きょう）は同じ仮説なので残さない。
   * 暫定の方が長く尻が同じときは、フィラーを残すため暫定を返す。空への置き換えは salvage に任せる。
   * @param {string} language
   * @param {string} previousInterim
   * @param {string} currentFinal
   * @param {string} currentInterim
   * @returns {string}
   */
  keepSupersededInterim(language, previousInterim, currentFinal, currentInterim) {
    if (language !== 'ja-JP') return '';
    const pending = (previousInterim || '').trim();
    if (pending.length < 2) return '';
    const next = `${currentFinal || ''}${currentInterim || ''}`.trim();
    if (!next) return '';
    const foldPending = TranscriberJaText._foldJaDigits(TranscriberJaText._plain(pending));
    const foldNext = TranscriberJaText._foldJaDigits(TranscriberJaText._plain(next));
    if (!foldPending || !foldNext) return '';
    if (foldNext.startsWith(foldPending) || foldPending.startsWith(foldNext)) return '';
    if (foldNext.length > foldPending.length && foldNext.endsWith(foldPending)) return '';
    if (foldPending.length > foldNext.length && foldPending.endsWith(foldNext)) return pending;
    if (TranscriberJaText._sameJaRewrite(foldPending, foldNext)) return '';
    return pending;
  },
  /**
   * 句読点と空白を除いた比較用文字列。
   * @param {string} text
   * @returns {string}
   */
  _plain(text) {
    return (text || '').replace(/[\s\u3000。、！？!?.,]+/g, '');
  },
  /**
   * 連続する共通部分。今日 / きょう のように頭が違う同じ発話を、別文と分ける。
   * @param {string} a
   * @param {string} b
   * @returns {number}
   */
  _lcsLen(a, b) {
    const n = a ? a.length : 0;
    const m = b ? b.length : 0;
    if (!n || !m) return 0;
    let prev = new Array(m + 1).fill(0);
    let best = 0;
    for (let i = 1; i <= n; i++) {
      const cur = new Array(m + 1).fill(0);
      const ai = a[i - 1];
      for (let j = 1; j <= m; j++) {
        if (ai === b[j - 1]) {
          cur[j] = prev[j - 1] + 1;
          if (cur[j] > best) best = cur[j];
        }
      }
      prev = cur;
    }
    return best;
  },
  /**
   * @param {string} foldPending
   * @param {string} foldNext
   * @returns {boolean}
   */
  _sameJaRewrite(foldPending, foldNext) {
    const shorter = Math.min(foldPending.length, foldNext.length);
    if (shorter < 4) return false;
    const shared = TranscriberJaText._lcsLen(foldPending, foldNext);
    return shared >= 4 && shared >= shorter * 0.65;
  },
  /**
   * 確定の尻を繰り返す暫定は、画面にも次の確定にも残さない。
   * 英語は暫定が確定と完全に同じときだけ外す。
   * @param {string} language
   * @param {string} finalText
   * @param {string} interim
   * @returns {string}
   */
  stripEchoInterim(language, finalText, interim) {
    const raw = interim || '';
    const pending = raw.trim();
    if (!pending) return '';
    const committed = (finalText || '').trim();
    if (!committed) return raw;

    if (language !== 'ja-JP') {
      const c = committed.replace(/\s+/g, ' ').trim();
      const i = pending.replace(/\s+/g, ' ').trim();
      if (c === i) return '';
      return raw;
    }

    const foldC = TranscriberJaText._foldJaDigits(TranscriberJaText._plain(committed));
    const foldI = TranscriberJaText._foldJaDigits(TranscriberJaText._plain(pending));
    if (!foldI) return '';
    if (foldC.endsWith(foldI)) return '';
    if (foldI.startsWith(foldC)) return TranscriberJaText._slicePlain(pending, foldC.length);
    const max = Math.min(foldC.length, foldI.length, transcriberPolicy().jaOverlapMax);
    for (let len = max; len >= 4; len--) {
      if (foldC.slice(-len) === foldI.slice(0, len)) return TranscriberJaText._slicePlain(pending, len);
    }
    return raw;
  },
  /**
   * 確定末尾に同じ塊が二重になったとき、外側の繰り返しだけ取る（接頭辞は触らない）。
   * @param {string} text
   * @param {string} [anchorRaw]
   * @returns {string}
   */
  collapseAdjacentJaRepeats(text, anchorRaw) {
    const raw = (text || '').trim();
    if (!raw) return '';
    const anchor = (anchorRaw || '').trim();
    const head = anchor && raw.startsWith(anchor) ? anchor : '';
    let tail = head ? raw.slice(head.length) : raw;
    if (!tail) return raw;
    let norm = TranscriberJaText._foldJaDigits(TranscriberJaText._plain(tail));
    let changed = true;
    while (changed && norm.length >= 16) {
      changed = false;
      const cap = Math.min(Math.floor(norm.length / 2), transcriberPolicy().jaOverlapMax);
      for (let unit = cap; unit >= 8; unit--) {
        if (norm.slice(-unit) !== norm.slice(-2 * unit, -unit)) continue;
        tail = TranscriberJaText._trimLastPlain(tail, unit);
        norm = TranscriberJaText._foldJaDigits(TranscriberJaText._plain(tail));
        changed = true;
        break;
      }
    }
    return head + tail;
  },
  /**
   * 長い確定がほぼ半分ずつ重複（Hermes デモのような塊の再送）を1つに畳む。
   * @param {string} text
   * @param {string} [anchorRaw]
   * @returns {string}
   */
  collapseJaNearHalfDuplicate(text, anchorRaw) {
    const raw = (text || '').trim();
    if (!raw) return '';
    const anchor = (anchorRaw || '').trim();
    const head = anchor && raw.startsWith(anchor) ? anchor : '';
    let tail = head ? raw.slice(head.length) : raw;
    let norm = TranscriberJaText._foldJaDigits(TranscriberJaText._plain(tail));
    if (norm.length < 40) return raw;
    let changed = true;
    while (changed && norm.length >= 40) {
      changed = false;
      const half = Math.floor(norm.length / 2);
      const a = norm.slice(0, half);
      const b = norm.slice(half);
      const shared = TranscriberJaText._lcsLen(a, b);
      if (shared >= half * 0.72) {
        tail = TranscriberJaText._headPlain(tail, half);
        norm = TranscriberJaText._foldJaDigits(TranscriberJaText._plain(tail));
        changed = true;
      }
    }
    return head + tail;
  },
  /**
   * @param {string} text
   * @param {string} [anchorRaw]
   * @returns {string}
   */
  polishJaCommitted(text, anchorRaw) {
    let out = (text || '').trim();
    if (!out) return '';
    out = TranscriberJaText.collapseRepeatedPhrase(out, 'ja-JP');
    out = TranscriberJaText.collapseJaNearHalfDuplicate(out, anchorRaw);
    out = TranscriberJaText.collapseAdjacentJaRepeats(out, anchorRaw);
    out = TranscriberJaText.collapseJaNearHalfDuplicate(out, anchorRaw);
    return out;
  },
  /**
   * @param {string} raw
   * @param {number} plainLen
   * @returns {string}
   */
  _trimLastPlain(raw, plainLen) {
    const trimmed = (raw || '').trim();
    if (!plainLen) return trimmed;
    let counted = 0;
    let i = trimmed.length;
    while (i > 0 && counted < plainLen) {
      i -= 1;
      if (!/[\s\u3000。、！？!?.,]/.test(trimmed[i])) counted += 1;
    }
    return trimmed.slice(0, i).replace(/[\s\u3000。、！？!?.,]+$/g, '');
  },
  /**
   * 句読点を数えずに plainLen 文字進めて、残りを返す。
   * @param {string} raw
   * @param {number} plainLen
   * @returns {string}
   */
  _slicePlain(raw, plainLen) {
    const trimmed = (raw || '').trim();
    let counted = 0;
    let i = 0;
    while (i < trimmed.length && counted < plainLen) {
      if (!/[\s\u3000。、！？!?.,]/.test(trimmed[i])) counted += 1;
      i += 1;
    }
    return trimmed.slice(i).replace(/^[\s\u3000。、！？!?.,]+/, '');
  },
  /**
   * 英語の um / uh だけ外す。日本語のえー / えっと / あのーは残す。
   * @param {string} text
   * @param {string} language
   * @returns {string}
   */
  stripFillers(text, language) {
    if (!text) return '';
    if (language === 'ja-JP') {
      // えー / えっと / あのー は字幕に残す。空白だけ整える。英語の um / uh はこれまで通り外す。
      return text
        .replace(/^[、,\s]+/, '')
        .replace(/[ \t\u3000]{2,}/g, ' ');
    }
    return text
      .replace(/\b(?:um+|uh+)\b[,.]?/gi, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\s+([,.!?])/g, '$1');
  },

  // -------------------------------------------------------------------------
  // 結果の確定。フィラーは残す。空になった暫定は残す。重なったモーラは一度だけ。
  // 同じ句の再送は repeatWindowMs のあいだ足さない。再起動で resultIndex は 0 に戻る。
  // -------------------------------------------------------------------------

  /**
   * 句読点を除いて先頭 plainLen 文字を返す。
   * @param {string} raw
   * @param {number} plainLen
   * @returns {string}
   */
  _headPlain(raw, plainLen) {
    const trimmed = (raw || '').trim();
    let counted = 0;
    let i = 0;
    while (i < trimmed.length && counted < plainLen) {
      if (!/[\s\u3000。、！？!?.,]/.test(trimmed[i])) counted += 1;
      i += 1;
    }
    return trimmed.slice(0, i).replace(/[\s\u3000。、！？!?.,]+$/g, '');
  },
  /**
   * Chrome が歌で同じ句を1つの final に二度入れることがある。全文が同じ単位の繰り返しなら一度にする。
   * 4文字未満の単位（あ、はい）は吃音なので畳まない。
   * @param {string} text
   * @param {string} language
   * @returns {string}
   */
  collapseRepeatedPhrase(text, language) {
    if (language !== 'ja-JP') return text || '';
    const raw = (text || '').trim();
    if (!raw) return '';
    const norm = TranscriberJaText._foldJaDigits(TranscriberJaText._plain(raw));
    if (norm.length < 8) return raw;
    const maxUnit = Math.min(320, Math.floor(norm.length / 2));
    for (let unit = maxUnit; unit >= 4; unit--) {
      if (norm.length % unit !== 0) continue;
      const times = norm.length / unit;
      if (times < 2 || times > 12) continue;
      const piece = norm.slice(0, unit);
      let same = true;
      for (let t = 1; t < times; t++) {
        if (norm.slice(t * unit, (t + 1) * unit) !== piece) {
          same = false;
          break;
        }
      }
      if (!same) continue;
      return TranscriberJaText._headPlain(raw, unit) || raw;
    }
    return raw;
  }
};

if (typeof window !== 'undefined') window.TranscriberJaText = TranscriberJaText;
if (typeof module !== 'undefined' && module.exports) module.exports = TranscriberJaText;
