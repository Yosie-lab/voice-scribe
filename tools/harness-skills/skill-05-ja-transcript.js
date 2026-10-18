'use strict';

const { hypothesis, countSpan, paintOf } = require('./_util');

/** 必須5: 日本語ライブ字幕の重複・書き換え・接続 */
module.exports = {
  id: '05-ja-transcript',
  name: '日本語ライブ字幕品質（重複抑制）',
  run(ctx) {
    const { transcriberSrc, Transcriber, assert } = ctx;

    assert(transcriberSrc.includes('polishJaCommitted'), 'long ja repeats are polished');
    assert(transcriberSrc.includes('jaOverlapMax'), 'long ja overlap cap is named');
    assert(transcriberSrc.includes('collapseAdjacentJaRepeats'), 'adjacent ja repeats collapse after commit');
    assert(transcriberSrc.includes('_cleanLiveInterim'), 'interim repeat uses the commit dedupe window');
    assert(transcriberSrc.includes('setContinuedPrefix'), 'resume prefix is excluded from dedupe anchor');

    const kanaRewrite = paintOf(Transcriber, 'ja-JP', [
      { resultIndex: 0, results: [hypothesis('今日はいい天気ですね', false)] },
      { resultIndex: 0, results: [hypothesis('きょうはいい天気ですね', false)] },
      { resultIndex: 0, results: [hypothesis('今日はいい天気ですね', true)] }
    ]);
    assert(countSpan(kanaRewrite.shown, '今日はいい天気ですね') === 1, 'kana rewrite commits the span once');

    const echoInterim = paintOf(Transcriber, 'ja-JP', [
      { resultIndex: 0, results: [hypothesis('今日はいい天気ですね', true), hypothesis('今日はいい天気ですね', false)] }
    ]);
    assert(countSpan(echoInterim.shown, '今日はいい天気ですね') === 1, 'echo interim does not double the caption');

    const LINE = '桜の花びらが舞う夜に私は静かに歌い続けているよ今夜も';
    const burst = new Transcriber();
    burst.language = 'ja-JP';
    for (let i = 0; i < 8; i++) burst._appendFinal(LINE);
    assert(countSpan(burst.finalTranscript, LINE) === 1, 'identical long finals in a row stay one line');

    return { ok: true };
  }
};
