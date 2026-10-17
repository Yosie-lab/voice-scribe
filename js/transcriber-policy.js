/**
 * VoiceScribe — 音声認識タイミング・監視しきい値
 */
const TranscriberPolicy = {
// -------------------------------------------------------------------------
  // 言語ポリシー。desktop ja の回復は stop()。speechend の abort は戻さない。
  // -------------------------------------------------------------------------

  /**
   * desktop ja-JP のレベル監視。英語と iOS は v57 と同じしきい値。
   * ja の低いしきい値とピークは、死んだ認識の gap だけに使う。
   * 動いている ja はレベルでは abort しない。仮説のあと黙ったら stop() だけ。
   * @param {string} language
   * @param {boolean} ios
   * @returns {{floor: number, abs: number, mult: number, gapMs: number, stallMs: number, resultMs: number, usePeak?: boolean, stallFloor?: number, stallAbs?: number, stallMult?: number}}
   */
  speechWatchProfile(language, ios) {
    if (language === 'ja-JP' && !ios) {
      // gap の初期しきい値は max(0.007, 0.004*2) = 0.008。死んだ認識を 1 回のピークで付け直す。
      // stall は max(0.018, 0.012*3.2)。部屋ノイズのピークでは切らない。
      return {
        floor: 0.004,
        abs: 0.007,
        mult: 2,
        gapMs: 160,
        stallMs: 1600,
        resultMs: 2200,
        usePeak: true,
        stallFloor: 0.012,
        stallAbs: 0.018,
        stallMult: 3.2
      };
    }
    return {
      floor: 0.012,
      abs: 0.018,
      mult: 3.2,
      gapMs: 600,
      stallMs: 2000,
      resultMs: 2500
    };
  }
,

  /**
   * @param {number} level
   * @param {number} floor
   * @param {{abs: number, mult: number}} profile
   * @returns {boolean}
   */
  isSpeechHot(level, floor, profile) {
    return level > Math.max(profile.abs, floor * profile.mult);
  }
,

  /**
   * ピークは死んだ認識の再起動だけに使う。動いている認識を切る判定は EMA と stall しきい値。
   * stallAbs が無いプロファイル（英語・iOS）は gap と同じレベルを stall にも使う。
   * @param {{abs: number, mult: number, usePeak?: boolean, stallAbs?: number, stallMult?: number}} profile
   * @param {number|null} ema
   * @param {number|null} peak
   * @param {number} gapFloor
   * @param {number} stallFloor
   * @returns {{gap: boolean, stall: boolean}}
   */
  speechHotFlags(profile, ema, peak, gapFloor, stallFloor) {
    const usePeak = !!(profile && profile.usePeak && typeof peak === 'number' && !Number.isNaN(peak));
    const gapLevel = usePeak ? peak : ema;
    const gap = typeof gapLevel === 'number' && !Number.isNaN(gapLevel)
      && Transcriber.isSpeechHot(gapLevel, gapFloor, profile);
    const separateStall = !!(profile && profile.stallAbs != null);
    const stallSpec = separateStall
      ? { abs: profile.stallAbs, mult: profile.stallMult }
      : profile;
    const stallBase = separateStall ? stallFloor : gapFloor;
    const stall = typeof ema === 'number' && !Number.isNaN(ema)
      && Transcriber.isSpeechHot(ema, stallBase, stallSpec);
    return { gap: !!gap, stall: !!stall };
  }
,

  /**
   * 再起動までの待ち。desktop は言語で変えない。ja だけ短くすると仮説より先に init() する。
   * iOS は v57 のまま。
   * @param {'no-speech'|'stall'|'end'} kind
   * @param {boolean} isIOS
   * @param {string} [_language] 呼び出し互換。desktop の待ちは言語で変えない。
   * @returns {number}
   */
  restartDelay(kind, isIOS, _language) {
    if (isIOS) {
      if (kind === 'no-speech' || kind === 'stall') return 55;
      return 75;
    }
    if (kind === 'no-speech') return 25;
    if (kind === 'stall') return 30;
    return 35;
  }
,

  /**
   * speechend 後に仮説が無い ja desktop の再起動待ち。これより短いと onresult を落とす。
   */
  jaResultGraceMs: 3000,

  /**
   * 仮説が一度出た desktop ja が、その後結果を足さないとき stop() するまでの待ち。
   * jaResultGraceMs より長く、2.5 秒の stall abort と speechend 900ms の abort より遅い。
   */
  jaStaleStopMs: 4000,

  /**
   * ライブ ja セッションを止めて結果を求めるまでの待ち。2.5 秒の abort は仮説より短い。
   */
  jaLiveStopMs: 8000,

  /**
   * 同じ確定句を再送とみなす窓。
   * desktop ja の stop()+restart は jaStaleStopMs（4.5s）や jaResultGraceMs（3s）だけ空く。
   * 旧 2200ms では、再起動後に Chrome が同じ歌詞の final をもう一度出すと字幕が重複する。
   */
  repeatWindowMs: 22000,

  /**
   * 日本語の確定・暫定をつなぐときに見る最大オーバーラップ（plain 文字）。
   * 24 だと歌詞級の再送で境界が二重になり、字幕が読めなくなる。
   */
  jaOverlapMax: 128,

  /**
   * これより短い自動再起動では「再開」を出さない。iOS の発話ごとの切れ目で点滅させない。
   */
  resumeGapMs: 1200,

  /**
   * iOS onend 〜 scheduled restart。暫定を消さず stall / reattach を抑える。
   */
  iosPhraseGapMs: 1200,

  /**
   * 回復の stop() のあと onend が来ないとき、認識だけ付け直すまでの待ち。
   */
  stopWatchMs: 800,

  /**
   * start() から onstart まで待つ時間。これより早い gap nudge は初回認識を abort する。
   */
  startAckMs: 1200,

  /** iOS は onstart が遅れやすい。再開直後の二重 init を避ける */
  iosStartAckMs: 2200,

  /**
   * onstart のあと一度も仮説が来ない desktop 向け。「再開」と自動復帰の目安。
   */
  captionBootMs: 4200,

  /**
   * iOS は発話ごとに onend があり、最初の仮説まで時間がかかることがある。
   */
  iosCaptionBootMs: 7200,

  /**
   * 仮説のあと結果が途切れたときの字幕停止。jaStaleStopMs と揃える。
   */
  captionStaleMs: 3800,

  /**
   * iOS は発話ごとに onend があり、desktop より早く「止まった」ように見える。
   */
  iosCaptionStaleMs: 3400,

  /** 自動 revive の最短間隔（再開ボタンなし運用） */
  iosAutoReviveMs: 650,

  /** 字幕ヘルスチェック間隔（再開ボタンなし運用） */
  captionHealthPollMs: 250,

  /** 暫定が止まったあと付け直すまで（onstart 待ちとは別） */
  liveAttachStaleMs: 2000,

  /** desktop の reviveLiveCaption 最短間隔 */
  desktopAutoReviveMs: 1200,

  /** isZombieEngine: onstart だけ来て仮説が無い */
  zombieBootDesktopMs: 1800,
  zombieBootIosMs: 2400,

  /** iOS で「再開」を出し始めるまで（確定が動いていない時間） */
  iosResumeOfferMs: 1800,

  /**
   * この回数だけ自動付け直ししたあとは、タップ用の「再開」を出す。
   */
  manualResumeAfterRevives: 2,

  /**
   * iOS だけ発話ごとに終わらせて onend で付け直す。
   * desktop は ja も en も continuous。ja だけ false にすると単発認識になり、
   * 暫定が話しているあいだ来ない（確定は発話終了か、仮説が無いときの stop で届く）。
   * @param {string} _language 呼び出し互換。desktop の continuous は言語で分けない。
   * @param {boolean} ios
   * @returns {boolean}
   */
  useContinuous(_language, ios) {
    return !ios;
  }
,

  /**
   * @param {string} language
   * @param {boolean} ios
   * @returns {boolean}
   */
  useJaLiveWatch(language, ios) {
    return language === 'ja-JP' && !ios;
  }
,

  /**
   * desktop ja のライブセッションは abort しない。無応答が長いときだけ stop。
   * @param {{language: string, ios: boolean, hasInterim: boolean, gotResult: boolean, msSinceStart: number}} state
   * @returns {'none'|'stop'}
   */
  jaLiveRecovery(state) {
    if (!state || state.language !== 'ja-JP' || state.ios) return 'none';
    if (state.hasInterim || state.gotResult) return 'none';
    if (state.msSinceStart >= Transcriber.jaLiveStopMs) return 'stop';
    return 'none';
  }
,

  /**
   * 最初の仮説のあとに黙った desktop ja。stop は結果を求め、abort はしない。
   * 仮説が無いあいだは none（8 秒の jaLiveRecovery が持つ）。
   * 900ms / 2.5 秒では none。
   * @param {{language: string, ios: boolean, gotResult: boolean, msSinceResult: number, msSinceSpeechEnd: number, resultAfterSpeechEnd: boolean}} state
   * @returns {'none'|'stop'}
   */
  jaStaleRecovery(state) {
    if (!state || state.language !== 'ja-JP' || state.ios) return 'none';
    if (!state.gotResult) return 'none';
    const speechEndHung = state.msSinceSpeechEnd >= Transcriber.jaStaleStopMs
      && !state.resultAfterSpeechEnd;
    const stale = state.msSinceResult >= Transcriber.jaStaleStopMs;
    if (speechEndHung || stale) return 'stop';
    return 'none';
  }
,

  /**
   * speechend 後、仮説がまだ無い ja desktop だけ再起動を遅らせる。
   * @param {boolean} isIOS
   * @param {string} language
   * @param {'no-speech'|'stall'|'end'} kind
   * @param {number} lastResultAt
   * @param {number} speechEndedAt
   * @returns {number}
   */
  endRestartDelay(isIOS, language, kind, lastResultAt, speechEndedAt) {
    const waiting = language === 'ja-JP'
      && !isIOS
      && (kind === 'end' || kind === 'no-speech')
      && speechEndedAt > 0
      && !(lastResultAt >= speechEndedAt);
    if (waiting) return Transcriber.jaResultGraceMs;
    return Transcriber.restartDelay(kind, isIOS, language);
  }
,

  /**
   * 上位仮説が空、または尻切れのときだけ別案を採用する。文の書き換えはしない。
   * 言語を渡さない、または英語のときは v57 と同じ規則。
   * @param {SpeechRecognitionResult|Array<{transcript?: string, confidence?: number}>} result
   * @param {string} [language]
   * @returns {string}
   */
};

if (typeof window !== 'undefined') window.TranscriberPolicy = TranscriberPolicy;
if (typeof module !== 'undefined' && module.exports) module.exports = TranscriberPolicy;
