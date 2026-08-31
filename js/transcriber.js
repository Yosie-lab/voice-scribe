/**
 * VoiceScribe — 音声認識（文字起こし）モジュール
 * Web Speech API (webkitSpeechRecognition) を利用したリアルタイム音声文字起こし
 * 句読点（、。）や改行を自然に自動補正するAutoPunctuationエンジンを内蔵
 */

class Transcriber {
  constructor() {
    this.recognition = null;
    this.isListening = false;
    this.shouldRestart = false;
    this.language = 'ja-JP';
    this.finalTranscript = '';
    this.interimTranscript = '';
    this.retryCount = 0;
    this.maxRetries = 10;
    this.retryDelay = 300;

    // 自動改行用のトラッキング
    this.lastParagraphLength = 0;
    this.lastFinalTime = 0;

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
   * 音声認識インスタンスを初期化（毎回フレッシュ生成）
   */
  init() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    // 既存インスタンスの破棄
    if (this.recognition) {
      try {
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

    // 結果受信ハンドラ
    this.recognition.onresult = (event) => {
      this.retryCount = 0;

      let currentInterim = '';
      let currentFinal = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          currentFinal += result[0].transcript;
        } else {
          currentInterim += result[0].transcript;
        }
      }

      if (currentFinal) {
        // 確定テキストを自動句読点・改行フォーマット
        const formattedChunk = this._formatFinalChunk(currentFinal);
        this.finalTranscript = this._appendFormattedChunk(this.finalTranscript, formattedChunk);
      }
      this.interimTranscript = currentInterim;

      if (this.onResult) {
        this.onResult(this.finalTranscript, this.interimTranscript);
      }
    };

    // エラーハンドラ
    this.recognition.onerror = (event) => {
      console.warn('音声認識イベントエラー:', event.error);

      switch (event.error) {
        case 'no-speech':
          if (this.shouldRestart) this._retry();
          break;
        case 'audio-capture':
          if (this.onError) this.onError('マイクにアクセスできません。');
          this.stop();
          break;
        case 'not-allowed':
          if (this.onError) this.onError('マイクの使用が許可されていません。');
          this.stop();
          break;
        case 'network':
          if (this.shouldRestart) this._retry();
          break;
        default:
          if (this.shouldRestart) this._retry();
      }
    };

    // 終了ハンドラ
    this.recognition.onend = () => {
      if (this.shouldRestart && this.isListening) {
        this._retry();
      } else {
        this.isListening = false;
        if (this.onEnd) this.onEnd();
      }
    };
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
      // 1. 文中の読点（、）の自動補正
      text = text
        // 接続詞の後ろに読点を補完
        .replace(/(そして|また|しかし|だけど|ですから|なので|だから|ところで|さて|例えば|なお|ちなみに|要するに|つまり|まず|次に|最後に)(?![、，,\s])/g, '$1、')
        // 長い条件・逆接・理由の接続助詞の後ろに読点を補完
        .replace(/(ので|から|けれど|けれども|けど|たら|なら|ば|ても|ながら|ものの)(?![、，,\s。！？!\?])/g, '$1、');

      // 2. 文末の句点（。）または疑問符（？）の自動補正
      if (!/[。！？!\?]$/.test(text)) {
        // 疑問表現で終わる場合は「？」
        if (/(ですか|ますか|でしょうか|なの|なのか|ですかね|かな|かしら|かい|誰|何|いつ|どこ|なぜ|どうして|どう)$/.test(text)) {
          text += '？';
        } else {
          // 通常の文末表現または文末には「。」
          text += '。';
        }
      }
    } else {
      // 英語（en-US）の自動句読点
      // 文頭を大文字化
      text = text.charAt(0).toUpperCase() + text.slice(1);

      // 接続詞の後ろにカンマ
      text = text.replace(/^(However|Furthermore|Therefore|Moreover|For example|First|Next|Finally|Actually|In addition)(?!,)/i, '$1,');

      // 文末にピリオドまたはクエスチョンマーク
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
   * 既存の文字起こしに新しいチャンクを自然な改行を挟んで結合
   * @param {string} currentText
   * @param {string} newChunk
   * @returns {string}
   * @private
   */
  _appendFormattedChunk(currentText, newChunk) {
    if (!currentText) {
      this.lastParagraphLength = newChunk.length;
      this.lastFinalTime = Date.now();
      return newChunk;
    }

    const now = Date.now();
    const pauseDuration = this.lastFinalTime ? now - this.lastFinalTime : 0;
    this.lastFinalTime = now;

    // 自動改行の判定条件：
    // 1. 直前の段落が60文字以上かつ「。」「？」で終わっている場合
    // 2. または話者が1.5秒以上の長めのポーズを取った場合
    const shouldParagraphBreak =
      (this.lastParagraphLength >= 60 && /[。！？!\?]$/.test(currentText)) ||
      (pauseDuration >= 1500 && /[。！？!\?]$/.test(currentText));

    if (shouldParagraphBreak) {
      this.lastParagraphLength = newChunk.length;
      return `${currentText}\n\n${newChunk}`;
    } else {
      this.lastParagraphLength += newChunk.length;
      // 英語の場合はスペースで結合、日本語はそのまま結合
      const separator = this.language === 'en-US' && !currentText.endsWith('\n') ? ' ' : '';
      return `${currentText}${separator}${newChunk}`;
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

    // iOS Safari必須: 毎回新規インスタンスを生成
    this.init();

    this.finalTranscript = '';
    this.interimTranscript = '';
    this.retryCount = 0;
    this.lastParagraphLength = 0;
    this.lastFinalTime = Date.now();
    this.shouldRestart = true;
    this.isListening = true;

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

    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {
        // すでに停止している場合は無視
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
    this.lastParagraphLength = 0;
    this.lastFinalTime = 0;
  }

  /**
   * 認識停止時の自動再起動
   * @private
   */
  _retry() {
    if (!this.shouldRestart || !this.isListening) return;

    this.retryCount++;
    if (this.retryCount > this.maxRetries) {
      console.warn('最大リトライ回数に達しました');
      this.retryCount = 0;
    }

    setTimeout(() => {
      if (this.shouldRestart && this.isListening) {
        try {
          this.init();
          this.recognition.start();
        } catch (error) {
          console.warn('音声認識リトライ警告:', error);
        }
      }
    }, this.retryDelay);
  }
}

// グローバルエクスポート
window.Transcriber = Transcriber;
