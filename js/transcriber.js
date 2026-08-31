/**
 * VoiceScribe — 音声認識（文字起こし）モジュール (Transcriber)
 * Web Speech API (webkitSpeechRecognition) を利用した高精度リアルタイム文字起こし
 * iOS Safari のマイク競合・暫定テキスト消失・セッション切断を完全に防ぐ高精度エンジン
 */

class Transcriber {
  constructor() {
    this.recognition = null;
    this.isListening = false;
    this.shouldRestart = false;
    this.language = 'ja-JP';
    this.finalTranscript = '';
    this.interimTranscript = '';
    this.lastFinalTime = 0;
    this.isReconnecting = false;
    this.sessionFinalAccumulator = ''; // 現在のセッション内の確定分

    // 暫定テキストの自動コミットタイマー
    this.interimCommitTimer = null;

    // コールバック
    this.onResult = null; // (finalText, interimText) => {}
    this.onError = null;  // (errorMessage) => {}
    this.onEnd = null;    // () => {}
  }

  /**
   * 音声認識の対応状況を確認
   * @returns {{available: boolean, reason: string}}
   */
  static checkAvailability() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      return {
        available: false,
        reason: 'お使いのブラウザは音声認識に対応していません。iOSの場合はSafariでご利用ください。'
      };
    }

    if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') {
      return {
        available: false,
        reason: '音声認識機能を利用するにはHTTPS接続が必要です。'
      };
    }

    return { available: true, reason: '' };
  }

  /**
   * 音声認識インスタンスを初期化（iOS Safari最適化）
   */
  init() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    // 既存インスタンスの完全破棄
    if (this.recognition) {
      try {
        this.recognition.onresult = null;
        this.recognition.onerror = null;
        this.recognition.onend = null;
        this.recognition.abort();
      } catch {
        // 無視
      }
      this.recognition = null;
    }

    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = this.language;
    this.recognition.maxAlternatives = 1;
    this.sessionFinalAccumulator = '';

    // 結果受信ハンドラ（全履歴フルスキャン方式で取りこぼしゼロ）
    this.recognition.onresult = (event) => {
      let sessionFinal = '';
      let sessionInterim = '';

      for (let i = 0; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) {
          sessionFinal += res[0].transcript;
        } else {
          sessionInterim += res[0].transcript;
        }
      }

      // 確定テキストの増分を検出
      if (sessionFinal && sessionFinal !== this.sessionFinalAccumulator) {
        const newPart = sessionFinal.slice(this.sessionFinalAccumulator.length);
        if (newPart.trim()) {
          const formatted = this._formatFinalChunk(newPart);
          this.finalTranscript = this._appendFormattedChunk(this.finalTranscript, formatted);
        }
        this.sessionFinalAccumulator = sessionFinal;
      }

      this.interimTranscript = sessionInterim;

      // 暫定テキスト（interim）が長く滞留した場合のフェイルセーフ自動コミット（1.8秒沈黙で確定へ昇格）
      if (this.interimCommitTimer) {
        clearTimeout(this.interimCommitTimer);
      }
      if (this.interimTranscript && this.interimTranscript.trim().length >= 4) {
        this.interimCommitTimer = setTimeout(() => {
          if (this.isListening && this.interimTranscript && this.interimTranscript.trim()) {
            const saved = this._formatFinalChunk(this.interimTranscript);
            this.finalTranscript = this._appendFormattedChunk(this.finalTranscript, saved);
            this.interimTranscript = '';
            this.sessionFinalAccumulator = '';
            if (this.onResult) {
              this.onResult(this.finalTranscript, '');
            }
          }
        }, 1800);
      }

      if (this.onResult) {
        this.onResult(this.finalTranscript, this.interimTranscript);
      }
    };

    // エラーハンドラ
    this.recognition.onerror = (event) => {
      console.warn('音声認識イベント:', event.error);

      if (event.error === 'not-allowed') {
        if (this.onError) this.onError('マイクの使用が許可されていません。設定をご確認ください。');
        this.stop();
        return;
      }

      if (event.error === 'audio-capture') {
        if (this.onError) this.onError('マイクにアクセスできませんでした。');
        this.stop();
        return;
      }

      // 通常のエラー（no-speech / network / aborted）は即座にKeep-Alive再起動
      if (this.shouldRestart && this.isListening) {
        this._quickReconnect();
      }
    };

    // 終了ハンドラ（セッション終了時に未確定テキストを100%救出）
    this.recognition.onend = () => {
      if (this.interimCommitTimer) {
        clearTimeout(this.interimCommitTimer);
        this.interimCommitTimer = null;
      }

      // 暫定テキストが残っていれば確定テキストへ確実に救出マージ
      if (this.interimTranscript && this.interimTranscript.trim()) {
        const savedChunk = this._formatFinalChunk(this.interimTranscript);
        this.finalTranscript = this._appendFormattedChunk(this.finalTranscript, savedChunk);
        this.interimTranscript = '';
        this.sessionFinalAccumulator = '';
        if (this.onResult) {
          this.onResult(this.finalTranscript, '');
        }
      }

      if (this.shouldRestart && this.isListening) {
        this._quickReconnect();
      } else {
        this.isListening = false;
        if (this.onEnd) this.onEnd();
      }
    };
  }

  /**
   * ゼロ遅延で音声認識を即時再起動（Keep-Alive）
   * @private
   */
  _quickReconnect() {
    if (!this.shouldRestart || !this.isListening || this.isReconnecting) return;

    this.isReconnecting = true;
    setTimeout(() => {
      if (this.shouldRestart && this.isListening) {
        try {
          this.init();
          this.recognition.start();
          console.log('音声認識 Keep-Alive 再接続完了');
        } catch (e) {
          console.warn('Keep-Alive再接続警告:', e);
          setTimeout(() => {
            if (this.shouldRestart && this.isListening) {
              try {
                this.init();
                this.recognition.start();
              } catch (err) {
                // 無視
              }
            }
          }, 80);
        }
      }
      this.isReconnecting = false;
    }, 20);
  }

  /**
   * 確定した発話チャンクに自動で「、」「。」「？」や改行を付与
   * @param {string} rawChunk
   * @returns {string}
   * @private
   */
  _formatFinalChunk(rawChunk) {
    let text = (rawChunk || '').trim();
    if (!text) return '';

    if (this.language === 'ja-JP') {
      // 1. 接続詞の後ろに読点「、」を補完
      text = text.replace(
        /(^|[。！？!\?\n\s])(しかし|また|例えば|そして|ところで|なお|つまり|要するに|まず|次に|最後に|実は|一般的に|基本的に|結果として|一方で|したがって|さらに|ただし|なぜなら|具体的には|ちなみに)(?![、，,\s。！？!\?])/g,
        '$1$2、'
      );

      // 2. 節の接続助詞の後ろに読点「、」を補完
      text = text.replace(
        /(ので|から|けれど|けれども|けど|たら|なら|ば|ても|ながら|ものの)(?![、，,\s。！？!\?])/g,
        '$1、'
      );

      // 3. 過剰読点の整理
      text = text.replace(/、+/g, '、');
      text = text.replace(/([。！？!\?])、/g, '$1');
      text = text.replace(/^、/, '');

      // 4. 文末の句点（。）または疑問符（？）
      if (!/[。！？!\?」』）\)]$/.test(text)) {
        if (/(ですか|ますか|でしょうか|なの|なのか|ですかね|かな|かしら|かい|誰|何|いつ|どこ|なぜ|どうして|どう)$/.test(text)) {
          text += '？';
        } else {
          text += '。';
        }
      }
    } else {
      // 英語（en-US）
      text = text.charAt(0).toUpperCase() + text.slice(1);
      text = text.replace(/^(However|Furthermore|Therefore|Moreover|For example|First|Next|Finally|Actually|In addition)(?!,)/i, '$1,');

      if (!/[.!?]$/.test(text)) {
        if (/^(who|what|when|where|why|how|is|are|do|does|did|can|could|would|should|will|have|has)\b/i.test(text)) {
          text += '?';
        } else {
          text += '.';
        }
      }
    }

    return text;
  }

  /**
   * 既存の文字起こしに新しいチャンクを結合
   * @param {string} currentText
   * @param {string} newChunk
   * @returns {string}
   * @private
   */
  _appendFormattedChunk(currentText, newChunk) {
    if (!currentText || !currentText.trim()) {
      this.lastFinalTime = Date.now();
      return newChunk;
    }

    const trimmedFull = currentText.trimEnd();
    const now = Date.now();
    const pauseDuration = this.lastFinalTime ? now - this.lastFinalTime : 0;
    this.lastFinalTime = now;

    // 現在の段落を取得
    const paragraphs = trimmedFull.split(/\n\s*\n/);
    const lastParagraph = paragraphs[paragraphs.length - 1] || '';
    const sentenceCount = (lastParagraph.match(/[。！？!\?]/g) || []).length;
    const lastParaLength = lastParagraph.length;

    // 2〜4文（100〜150文字程度）または長めのポーズで空行段落分け
    const shouldParagraphBreak =
      (sentenceCount >= 3 && lastParaLength >= 90) ||
      lastParaLength >= 140 ||
      (pauseDuration >= 1400 && /[。！？!\?」』）\)]$/.test(trimmedFull));

    if (shouldParagraphBreak && /[。！？!\?」』）\)]$/.test(trimmedFull)) {
      return `${trimmedFull}\n\n${newChunk}`;
    } else if (/[。！？!\?」』）\)]$/.test(trimmedFull)) {
      return `${trimmedFull}\n${newChunk}`;
    } else {
      const sep = this.language === 'en-US' ? ' ' : '';
      return `${trimmedFull}${sep}${newChunk}`;
    }
  }

  /**
   * 言語を設定
   * @param {'ja-JP'|'en-US'} lang
   */
  setLanguage(lang) {
    this.language = lang;
    if (this.recognition) {
      this.recognition.lang = lang;
    }
  }

  /**
   * 文字起こしを開始（タップ直後に即座に同期起動）
   * @returns {boolean}
   */
  start() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      if (this.onError) this.onError('このブラウザは音声認識に対応していません。Safariで開いてください。');
      return false;
    }

    this.init();

    this.finalTranscript = '';
    this.interimTranscript = '';
    this.sessionFinalAccumulator = '';
    this.lastFinalTime = Date.now();
    this.shouldRestart = true;
    this.isListening = true;
    this.isReconnecting = false;

    try {
      this.recognition.start();
      console.log(`音声文字起こし開始 (${this.language})`);
      return true;
    } catch (error) {
      console.warn('文字起こしstart警告:', error);
      if (error.name === 'InvalidStateError') {
        return true;
      }
      this.isListening = false;
      return false;
    }
  }

  /**
   * 文字起こしを停止
   */
  stop() {
    this.shouldRestart = false;
    this.isListening = false;
    this.isReconnecting = false;

    if (this.interimCommitTimer) {
      clearTimeout(this.interimCommitTimer);
      this.interimCommitTimer = null;
    }

    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {
        // 無視
      }
    }
    console.log('音声文字起こし停止');
  }

  /**
   * 現在の文字起こしテキストを取得（確定テキスト＋暫定テキストを合成・整形）
   * @returns {string}
   */
  getFullTranscript() {
    const final = (this.finalTranscript || '').trim();
    let interim = (this.interimTranscript || '').trim();

    if (interim) {
      interim = this._formatFinalChunk(interim);
    }

    if (final && interim) {
      const sep = this.language === 'en-US' ? ' ' : '';
      return `${final}${sep}${interim}`;
    }
    return final || interim || '';
  }

  /**
   * テキストをリセット
   */
  reset() {
    this.finalTranscript = '';
    this.interimTranscript = '';
    this.sessionFinalAccumulator = '';
    this.lastFinalTime = 0;
  }
}

// グローバルエクスポート
window.Transcriber = Transcriber;
