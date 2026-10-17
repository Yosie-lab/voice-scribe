/**
 * Client-only before/after for Japanese live Web Speech handling.
 * Does not call Chrome SpeechRecognition and does not invent live ASR transcripts.
 *
 *   node tools/ja-live-speech-harness.js
 */

const fs = require('fs');
const path = require('path');

global.window = global;
global.navigator = {
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36',
  platform: 'Linux',
  maxTouchPoints: 0
};
global.document = { visibilityState: 'visible' };

const Transcriber = require('../js/transcriber.js');
const AudioRecorder = require('../js/recorder.js');

const QUIET = '今日はいい天気ですね';
const FAST = '明日の会議は三時から開始で資料は事前に共有してください';
const FAST_HEAD = '明日の会議は三時から開始で';

let failed = 0;
const rows = [];

function assert(cond, message) {
  if (!cond) {
    failed += 1;
    console.error('FAIL:', message);
  }
}

function record(name, before, after) {
  rows.push({ name, before, after, changed: before !== after });
  console.log(`\n## ${name}`);
  console.log('before:', JSON.stringify(before));
  console.log('after: ', JSON.stringify(after));
}

function pickV57(result) {
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
    if (extra && extra.length <= 12 && !/[\s。、！？!?]/.test(rawExtra)) return text;
  }
  return primary;
}

function stripV57(text, language) {
  if (!text) return '';
  if (language === 'ja-JP') {
    return text
      .replace(/えー+っと|えーっと|えーと|えっと|あのー+|あの〜+|そのー+|その〜+/g, '')
      .replace(/^[、,\s]+/, '')
      .replace(/[ \t\u3000]{2,}/g, ' ');
  }
  return text
    .replace(/\b(?:um+|uh+)\b[,.]?/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.!?])/g, '$1');
}

function punctV57(text) {
  if (!text) return '';
  let res = text;
  res = res
    .replace(/(?:^|[\s\u3000])(?:まる|くてん|ピリオド)(?:[\s\u3000]|$)/g, '。')
    .replace(/(?:^|[\s\u3000])(?:てん|とうてん|コンマ)(?:[\s\u3000]|$)/g, '、')
    .replace(/(?:^|[\s\u3000])(?:かいぎょう|改行)(?:[\s\u3000]|$)/g, '\n');
  const endPatterns = /(?:です|ます|でした|ません|でしたら|ください|ですね|でしょうか|思います|あります|おります|いたします|となります|なりました|行います|始めます)$/;
  if (endPatterns.test(res) && !/[。、！？!?\n]$/.test(res)) res += '。';
  const commaPatterns = /(?:ですが|ので|から|けれど|けれども|そして|また|しかし|ただし|なお|ですが)$/;
  if (commaPatterns.test(res) && !/[。、！？!?\n]$/.test(res)) res += '、';
  return res.replace(/。+/g, '。').replace(/、+/g, '、').replace(/、。/g, '。');
}

function joinV57(language, base, next) {
  const b = (next || '').trim();
  if (!b) return base || '';
  const a = base || '';
  if (!a.trim()) return b;
  if (language === 'en-US') {
    if (/\s$/.test(a) || /^[,.!?)]/.test(b)) return a + b;
    return `${a.replace(/\s+$/, '')} ${b}`;
  }
  return a.replace(/[ \t]+$/g, '') + b;
}

function appendV57(language, chunks) {
  let finalText = '';
  chunks.forEach((raw) => {
    let next = stripV57(raw, language).trim();
    if (!next) return;
    if (language === 'ja-JP') next = punctV57(next);
    if (!next.trim()) return;
    finalText = joinV57(language, finalText, next);
  });
  return finalText;
}

function appendNow(language, chunks) {
  const t = new Transcriber();
  t.language = language;
  chunks.forEach((raw) => t._appendFinal(raw));
  return t.finalTranscript;
}

function hotV57(level, floor) {
  return level > Math.max(0.018, floor * 3.2);
}

const quietSpace = [
  { transcript: '今日はいい天気', confidence: 0 },
  { transcript: '今日はいい天気 ですね', confidence: 0 }
];
const quietConf = [
  { transcript: '今日はいい天気です', confidence: 0.62 },
  { transcript: '今日はいい天気ですね', confidence: 0.55 }
];
const fastTail = [
  { transcript: FAST_HEAD, confidence: 0 },
  { transcript: '明日の会議は三時から', confidence: 0 },
  { transcript: FAST, confidence: 0 }
];
const fastDigits = [
  { transcript: '明日の会議は3時から開始で', confidence: 0 },
  { transcript: FAST, confidence: 0 }
];
const fastFifth = [
  { transcript: ' ', confidence: 0 },
  { transcript: '', confidence: 0 },
  { transcript: '', confidence: 0 },
  { transcript: '', confidence: 0 },
  { transcript: QUIET, confidence: 0 }
];
const lowConfOther = [
  { transcript: QUIET, confidence: 0.8 },
  { transcript: '明日の会議は三時から開始で資料は事前に共有してくださいね', confidence: 0.4 }
];

record('quiet space-separated tail', pickV57(quietSpace), Transcriber.pickTranscript(quietSpace, 'ja-JP'));
assert(
  Transcriber.pickTranscript(quietSpace, 'ja-JP') === '今日はいい天気ですね',
  'quiet space tail'
);

record('quiet close-confidence particle', pickV57(quietConf), Transcriber.pickTranscript(quietConf, 'ja-JP'));
assert(Transcriber.pickTranscript(quietConf, 'ja-JP') === QUIET, 'quiet confidence particle');

record('fast tail longer than 12', pickV57(fastTail), Transcriber.pickTranscript(fastTail, 'ja-JP'));
assert(Transcriber.pickTranscript(fastTail, 'ja-JP') === FAST, 'fast tail');
assert(pickV57(fastTail) === FAST_HEAD, 'v57 keeps the short head');

record('fast digit fold 3/三', pickV57(fastDigits), Transcriber.pickTranscript(fastDigits, 'ja-JP'));
assert(Transcriber.pickTranscript(fastDigits, 'ja-JP') === FAST, 'digit fold');

record('blank top falls through to 5th', pickV57(fastFifth), Transcriber.pickTranscript(fastFifth, 'ja-JP'));
assert(Transcriber.pickTranscript(fastFifth, 'ja-JP') === QUIET, '5th alt');
assert(Transcriber.pickTranscript(fastFifth, 'en-US') === pickV57(fastFifth), 'english ignores 5th');

record(
  'do not take a low-confidence different sentence',
  pickV57(lowConfOther),
  Transcriber.pickTranscript(lowConfOther, 'ja-JP')
);
assert(Transcriber.pickTranscript(lowConfOther, 'ja-JP') === QUIET, 'low confidence rewrite');

const farTail = [
  { transcript: '今日はいい天気です', confidence: 0.9 },
  { transcript: '今日はいい天気ですね余計な文です', confidence: 0.5 }
];
const punctTail = [
  { transcript: '今日はいい天気です', confidence: 0 },
  { transcript: '今日はいい天気です。明日は雨', confidence: 0 }
];
assert(Transcriber.pickTranscript(farTail, 'ja-JP') === '今日はいい天気です', 'far confidence tail blocked');
assert(Transcriber.pickTranscript(punctTail, 'ja-JP') === '今日はいい天気です', 'punctuation starts a new sentence');
record('far confidence tail blocked', pickV57(farTail), Transcriber.pickTranscript(farTail, 'ja-JP'));

const fastChunks = ['明日の会議は三時から', '三時から開始で資料は事前に共有してください'];
record('fast chunks overlap', appendV57('ja-JP', fastChunks), appendNow('ja-JP', fastChunks));
assert(
  appendNow('ja-JP', fastChunks) === '明日の会議は三時から開始で資料は事前に共有してください。',
  'fast chunk merge'
);
assert(
  appendV57('ja-JP', fastChunks).includes('三時から、三時から'),
  'v57 duplicated the time phrase and inserted a comma'
);

record(
  'quiet phrase punctuation',
  appendV57('ja-JP', ['えーと今日はいい天気ですね']),
  appendNow('ja-JP', ['えーと今日はいい天気ですね'])
);
assert(appendNow('ja-JP', ['えーと今日はいい天気ですね']) === 'えーと今日はいい天気ですね。', 'quiet filler kept');
assert(appendV57('ja-JP', ['えーと今日はいい天気ですね']) === '今日はいい天気ですね。', 'v57 deleted えーと');

record(
  'demonstrative kept',
  appendV57('ja-JP', ['あのー資料は事前に共有してください']),
  appendNow('ja-JP', ['あのー資料は事前に共有してください'])
);
assert(
  appendNow('ja-JP', ['あのー資料は事前に共有してください']) === 'あのー資料は事前に共有してください。',
  'あのー stays elongated'
);
assert(
  appendV57('ja-JP', ['あのー資料は事前に共有してください']) === '資料は事前に共有してください。',
  'v57 deleted あの'
);

record(
  'english fillers and join',
  appendV57('en-US', ['um hello', 'there']),
  appendNow('en-US', ['um hello', 'there'])
);
assert(appendNow('en-US', ['um hello', 'there']) === 'hello there', 'english join');
assert(appendV57('en-US', ['um hello', 'there']) === 'hello there', 'english v57 same');

const fillers = ['えー', 'あの', 'えっと', 'えーと', 'えーっと', 'あのー', 'そのー', 'ええと'];
fillers.forEach((word) => {
  assert(appendNow('ja-JP', [word]) === word, `short filler kept: ${word}`);
});
assert(appendV57('ja-JP', ['えっと']) === '', 'v57 drops a standalone えっと');
assert(appendV57('ja-JP', ['あのー']) === '', 'v57 drops a standalone あのー');
assert(appendNow('ja-JP', ['えっと', 'えっと確認します']) === 'えっと確認します。', 'short final extends');
assert(
  appendNow('ja-JP', ['資料を送ります', 'えっと', 'えっと確認します']) === '資料を送ります。えっと確認します。',
  'filler between phrases is kept once'
);
assert(appendNow('ja-JP', ['あ', '明日は晴れです']) === 'あ明日は晴れです。', 'one-mora partial is not merged away');
assert(appendNow('en-US', ['um']) === '', 'english um still stripped');
assert(appendNow('en-US', ['uh hello']) === 'hello', 'english uh still stripped');

assert(Transcriber.salvageWipedInterim('ja-JP', 'えー', '', '') === 'えー', 'wiped filler interim kept');
assert(Transcriber.salvageWipedInterim('ja-JP', 'えっと確認', '', '') === 'えっと確認', 'wiped short phrase kept');
assert(Transcriber.salvageWipedInterim('ja-JP', 'あ', '', '') === '', 'one-character interim stays a partial');
assert(Transcriber.salvageWipedInterim('ja-JP', 'えー', '今日は', '') === '', 'real final is not doubled');
assert(Transcriber.salvageWipedInterim('ja-JP', 'えー', '', 'あの') === '', 'replacement interim wins');
assert(Transcriber.salvageWipedInterim('en-US', 'um', '', '') === '', 'english wipe stays v58');
assert(
  Transcriber.keepSupersededInterim('ja-JP', '今日はいい天気ですね', '', '明日の会議は三時から') === '今日はいい天気ですね',
  'a new ja interim keeps the previous utterance'
);
assert(
  Transcriber.keepSupersededInterim('ja-JP', '今日はいい', '', '今日はいい天気') === '',
  'a growing ja interim is the same hypothesis'
);
assert(
  Transcriber.keepSupersededInterim('ja-JP', '今日はいい天気', '', '今日はいい') === '',
  'a shorter revision is the same hypothesis'
);
assert(
  Transcriber.keepSupersededInterim('ja-JP', '三時から出ます', '', '3時から出ますね') === '',
  'digit fold does not split one hypothesis'
);
assert(
  Transcriber.keepSupersededInterim('ja-JP', '会議は三時から開始です', '', '明日の会議は三時から開始です') === '',
  'a prefix added to the same ja span is not a second utterance'
);
assert(
  Transcriber.keepSupersededInterim('ja-JP', '今日はいい天気ですね', '', 'きょうはいい天気ですね') === '',
  'a kana rewrite of the same ja span is not a second utterance'
);
assert(
  Transcriber.keepSupersededInterim('ja-JP', 'えー今日はいい天気ですね', '', '今日はいい天気ですね') === 'えー今日はいい天気ですね',
  'a longer interim that still contains the final keeps the filler'
);
assert(
  Transcriber.keepSupersededInterim('ja-JP', '資料を共有してください', '', '内容を確認してください') === '資料を共有してください',
  'different ja sentences that share an ending are kept'
);
assert(
  Transcriber.stripEchoInterim('ja-JP', '今日はいい天気ですね。', '今日はいい天気ですね') === '',
  'ja interim that repeats the final is not shown again'
);
assert(
  Transcriber.stripEchoInterim('ja-JP', '今日はいい天気ですね。', '今日はいい天気ですね明日は雨') === '明日は雨',
  'ja interim keeps only the words after the committed span'
);
assert(
  Transcriber.stripEchoInterim('en-US', 'hello there', 'hello there') === '',
  'english echo interim is cleared'
);
assert(
  Transcriber.stripEchoInterim('en-US', 'hello', 'there') === 'there',
  'english continuation interim stays'
);
assert(Transcriber.keepSupersededInterim('ja-JP', 'えー', '', '') === '', 'empty replacement stays on salvage');
assert(Transcriber.keepSupersededInterim('ja-JP', 'あ', '', '明日') === '', 'one-character interim is not a committed utterance');
assert(Transcriber.keepSupersededInterim('en-US', 'hello there', '', 'goodbye') === '', 'english interim is not force-committed');

const shortFinal = [
  { transcript: 'えっと', confidence: 0.22 },
  { transcript: '映画と', confidence: 0.18 }
];
assert(Transcriber.pickTranscript(shortFinal, 'ja-JP') === 'えっと', 'low-confidence short final kept');
record('short filler hypothesis', pickV57(shortFinal), Transcriber.pickTranscript(shortFinal, 'ja-JP'));

const enExtend = [
  { transcript: 'hell', confidence: 0 },
  { transcript: 'hello', confidence: 0 },
  { transcript: 'hello there friend', confidence: 0 }
];
const enConf = [
  { transcript: 'I think so', confidence: 0.8 },
  { transcript: 'I think so as well', confidence: 0.2 }
];
assert(Transcriber.pickTranscript(enExtend, 'en-US') === pickV57(enExtend), 'english zero-conf pick');
assert(Transcriber.pickTranscript(enConf, 'en-US') === pickV57(enConf), 'english confidence pick');
assert(Transcriber.pickTranscript(enExtend) === pickV57(enExtend), 'default language stays v57');
record('english pick unchanged', pickV57(enExtend), Transcriber.pickTranscript(enExtend, 'en-US'));

const jaProfile = Transcriber.speechWatchProfile('ja-JP', false);
const enProfile = Transcriber.speechWatchProfile('en-US', false);
const iosProfile = Transcriber.speechWatchProfile('ja-JP', true);
const quietLevel = 0.01;
const quietHotBefore = hotV57(quietLevel, 0.012);
const quietHotAfter = Transcriber.isSpeechHot(quietLevel, jaProfile.floor, jaProfile);
record(
  'quiet RMS 0.010 speech-watch',
  `hot=${quietHotBefore} threshold=max(0.018, floor*3.2)`,
  `hot=${quietHotAfter} floor=${jaProfile.floor} abs=${jaProfile.abs} mult=${jaProfile.mult}`
);
assert(quietHotBefore === false, 'v57 misses RMS 0.010');
assert(quietHotAfter === true, 'ja desktop hears RMS 0.010');
assert(Transcriber.isSpeechHot(quietLevel, enProfile.floor, enProfile) === false, 'english misses 0.010');
assert(Transcriber.isSpeechHot(0.02, enProfile.floor, enProfile) === hotV57(0.02, 0.012), 'english 0.02 same');
assert(iosProfile.abs === 0.018 && iosProfile.gapMs === 600 && !iosProfile.usePeak, 'iOS profile unchanged');
assert(enProfile.resultMs === 2500 && enProfile.stallMs === 2000 && enProfile.gapMs === 600 && !enProfile.usePeak, 'english stall unchanged');
assert(jaProfile.gapMs === 200 && jaProfile.usePeak === true, 'ja restarts a dead engine on one short peak');
assert(
  jaProfile.stallMs === enProfile.stallMs && jaProfile.resultMs === enProfile.resultMs,
  'ja live abort window matches english'
);
assert(jaProfile.stallAbs === 0.018 && jaProfile.stallMult === 3.2, 'ja stall threshold matches english');

const roomEma = 0.005;
const roomPeak = 0.012;
const roomFlags = Transcriber.speechHotFlags(
  jaProfile, roomEma, roomPeak, jaProfile.floor, jaProfile.stallFloor
);
const loudFlags = Transcriber.speechHotFlags(
  jaProfile, 0.05, 0.08, jaProfile.floor, jaProfile.stallFloor
);
const enRoom = Transcriber.speechHotFlags(enProfile, roomEma, roomPeak, enProfile.floor, enProfile.floor);
let gapHotMs = 0;
let stallHotMs = 0;
for (let t = 0; t < 1600; t += 200) {
  const step = Transcriber.speechHotFlags(
    jaProfile, roomEma, roomPeak, jaProfile.floor, jaProfile.stallFloor
  );
  gapHotMs = step.gap ? gapHotMs + 200 : 0;
  stallHotMs = step.stall ? stallHotMs + 200 : 0;
}
record(
  'room peak must not abort live ja',
  'v59 stall at 1400/1600 on peak 0.012',
  `gap ${gapHotMs}ms stall ${stallHotMs}ms`
);
assert(roomFlags.gap === true, 'room peak still counts for a dead ja engine');
assert(roomFlags.stall === false, 'room peak does not abort a live ja engine');
assert(loudFlags.stall === true, 'loud EMA is still hot on the ja meter');
assert(enRoom.gap === false && enRoom.stall === false, 'english room peak stays cold');
assert(gapHotMs >= jaProfile.gapMs && stallHotMs === 0, '1.6s of room peak never arms ja stall');

record(
  'desktop restart ms (no-speech / end)',
  `en ${Transcriber.restartDelay('no-speech', false, 'en-US')}/${Transcriber.restartDelay('end', false, 'en-US')} ios ${Transcriber.restartDelay('no-speech', true, 'ja-JP')}/${Transcriber.restartDelay('end', true, 'ja-JP')}`,
  `ja ${Transcriber.restartDelay('no-speech', false, 'ja-JP')}/${Transcriber.restartDelay('end', false, 'ja-JP')} grace ${Transcriber.endRestartDelay(false, 'ja-JP', 'end', 1000, 2000)}`
);
assert(Transcriber.restartDelay('no-speech', false, 'en-US') === 25, 'en no-speech');
assert(Transcriber.restartDelay('end', false, 'en-US') === 35, 'en end');
assert(Transcriber.restartDelay('stall', false, 'en-US') === 30, 'en stall');
assert(Transcriber.restartDelay('no-speech', true, 'ja-JP') === 70, 'ios no-speech');
assert(Transcriber.restartDelay('end', true, 'ja-JP') === 90, 'ios end');
assert(Transcriber.restartDelay('no-speech', false, 'ja-JP') === 25, 'ja no-speech matches english');
assert(Transcriber.restartDelay('end', false, 'ja-JP') === 35, 'ja end matches english');
assert(
  Transcriber.endRestartDelay(false, 'ja-JP', 'end', 1000, 2000) === Transcriber.jaResultGraceMs,
  'ja waits out a result that arrives after speechend'
);
assert(
  Transcriber.endRestartDelay(false, 'ja-JP', 'end', 2500, 2000) === 35,
  'ja restarts promptly once the hypothesis arrived'
);
assert(
  Transcriber.endRestartDelay(false, 'en-US', 'end', 1000, 2000) === 35,
  'english end delay unchanged'
);
assert(Transcriber.jaResultGraceMs >= 2500, 'grace is longer than the v60 stall window');

assert(Transcriber.useContinuous('ja-JP', false) === true, 'desktop ja streams while speaking');
assert(Transcriber.useContinuous('ja-JP', true) === false, 'ios ja stays utterance mode');
assert(Transcriber.useContinuous('en-US', false) === true, 'english desktop stays continuous');

function FakeRecognition() {
  this.stopped = false;
  this.aborted = false;
}
FakeRecognition.prototype.start = function() {
  if (typeof this.onstart === 'function') this.onstart();
};
FakeRecognition.prototype.stop = function() {
  this.stopped = true;
  if (typeof this.onend === 'function') this.onend();
};
FakeRecognition.prototype.abort = function() {
  this.aborted = true;
  if (typeof this.onend === 'function') this.onend();
};

function hypothesis(text, isFinal) {
  const result = [{ transcript: text, confidence: 0 }];
  result.isFinal = isFinal;
  return result;
}

global.SpeechRecognition = FakeRecognition;
const liveJa = new Transcriber();
liveJa._isIOS = false;
liveJa.language = 'ja-JP';
const paints = [];
liveJa.onResult = (finalText, interimText) => {
  paints.push({ finalText, interimText });
};
assert(liveJa.start() === true, 'desktop ja recognition starts');
assert(liveJa.recognition.continuous === true, 'started desktop ja session is continuous');
assert(liveJa.recognition.interimResults === true, 'desktop ja still requests interims');
liveJa.recognition.onresult({ resultIndex: 0, results: [hypothesis('今日', false)] });
liveJa.recognition.onresult({ resultIndex: 0, results: [hypothesis('今日はいい天気', false)] });
assert(paints.length === 2, 'each interim paints before the utterance ends');
assert(paints[0].finalText === '' && paints[0].interimText === '今日', 'first interim is visible immediately');
assert(
  paints[1].finalText === '' && paints[1].interimText === '今日はいい天気',
  'interim grows while speech is still in progress'
);
assert(liveJa.isEngineRunning() === true, 'interim did not end the session');
liveJa.recognition.onspeechend();
assert(liveJa.recognition.stopped === false && liveJa.recognition.aborted === false, 'speechend does not stop or abort');
liveJa.recognition.onresult({
  resultIndex: 0,
  results: [hypothesis('今日はいい天気ですね', true)]
});
assert(paints.length === 3, 'final is a separate paint, not a batch of earlier interims');
assert(paints[2].interimText === '', 'final clears the interim');
assert(paints[2].finalText.includes('今日はいい天気ですね'), 'final still lands in the caption');
liveJa.stop();

const liveIos = new Transcriber();
liveIos._isIOS = true;
liveIos.language = 'ja-JP';
assert(liveIos.start() === true, 'ios recognition starts');
assert(liveIos.recognition.continuous === false, 'ios session stays utterance mode');
liveIos.stop();

const liveEn = new Transcriber();
liveEn._isIOS = false;
liveEn.language = 'en-US';
assert(liveEn.start() === true, 'english recognition starts');
assert(liveEn.recognition.continuous === true, 'english session stays continuous');
liveEn.stop();

const clearing = new Transcriber();
clearing.language = 'ja-JP';
clearing._isIOS = false;
assert(clearing.start() === true, 'session to clear starts');
clearing.recognition.onresult({ resultIndex: 0, results: [hypothesis('今日はいい天気ですね', true)] });
assert(clearing.getFullTranscript().includes('今日はいい天気ですね'), 'caption exists before clear');
const liveEngine = clearing.recognition;
let disposed = false;
liveEngine.abort = () => { disposed = true; };
liveEngine.stop = () => { disposed = true; };
clearing.reset();
assert(clearing.getFullTranscript() === '', 'reset drops caption buffers');
clearing._appendFinal('桜の花びらが舞う夜に私は静かに歌い続けているよ今夜も');
assert(
  countSpan(clearing.finalTranscript, '桜の花びらが舞う夜に私は静かに歌い続けているよ今夜も') === 1,
  'clear allows the same lyric to be committed again'
);
clearing.reset();
assert(disposed === false, 'reset does not stop or abort the engine');
assert(clearing.recognition === liveEngine, 'reset keeps the recognition instance');
assert(clearing.isListening === true && clearing.shouldRestart === true, 'reset leaves the session running');
clearing.stop();

assert(Transcriber.jaLiveRecovery({
  language: 'ja-JP', ios: false, hasInterim: false, gotResult: false, msSinceStart: 2500
}) === 'none', '2.5s of ja speech is not cut');
assert(Transcriber.jaLiveRecovery({
  language: 'ja-JP', ios: false, hasInterim: true, gotResult: false, msSinceStart: 9000
}) === 'none', 'visible interim is not cut');
assert(Transcriber.jaLiveRecovery({
  language: 'ja-JP', ios: false, hasInterim: false, gotResult: true, msSinceStart: 9000
}) === 'none', 'a hypothesis disables the live stop');
assert(Transcriber.jaLiveRecovery({
  language: 'ja-JP', ios: false, hasInterim: false, gotResult: false, msSinceStart: 8000
}) === 'stop', 'a wedged ja session is stopped, not aborted');
assert(Transcriber.jaLiveRecovery({
  language: 'en-US', ios: false, hasInterim: false, gotResult: false, msSinceStart: 9000
}) === 'none', 'english has no ja live stop');
assert(Transcriber.jaStaleStopMs > Transcriber.jaResultGraceMs, 'stale stop waits longer than the late-hypothesis grace');
assert(Transcriber.jaStaleStopMs > 2500, 'stale stop is not the 2.5s stall abort');
assert(Transcriber.jaStaleRecovery({
  language: 'ja-JP', ios: false, gotResult: true, msSinceResult: 900,
  msSinceSpeechEnd: 900, resultAfterSpeechEnd: false
}) === 'none', '900ms after speechend does not stop ja');
assert(Transcriber.jaStaleRecovery({
  language: 'ja-JP', ios: false, gotResult: true, msSinceResult: 2500,
  msSinceSpeechEnd: 2500, resultAfterSpeechEnd: false
}) === 'none', '2.5s after speechend does not stop ja');
assert(Transcriber.jaStaleRecovery({
  language: 'ja-JP', ios: false, gotResult: false, msSinceResult: 9000,
  msSinceSpeechEnd: 9000, resultAfterSpeechEnd: false
}) === 'none', 'the first hypothesis still belongs to the 8s watch');
assert(Transcriber.jaStaleRecovery({
  language: 'ja-JP', ios: false, gotResult: true, msSinceResult: 4500,
  msSinceSpeechEnd: 4500, resultAfterSpeechEnd: false
}) === 'stop', 'a crumb then silence is stopped so the next speech can be heard');
assert(Transcriber.jaStaleRecovery({
  language: 'ja-JP', ios: false, gotResult: true, msSinceResult: 1000,
  msSinceSpeechEnd: 4500, resultAfterSpeechEnd: true
}) === 'none', 'a hypothesis after speechend keeps the session');
assert(Transcriber.jaStaleRecovery({
  language: 'en-US', ios: false, gotResult: true, msSinceResult: 9000,
  msSinceSpeechEnd: 9000, resultAfterSpeechEnd: false
}) === 'none', 'english has no ja stale stop');

const jaMic = AudioRecorder.speechAudioConstraints('ja-JP', false);
const enMic = AudioRecorder.speechAudioConstraints('en-US', false);
const iosMic = AudioRecorder.speechAudioConstraints('ja-JP', true);
const bareMic = AudioRecorder.speechAudioConstraints();
record(
  'mic noiseSuppression ideal',
  `en ${enMic.noiseSuppression.ideal} ios-ja ${iosMic.noiseSuppression.ideal} default ${bareMic.noiseSuppression.ideal}`,
  `desktop-ja ${jaMic.noiseSuppression.ideal} agc ${jaMic.autoGainControl.ideal}`
);
assert(jaMic.noiseSuppression.ideal === true, 'ja desktop keeps NS on');
assert(jaMic.autoGainControl.ideal === true, 'ja keeps AGC');
assert(jaMic.googNoiseSuppression === true, 'ja goog NS stays on');
assert(enMic.noiseSuppression.ideal === true && enMic.googNoiseSuppression === true, 'en NS on');
assert(iosMic.noiseSuppression.ideal === true, 'ios NS on');
assert(
  jaMic.noiseSuppression.ideal === enMic.noiseSuppression.ideal
    && jaMic.googNoiseSuppression === enMic.googNoiseSuppression,
  'ja mic constraints match english'
);
assert(bareMic.noiseSuppression.ideal === true && bareMic.googAutoGainControl === true, 'default constraints stay v57');

const root = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css/style.css'), 'utf8');
const app = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
const transcriberSrc = fs.readFileSync(path.join(root, 'js/transcriber.js'), 'utf8');
const viz = fs.readFileSync(path.join(root, 'js/visualizer.js'), 'utf8');
assert(viz.includes('getSpeechPeak'), 'frame peak for short bursts');
assert(viz.includes('_sampleSpeechPeak'), 'peak is sampled while drawing');
assert(app.includes('usePeak'), 'desktop ja watch reads the peak');
assert(app.includes('speechHotFlags'), 'stall does not reuse the gap peak');
assert(!index.includes('v=82'), 'index cache bust left 82');
assert(!index.includes('v=81'), 'index cache bust left 81');
assert(!index.includes('v=80'), 'index cache bust left 80');
assert(!index.includes('v=79'), 'index cache bust left 79');
assert(index.includes('v=86'), 'index is v86');
assert(sw.includes("voicescribe-v86"), 'sw cache name');
assert(app.includes('_gestureKickRecognition'), 'record tap kicks STT before await');
assert(!sw.includes('voicescribe-v82'), 'old sw name gone');
const manifest = fs.readFileSync(path.join(root, 'manifest.json'), 'utf8');
assert(!manifest.includes('portrait-primary'), 'PWA does not lock portrait-primary');
assert(!manifest.includes('"orientation"'), 'manifest does not declare orientation lock');
assert(manifest.includes('"id": "./"'), 'manifest id stays stable for iOS home screen');
assert(!app.includes('navigator.wakeLock.request'), 'wake lock does not block device lock');
assert(!app.includes('screen.orientation.unlock'), 'no orientation unlock calls on iOS');
assert(app.includes('_syncViewportHeight'), 'viewport resync on rotate for iOS Safari');
assert(app.includes("APP_BUILD = 'v86'"), 'app build tag is v86');
assert(transcriberSrc.includes('msSinceCaptionChange'), 'stall uses caption content time');
assert(transcriberSrc.includes('polishJaCommitted'), 'long ja repeats are polished');
assert(css.includes('caption-stalled-recording'), 'stalled recording forces resume visible');
assert(app.includes("addEventListener('pointerdown', resumeTap"), 'resume binds pointerdown for iOS gesture');
assert(transcriberSrc.includes('manualResumeListening'), 'user tap forces recognition restart');
assert(app.includes('resume-reading-header-btn'), 'header resume syncs with deck resume');
assert(app.includes('shouldShowManualResume'), 'app uses manual resume visibility');
assert(transcriberSrc.includes('shouldShowManualResume'), 'transcriber exposes manual resume');
assert(transcriberSrc.includes('iosCaptionStaleMs'), 'ios has its own stale threshold');
assert(app.includes('_stageDraftFromStop'), 'stop shows draft play before save finishes');
assert(transcriberSrc.includes('jaOverlapMax'), 'long ja overlap cap is named');
assert(transcriberSrc.includes('collapseAdjacentJaRepeats'), 'adjacent ja repeats collapse after commit');
assert(app.includes('app-ios-rotation-hint'), 'settings explain iPhone rotation limits');
assert(app.includes('sw.js?v=86'), 'service worker registration is cache-busted');
assert(transcriberSrc.includes('_cleanLiveInterim'), 'interim repeat uses the commit dedupe window');
assert(transcriberSrc.includes('setContinuedPrefix'), 'resume prefix is excluded from dedupe anchor');
assert(transcriberSrc.includes('iosCaptionBootMs'), 'ios waits longer before caption stall revive');
assert(css.includes('--app-height'), 'css uses dynamic viewport height');
assert(!sw.includes('voicescribe-v65'), 'older sw name gone');
const micCalls = (src) => (src.match(/\.getUserMedia\s*\(/g) || []).length;
const recorderSrc = fs.readFileSync(path.join(root, 'js/recorder.js'), 'utf8');
assert(micCalls(viz) === 0, 'visualizer does not open a mic');
assert(micCalls(app) === 0, 'app must not open a mic');
assert(micCalls(transcriberSrc) === 0, 'transcriber must not open a mic');
assert(micCalls(recorderSrc) === 2, 'still one mic open path');
assert(!recorderSrc.includes('noiseSuppression: false'), 'no exact NS off before recognition');
assert(transcriberSrc.includes("this.language = 'ja-JP'"), 'default language stays ja-JP');
assert(transcriberSrc.includes('this.recognition.lang = this.language'), 'recognition.lang follows setLanguage');
function methodBody(src, signature) {
  const start = src.indexOf(signature);
  if (start < 0) return '';
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

const liveWatch = methodBody(transcriberSrc, '  _armJaLiveWatch() {');
assert(liveWatch && !liveWatch.includes('.abort('), 'ja live watch does not abort');
assert(liveWatch.includes('.stop()'), 'ja live watch asks Chrome to return a result');
assert(!transcriberSrc.includes('jaHungWatchMs'), '900ms speechend abort is gone');
assert(!transcriberSrc.includes('shouldRecoverHungRecognition'), 'dead speechend abort policy is gone');
const unwedge = methodBody(transcriberSrc, '  _unwedgeJaSession() {');
assert(unwedge && !unwedge.includes('.abort('), 'ja unwedge does not abort');
assert(unwedge.includes('.stop()'), 'ja unwedge asks Chrome for a result');
const flush = methodBody(transcriberSrc, '  _armJaSpeechEndFlush() {');
assert(flush && !flush.includes('.abort('), 'speechend flush does not abort');
const ingest = methodBody(transcriberSrc, '  _ingestResult(event) {');
assert(ingest && !ingest.includes('.abort(') && !ingest.includes('.stop('), 'result commit does not end the session');
assert(transcriberSrc.includes('_isDesktopJa()'), 'desktop ja policy is one helper');
assert(transcriberSrc.includes('startAckMs'), 'start ack prevents early gap nudge');
assert(transcriberSrc.includes('_tryStartEngine'), 'recognition start waits for onstart');
assert(transcriberSrc.includes('isCaptionStalled'), 'zombie caption detection exists');
assert(transcriberSrc.includes('reviveLiveCaption'), 'caption can recover without stopping recorder');
assert(app.includes('_checkCaptionHealth'), 'caption health runs without the level meter');

const UIManager = require('../js/ui.js');
assert(UIManager.transcriptChrome(4, true).showClear === true, 'clear stays visible while recording');
assert(UIManager.transcriptChrome(4, true).showObsidian === false, 'obsidian stays after stop');
assert(UIManager.transcriptChrome(4, false).showClear === true, 'clear shows after stop when there is text');
assert(UIManager.transcriptChrome(4, false).showObsidian === true, 'obsidian shows after stop');
assert(UIManager.transcriptChrome(0, false).showClear === false, 'clear hides when the transcript is empty');
assert(UIManager.transcriptChrome(0, true).showClear === false, 'clear hides during recording with no text');

const clearFn = methodBody(app, '  _clearTranscript() {');
assert(clearFn.includes('this.transcriber.reset()'), 'clear resets transcriber buffers');
assert(clearFn.includes('continueListening()'), 'clear recycles recognition without a new mic');
assert(clearFn.includes("updateTranscript('', '', this.isRecording)"), 'clear keeps the recording flag in the UI');
assert(!clearFn.includes('getUserMedia'), 'clear does not open a microphone');
assert(!/if\s*\(\s*this\.isRecording\s*\)\s*return/.test(app.slice(app.indexOf("getElementById('clear-transcript-btn')"), app.indexOf('_clearTranscript'))), 'clear click is not a no-op while recording');
const gesture = methodBody(app, '  _armRecognitionGesture() {');
assert(gesture.includes('#clear-transcript-btn'), 'gesture ignores the clear control');
assert(!gesture.includes('preventDefault'), 'gesture does not swallow the clear click');
assert(!gesture.includes('stopPropagation'), 'gesture does not stop the clear click');
assert(!gesture.includes('stopImmediatePropagation'), 'gesture does not stop the clear click immediately');
assert(gesture.includes('#resume-reading-btn'), 'gesture does not steal the resume tap');
assert(gesture.includes('needsRecovery'), 'gesture does not start recognition before a dead desktop mic');

const resumeFn = methodBody(app, 'async _resumeReading() {');
const resumeCap = resumeFn.indexOf('ensureCapture');
const resumeKick = resumeFn.indexOf('manualResumeListening');
assert(resumeFn.includes('needsRecovery'), 'resume reuses a live recorder stream');
assert(!resumeFn.includes('getUserMedia'), 'resume does not open a second microphone');
assert(resumeKick !== -1 && resumeCap !== -1 && resumeKick < resumeCap, 'resume kickstarts recognition before await');
assert(resumeFn.includes('_armResumeBoost'), 'resume arms post-tap recognition retries');
assert(transcriberSrc.includes('inUserResumeGrace'), 'transcriber pauses auto-revive during user resume');
assert(methodBody(app, '_checkCaptionHealth() {').includes('inUserResumeGrace'), 'caption health skips revive during user resume');
assert(index.includes('id="resume-reading-btn"'), 'resume button is in the page');
assert(index.includes('id="resume-reading-header-btn"'), 'resume pill is in the transcript header');
assert(index.includes('>再開<'), 'resume button label');
assert(css.includes('.resume-reading-btn'), 'resume button is styled in the control deck');
const recoverFn = methodBody(app, 'async _recoverActiveRecordingBody() {');
assert(recoverFn && !recoverFn.includes('_stopRecording'), 'a lost mic does not end the recording');
assert(recoverFn.includes('ensureCapture'), 'a lost mic reopens through the recorder');
const restartNow = methodBody(transcriberSrc, '  _restartNow() {');
assert(restartNow && !restartNow.includes('this.stop()'), 'failed recognition restarts do not end the session');
assert(unwedge.includes('_armStopWatch'), 'stop() without onend still restarts recognition');

function listeningJa() {
  const t = new Transcriber();
  t.language = 'ja-JP';
  t._isIOS = false;
  t.shouldRestart = true;
  t.isListening = true;
  t._engineRunning = true;
  t._lastResultAt = Date.now() - 5000;
  t._heardSpeechAt = Date.now() - 5000;
  t.interimTranscript = '';
  return t;
}

let jaAborted = false;
const jaLive = listeningJa();
jaLive.recognition = {
  abort() { jaAborted = true; },
  stop() { jaAborted = true; }
};
assert(jaLive.nudge('stall') === false, 'ja without a hypothesis is not stall-cut');
assert(jaAborted === false, 'stall does not call abort or stop before a ja hypothesis');

const jaStale = listeningJa();
jaStale._gotHypothesis = true;
let staleStopped = false;
let staleAborted = false;
jaStale.recognition = {
  abort() { staleAborted = true; },
  stop() { staleStopped = true; }
};
assert(jaStale.nudge('stall') === true, 'stale ja speech stop()s so the next utterance is heard');
assert(staleStopped === true && staleAborted === false, 'stale ja stall uses stop, not abort');
jaStale.stop();

let enAborted = false;
const enLive = listeningJa();
enLive.language = 'en-US';
enLive.recognition = {
  abort() { enAborted = true; },
  stop() {},
  start() {}
};
assert(enLive.nudge('stall') === true, 'english stall abort remains');
assert(enAborted === true, 'english stall still aborts');
enLive.stop();

const jaGap = listeningJa();
jaGap._engineRunning = false;
let gapRestarted = false;
jaGap._restartTimer = setTimeout(() => { gapRestarted = true; }, 10000);
const keptTimer = jaGap._restartTimer;
assert(jaGap.nudge('gap') === false, 'ja peak does not cancel a scheduled restart');
assert(jaGap._restartTimer === keptTimer, 'scheduled ja restart stays armed');
clearTimeout(keptTimer);
assert(gapRestarted === false, 'preempted restart did not run');

const startFn = app.slice(app.indexOf('async _startRecording'), app.indexOf('async _stopRecording'));
const recorderAt = startFn.indexOf('this.recorder.start');
const desktopStart = startFn.indexOf('this.transcriber.start', recorderAt);
const iosStart = startFn.lastIndexOf('this.transcriber.start', recorderAt);
assert(iosStart !== -1 && iosStart < recorderAt, 'iOS recognition stays before recorder');
assert(desktopStart > recorderAt, 'desktop recognition stays after recorder');
assert(startFn.includes('if (!recognitionFirst)'), 'desktop path is gated');

function countSpan(text, span) {
  const norm = (text || '').replace(/[。、！？!?\s\u3000]/g, '');
  const needle = (span || '').replace(/[。、！？!?\s\u3000]/g, '');
  let n = 0;
  let i = 0;
  while (needle && (i = norm.indexOf(needle, i)) !== -1) {
    n += 1;
    i += needle.length;
  }
  return n;
}

function paintOf(language, events) {
  const t = new Transcriber();
  t.language = language;
  t._isIOS = false;
  let finalText = '';
  let interimText = '';
  t.onResult = (final, interim) => {
    finalText = final;
    interimText = interim;
  };
  events.forEach((event) => t._ingestResult(event));
  return { finalText, interimText, shown: `${finalText || ''}${interimText || ''}`, t };
}

const kanaRewrite = paintOf('ja-JP', [
  { resultIndex: 0, results: [hypothesis('今日はいい天気ですね', false)] },
  { resultIndex: 0, results: [hypothesis('きょうはいい天気ですね', false)] },
  { resultIndex: 0, results: [hypothesis('今日はいい天気ですね', true)] }
]);
assert(countSpan(kanaRewrite.shown, '今日はいい天気ですね') === 1, 'kana rewrite commits the span once');
assert(!kanaRewrite.shown.includes('きょう'), 'the rewritten interim is not kept beside the final');

const prefixGrowth = paintOf('ja-JP', [
  { resultIndex: 0, results: [hypothesis('会議は三時から開始です', false)] },
  { resultIndex: 0, results: [hypothesis('明日の会議は三時から開始です', false)] },
  { resultIndex: 0, results: [hypothesis('明日の会議は三時から開始です', true)] }
]);
assert(countSpan(prefixGrowth.shown, '会議は三時から開始です') === 1, 'prefix growth commits the span once');
assert(prefixGrowth.interimText === '', 'prefix growth final clears the interim');

const echoInterim = paintOf('ja-JP', [
  { resultIndex: 0, results: [hypothesis('今日はいい天気ですね', true), hypothesis('今日はいい天気ですね', false)] }
]);
assert(echoInterim.interimText === '', 'echo interim is not painted beside the final');
assert(countSpan(echoInterim.shown, '今日はいい天気ですね') === 1, 'echo interim does not double the caption');

const supersetInterim = paintOf('ja-JP', [
  { resultIndex: 0, results: [hypothesis('今日はいい天気ですね', true), hypothesis('今日はいい天気ですね明日は雨', false)] }
]);
assert(countSpan(supersetInterim.shown, '今日はいい天気ですね') === 1, 'cumulative interim does not repeat the final');
assert(supersetInterim.interimText === '明日は雨', 'cumulative interim keeps the new tail');

const fillerFinal = paintOf('ja-JP', [
  { resultIndex: 0, results: [hypothesis('えー今日はいい天気ですね', false)] },
  { resultIndex: 0, results: [hypothesis('今日はいい天気ですね', true)] }
]);
assert(fillerFinal.shown.includes('えー'), 'filler stays when the final drops it');
assert(countSpan(fillerFinal.shown, '今日はいい天気ですね') === 1, 'cleaned final does not repeat the filler interim');

const digitFinal = paintOf('ja-JP', [
  { resultIndex: 0, results: [hypothesis('明日の会議は三時から開始で', false)] }
]);
digitFinal.t._commitPendingInterim();
digitFinal.t._ingestResult({
  resultIndex: 0,
  results: [hypothesis('明日の会議は3時から開始で資料は事前に共有してください', true)]
});
const digitShown = `${digitFinal.t.finalTranscript || ''}${digitFinal.t.interimTranscript || ''}`;
assert(
  countSpan(digitShown.replace(/3/g, '三'), '明日の会議は三時から開始で') === 1,
  'a 3/三 final does not repeat the committed interim'
);
assert(digitShown.includes('資料は事前に共有してください'), 'the longer digit final is kept');

const resent = paintOf('ja-JP', [
  { resultIndex: 0, results: [hypothesis('今日はいい天気ですね', true)] },
  { resultIndex: 1, results: [hypothesis('今日はいい天気ですね', true), hypothesis('明日は雨です', true)] }
]);
resent.t._lastChunkAt = Date.now() - 5000;
resent.t._ingestResult({
  resultIndex: 0,
  results: [
    hypothesis('今日はいい天気ですね', true),
    hypothesis('明日は雨です', true),
    hypothesis('資料を送ります', false)
  ]
});
const resentShown = `${resent.t.finalTranscript || ''}${resent.t.interimTranscript || ''}`;
assert(countSpan(resentShown, '今日はいい天気ですね') === 1, 'resultIndex 0 does not reappend old ja finals');
assert(countSpan(resentShown, '明日は雨です') === 1, 'resultIndex 0 does not reappend the second ja final');
assert(resent.t.interimTranscript === '資料を送ります', 'a new interim after resent finals stays live');

const enResent = paintOf('en-US', [
  { resultIndex: 0, results: [hypothesis('hello there', true)] },
  { resultIndex: 1, results: [hypothesis('hello there', true), hypothesis('how are you', true)] }
]);
enResent.t._lastChunkAt = Date.now() - 5000;
enResent.t._ingestResult({
  resultIndex: 0,
  results: [
    hypothesis('hello there', true),
    hypothesis('how are you', true),
    hypothesis('today', false)
  ]
});
assert(enResent.t.finalTranscript === 'hello there how are you', 'english does not reappend old finals');
assert(enResent.t.interimTranscript === 'today', 'english interim after resent finals stays');

const distinct = paintOf('ja-JP', [
  { resultIndex: 0, results: [hypothesis('今日はいい天気ですね', false)] },
  { resultIndex: 0, results: [hypothesis('明日の会議は三時から', false)] }
]);
assert(distinct.finalText.includes('今日はいい天気ですね'), 'a different ja utterance is still committed');
assert(distinct.interimText === '明日の会議は三時から', 'the new ja interim stays live');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const LINE = '桜の花びらが舞う夜に私は静かに歌い続けているよ今夜も';
assert(Transcriber._plain(LINE).length > 24, 'lyric fixture is longer than a short overlap');
assert(Transcriber.jaOverlapMax >= Transcriber._plain(LINE).length, 'ja overlap cap covers the lyric fixture');
assert(Transcriber.repeatWindowMs > Transcriber.jaStaleStopMs, 'repeat window covers a stale stop');
assert(Transcriber.repeatWindowMs > Transcriber.jaResultGraceMs, 'repeat window covers the late-hypothesis grace');
assert(Transcriber.repeatWindowMs > 2200, 'repeat window is longer than the old merge window');

const burst = new Transcriber();
burst.language = 'ja-JP';
for (let i = 0; i < 8; i++) burst._appendFinal(LINE);
assert(countSpan(burst.finalTranscript, LINE) === 1, 'identical long finals in a row stay one line');

const doubled = `${LINE}${LINE}`;
assert(Transcriber.collapseRepeatedPhrase(doubled, 'ja-JP') === LINE, 'a final that contains the lyric twice collapses');
assert(countSpan(appendNow('ja-JP', [doubled, doubled]), LINE) === 1, 'repeated doubled finals stay one line');
assert(
  Transcriber.collapseRepeatedPhrase('今日はいい天気ですね', 'ja-JP') === '今日はいい天気ですね',
  'a normal sentence is not treated as a doubled lyric'
);

const replay = new Transcriber();
replay.language = 'ja-JP';
replay._appendFinal(LINE);
replay._appendFinal('川を越えて行く');
replay._appendFinal(LINE);
assert(countSpan(replay.finalTranscript, LINE) === 1, 'the same lyric resent inside the window is dropped');
assert(replay.finalTranscript.includes('川を越えて行く'), 'a different line between resends is kept');
replay._recentNorms.forEach((row) => {
  row.at = Date.now() - (Transcriber.repeatWindowMs + 500);
});
replay._lastChunkAt = Date.now() - (Transcriber.repeatWindowMs + 500);
replay._appendFinal(LINE);
assert(countSpan(replay.finalTranscript, LINE) === 2, 'the same lyric after the window is a real reprise');

const subsetReplay = new Transcriber();
subsetReplay.language = 'ja-JP';
subsetReplay._appendFinal(`${LINE}川を越えて行く`);
subsetReplay._appendFinal(LINE);
assert(countSpan(subsetReplay.finalTranscript, LINE) === 1, 'a lyric resent inside a longer commit is dropped');

const resumePrefix = new Transcriber();
resumePrefix.language = 'ja-JP';
resumePrefix.setContinuedPrefix(LINE);
resumePrefix._appendFinal('川を越えて行く');
assert(resumePrefix.finalTranscript.includes('川を越えて行く'), 'new speech after resume prefix is not swallowed');
resumePrefix._appendFinal(LINE);
assert(countSpan(resumePrefix.finalTranscript, LINE) === 1, 'repeated lyric after resume prefix is still deduped');

const iosLoop = new Transcriber();
iosLoop.language = 'ja-JP';
iosLoop._isIOS = true;
assert(iosLoop.start() === true, 'ios loop session starts');
iosLoop.recognition.onresult({ resultIndex: 0, results: [hypothesis(LINE, true)] });
iosLoop._restartNow();
iosLoop.recognition.onresult({ resultIndex: 0, results: [hypothesis(LINE, false)] });
assert(iosLoop.interimTranscript === '', 'ios loop interim for a recent lyric is hidden');
iosLoop.recognition.onresult({ resultIndex: 0, results: [hypothesis(LINE, true)] });
assert(countSpan(iosLoop.finalTranscript, LINE) === 1, 'ios loop final for a recent lyric is dropped');
iosLoop.stop();

assert(Transcriber.mergeJapaneseOverlap(LINE, LINE) === LINE, 'joining identical ja chunks does not duplicate');
const longLeft = `${LINE}川を越えて`;
const longRight = `${LINE}川を越えて行く`;
assert(
  Transcriber.mergeJapaneseOverlap(longLeft, longRight) === longRight,
  'long ja overlap joins without duplicating the lyric head'
);
const doubledTail = `${LINE}${LINE}`;
assert(
  Transcriber.collapseAdjacentJaRepeats(doubledTail) === LINE,
  'adjacent duplicate lyric tail collapses to one'
);
const halfDup = `${LINE}${LINE}`;
assert(
  Transcriber.collapseJaNearHalfDuplicate(halfDup) === LINE,
  'near-half duplicate monologue collapses to one block'
);

const tailResend = new Transcriber();
tailResend.language = 'ja-JP';
tailResend._appendFinal('明日の会議は三時から開始で資料は事前に共有してください');
const tailOnce = tailResend.finalTranscript;
tailResend._lastChunkAt = Date.now() - 6000;
tailResend._recentNorms.forEach((row) => {
  row.at = Date.now() - 6000;
});
tailResend._ingestResult({
  resultIndex: 0,
  results: [hypothesis('資料は事前に共有してください', true)]
});
assert(tailResend.finalTranscript === tailOnce, 'a resent tail of a long line is not appended past the old 2.2s window');

const sung = new Transcriber();
sung.language = 'ja-JP';
sung._isIOS = false;
assert(sung.start() === true, 'sung session starts');
sung.recognition.onresult({ resultIndex: 0, results: [hypothesis(LINE, true)] });
assert(countSpan(sung.finalTranscript, LINE) === 1, 'sung lyric lands once');
sung._lastChunkAt = Date.now() - 6000;
sung._recentNorms.forEach((row) => {
  row.at = Date.now() - 6000;
});
sung._restartNow();
sung.recognition.onresult({ resultIndex: 0, results: [hypothesis(LINE, true)] });
assert(countSpan(sung.finalTranscript, LINE) === 1, 'stop/restart reemit of the same lyric is dropped');
assert(sung.shouldRestart === true && sung.isListening === true, 'restart keeps the recognition session');
sung.stop();

const resumeUi = new Transcriber();
resumeUi.language = 'ja-JP';
resumeUi._isIOS = false;
assert(resumeUi.start() === true, 'resume visibility session starts');
assert(resumeUi.needsResume() === false, 'running recognition with fresh captions hides 再開');
resumeUi._sessionStartedAt = Date.now() - (Transcriber.captionBootMs + 500);
assert(resumeUi.needsResume() === true, 'running engine with no hypothesis shows 再開');
resumeUi._engineRunning = false;
resumeUi._lastResultAt = Date.now();
resumeUi._restartTimer = setTimeout(() => {}, 60000);
resumeUi._restartDelayMs = 35;
assert(resumeUi.needsResume() === false, 'a short auto restart hides 再開');
resumeUi._restartDelayMs = Transcriber.jaResultGraceMs;
assert(resumeUi.needsResume() === false, 'scheduled auto-restart hides 再開');
resumeUi._lastResultAt = Date.now() - (Transcriber.captionStaleMs + 500);
assert(resumeUi.needsResume() === true, 'stalled captions show 再開 even during auto-restart');
const iosStallUi = new Transcriber();
iosStallUi.language = 'ja-JP';
iosStallUi._isIOS = true;
iosStallUi.shouldRestart = true;
iosStallUi.isListening = true;
iosStallUi._gotHypothesis = true;
iosStallUi._lastResultAt = Date.now() - (Transcriber.iosCaptionStaleMs + 500);
assert(iosStallUi.shouldShowManualResume() === true, 'ios stale captions offer manual resume');
iosStallUi._stallReviveCount = Transcriber.manualResumeAfterRevives;
assert(iosStallUi.reviveLiveCaption() === false, 'ios stops auto revive and asks for manual resume');
assert(iosStallUi._resumeNeeded === true, 'ios manual resume flag is set');
const iosZombie = new Transcriber();
iosZombie.language = 'ja-JP';
iosZombie._isIOS = true;
assert(iosZombie.start() === true, 'ios zombie session starts');
iosZombie.recognition.onresult({ resultIndex: 0, results: [hypothesis('今日はいい天気', true)] });
iosZombie._engineRunning = true;
assert(iosZombie.manualResumeListening(true) === true, 'manual resume restarts even when engine flag is stuck');
clearTimeout(resumeUi._restartTimer);
resumeUi._restartTimer = null;
resumeUi._restartDelayMs = 0;
assert(resumeUi.needsResume() === true, 'a dead engine with no timer shows 再開');
resumeUi._engineRunning = true;
resumeUi._sessionStartedAt = Date.now();
resumeUi._lastResultAt = Date.now();
resumeUi._gotHypothesis = true;
assert(resumeUi.needsResume() === false, 'recognition running again hides 再開');
resumeUi.stop();
assert(resumeUi.needsResume() === false, 'user stop hides 再開');

const abortSoak = new Transcriber();
abortSoak.language = 'ja-JP';
abortSoak._isIOS = false;
assert(abortSoak.start() === true, 'abort soak starts');
for (let i = 0; i < 12; i++) {
  abortSoak._engineRunning = true;
  abortSoak.recognition.onerror({ error: 'aborted' });
}
assert(abortSoak.shouldRestart === true && abortSoak.isListening === true, 'repeated aborted errors do not end recognition');
assert(abortSoak._resumeNeeded === true, 'repeated aborts mark resume needed');
if (abortSoak._restartTimer) clearTimeout(abortSoak._restartTimer);
abortSoak._restartTimer = null;
assert(abortSoak.needsResume() === true, 'repeated aborts surface 再開');
abortSoak.finalTranscript = LINE;
abortSoak.stop();
assert(abortSoak.finalTranscript.includes(LINE), 'giving up is not allowed to clear the caption');

const denied = new Transcriber();
denied.language = 'ja-JP';
denied._isIOS = false;
assert(denied.start() === true, 'not-allowed session starts');
denied.finalTranscript = '残す歌詞';
denied.recognition.onerror({ error: 'not-allowed' });
assert(denied.isListening === true && denied.shouldRestart === true, 'not-allowed during a session keeps listening armed');
assert(denied.needsResume() === true, 'not-allowed shows 再開');
assert(denied.finalTranscript.includes('残す歌詞'), 'not-allowed keeps the caption');
denied.stop();

const iosResume = new Transcriber();
iosResume._isIOS = true;
iosResume.language = 'ja-JP';
iosResume.finalTranscript = '残しておく歌詞';
assert(iosResume.continueListening() === true, 'iOS resume starts');
assert(iosResume.recognition.continuous === false, 'iOS resume stays utterance mode');
assert(iosResume.finalTranscript.includes('残しておく歌詞'), 'iOS resume keeps committed text');
iosResume.stop();

const deskResume = new Transcriber();
deskResume._isIOS = false;
deskResume.language = 'ja-JP';
deskResume.finalTranscript = LINE;
assert(deskResume.continueListening() === true, 'desktop resume starts');
assert(deskResume.recognition.continuous === true, 'desktop ja resume stays continuous');
assert(deskResume.finalTranscript.includes(LINE), 'desktop resume keeps committed text');
deskResume.stop();

async function proveSpeechEndFlush() {
  const saved = Transcriber.jaStaleStopMs;
  Transcriber.jaStaleStopMs = 60;
  try {
    const wedged = new Transcriber();
    wedged.language = 'ja-JP';
    wedged._isIOS = false;
    const seen = [];
    wedged.onResult = (finalText, interimText) => {
      seen.push({ finalText, interimText });
    };
    assert(wedged.start() === true, 'wedged ja session starts');
    const wedgedRec = wedged.recognition;
    wedgedRec.onresult({ resultIndex: 0, results: [hypothesis('今日はいい天気ですね', false)] });
    wedgedRec.onspeechend();
    assert(wedgedRec.stopped === false, 'speechend does not stop inside the old 900ms window');
    await wait(80);
    assert(wedgedRec.stopped === true, 'speechend with no later hypothesis stop()s');
    assert(wedgedRec.aborted === false, 'speechend flush does not abort');
    assert(seen.some((row) => row.finalText.includes('今日はいい天気ですね')), 'the crumb is kept before the flush');
    await wait(200);
    assert(wedged.recognition !== wedgedRec, 'flush restarts without waiting another grace period');
    assert(wedged.isEngineRunning() === true, 'restarted session is listening');
    wedged.stop();

    const healthy = new Transcriber();
    healthy.language = 'ja-JP';
    healthy._isIOS = false;
    assert(healthy.start() === true, 'healthy ja session starts');
    healthy.recognition.onresult({ resultIndex: 0, results: [hypothesis('今日は', false)] });
    healthy.recognition.onspeechend();
    await wait(20);
    healthy.recognition.onresult({
      resultIndex: 0,
      results: [hypothesis('今日はいい天気ですね', true)]
    });
    await wait(70);
    assert(healthy.recognition.stopped === false, 'a result after speechend cancels the flush');
    assert(healthy.getFullTranscript().includes('今日はいい天気ですね'), 'late final is still captioned');
    healthy.stop();

    const quiet = new Transcriber();
    quiet.language = 'ja-JP';
    quiet._isIOS = false;
    assert(quiet.start() === true, 'pre-hypothesis session starts');
    quiet.recognition.onspeechend();
    await wait(90);
    assert(quiet.recognition.stopped === false, 'speechend before any hypothesis does not stop early');
    quiet.stop();

    const replaced = new Transcriber();
    replaced.language = 'ja-JP';
    replaced._isIOS = false;
    const paints = [];
    replaced.onResult = (finalText, interimText) => {
      paints.push({ finalText, interimText });
    };
    assert(replaced.start() === true, 'replacement session starts');
    replaced.recognition.onresult({ resultIndex: 0, results: [hypothesis('今日はいい天気ですね', false)] });
    replaced.recognition.onresult({ resultIndex: 0, results: [hypothesis('明日の会議は三時から', false)] });
    const last = paints[paints.length - 1];
    assert(last.finalText.includes('今日はいい天気ですね'), 'superseded ja interim is committed');
    assert(last.interimText === '明日の会議は三時から', 'the new interim stays live');
    replaced.stop();
  } finally {
    Transcriber.jaStaleStopMs = saved;
  }
}

async function proveStopWatch() {
  const saved = Transcriber.stopWatchMs;
  Transcriber.stopWatchMs = 30;
  try {
    const wedged = new Transcriber();
    wedged.language = 'ja-JP';
    wedged._isIOS = false;
    assert(wedged.start() === true, 'wedged stop-watch session starts');
    wedged.finalTranscript = LINE;
    wedged._gotHypothesis = true;
    const first = wedged.recognition;
    assert(wedged._unwedgeJaSession() === true, 'unwedge still stop()s');
    assert(first.stopped === true && first.aborted === false, 'unwedge watch uses stop, not abort');
    await wait(160);
    assert(wedged.recognition !== first, 'missing onend still restarts recognition');
    assert(wedged.isListening === true && wedged.shouldRestart === true, 'the watchdog does not end the session');
    assert(wedged.isEngineRunning() === true, 'the restarted engine is running');
    assert(wedged.finalTranscript.includes(LINE), 'the watchdog keeps the caption');
    wedged.stop();
  } finally {
    Transcriber.stopWatchMs = saved;
  }
}

proveSpeechEndFlush()
  .then(() => proveStopWatch())
  .then(() => {
console.log('\n--- summary ---');
rows.forEach((row) => {
  console.log(`${row.changed ? 'CHANGED' : 'SAME   '} ${row.name}`);
});
console.log(failed ? `\n${failed} assertion(s) failed` : '\nall assertions passed');
console.log('Live Chrome Web Speech was not executed. Rows are client-side handling of example hypotheses.');
process.exit(failed ? 1 : 0);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
