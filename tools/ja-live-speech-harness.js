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
assert(appendNow('ja-JP', ['えーと今日はいい天気ですね']) === '今日はいい天気ですね。', 'quiet filler');

record(
  'demonstrative kept',
  appendV57('ja-JP', ['あのー資料は事前に共有してください']),
  appendNow('ja-JP', ['あのー資料は事前に共有してください'])
);
assert(
  appendNow('ja-JP', ['あのー資料は事前に共有してください']) === 'あの資料は事前に共有してください。',
  'あのー must keep あの'
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
assert(iosProfile.abs === 0.018 && iosProfile.gapMs === 600, 'iOS profile unchanged');
assert(enProfile.resultMs === 2500 && enProfile.stallMs === 2000, 'english stall unchanged');

record(
  'desktop restart ms (no-speech / end)',
  `en ${Transcriber.restartDelay('no-speech', false, 'en-US')}/${Transcriber.restartDelay('end', false, 'en-US')} ios ${Transcriber.restartDelay('no-speech', true, 'ja-JP')}/${Transcriber.restartDelay('end', true, 'ja-JP')}`,
  `ja ${Transcriber.restartDelay('no-speech', false, 'ja-JP')}/${Transcriber.restartDelay('end', false, 'ja-JP')}`
);
assert(Transcriber.restartDelay('no-speech', false, 'en-US') === 25, 'en no-speech');
assert(Transcriber.restartDelay('end', false, 'en-US') === 35, 'en end');
assert(Transcriber.restartDelay('stall', false, 'en-US') === 30, 'en stall');
assert(Transcriber.restartDelay('no-speech', true, 'ja-JP') === 70, 'ios no-speech');
assert(Transcriber.restartDelay('end', true, 'ja-JP') === 90, 'ios end');
assert(Transcriber.restartDelay('no-speech', false, 'ja-JP') === 15, 'ja no-speech');
assert(Transcriber.restartDelay('end', false, 'ja-JP') === 20, 'ja end');

assert(Transcriber.shouldRecoverHungRecognition({
  language: 'ja-JP', ios: false, msSinceResult: 900, hasInterim: true
}) === true, 'ja hung interim');
assert(Transcriber.shouldRecoverHungRecognition({
  language: 'ja-JP', ios: false, msSinceResult: 900, hasInterim: false
}) === false, 'no interim means do not abort');
assert(Transcriber.shouldRecoverHungRecognition({
  language: 'en-US', ios: false, msSinceResult: 5000, hasInterim: true
}) === false, 'english hung watch off');
assert(Transcriber.shouldRecoverHungRecognition({
  language: 'ja-JP', ios: true, msSinceResult: 5000, hasInterim: true
}) === false, 'ios hung watch off');

const jaMic = AudioRecorder.speechAudioConstraints('ja-JP', false);
const enMic = AudioRecorder.speechAudioConstraints('en-US', false);
const iosMic = AudioRecorder.speechAudioConstraints('ja-JP', true);
const bareMic = AudioRecorder.speechAudioConstraints();
record(
  'mic noiseSuppression ideal',
  `en ${enMic.noiseSuppression.ideal} ios-ja ${iosMic.noiseSuppression.ideal} default ${bareMic.noiseSuppression.ideal}`,
  `desktop-ja ${jaMic.noiseSuppression.ideal} agc ${jaMic.autoGainControl.ideal}`
);
assert(jaMic.noiseSuppression.ideal === false, 'ja desktop asks NS off');
assert(jaMic.autoGainControl.ideal === true, 'ja keeps AGC');
assert(jaMic.googNoiseSuppression === false, 'ja goog NS off');
assert(enMic.noiseSuppression.ideal === true && enMic.googNoiseSuppression === true, 'en NS on');
assert(iosMic.noiseSuppression.ideal === true, 'ios NS on');
assert(bareMic.noiseSuppression.ideal === true && bareMic.googAutoGainControl === true, 'default constraints stay v57');

const root = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
const transcriberSrc = fs.readFileSync(path.join(root, 'js/transcriber.js'), 'utf8');
assert(!index.includes('v=57'), 'index cache bust left 57');
assert(index.includes('v=58'), 'index is v58');
assert(sw.includes("voicescribe-v58"), 'sw cache name');
assert(!sw.includes('voicescribe-v57'), 'old sw name gone');
const micCalls = (src) => (src.match(/\.getUserMedia\s*\(/g) || []).length;
assert(micCalls(app) === 0, 'app must not open a mic');
assert(micCalls(transcriberSrc) === 0, 'transcriber must not open a mic');
assert(micCalls(fs.readFileSync(path.join(root, 'js/recorder.js'), 'utf8')) === 2, 'still one mic open path');

const startFn = app.slice(app.indexOf('async _startRecording'), app.indexOf('async _stopRecording'));
const recorderAt = startFn.indexOf('this.recorder.start');
const desktopStart = startFn.indexOf('this.transcriber.start', recorderAt);
const iosStart = startFn.lastIndexOf('this.transcriber.start', recorderAt);
assert(iosStart !== -1 && iosStart < recorderAt, 'iOS recognition stays before recorder');
assert(desktopStart > recorderAt, 'desktop recognition stays after recorder');
assert(startFn.includes('if (!recognitionFirst)'), 'desktop path is gated');

console.log('\n--- summary ---');
rows.forEach((row) => {
  console.log(`${row.changed ? 'CHANGED' : 'SAME   '} ${row.name}`);
});
console.log(failed ? `\n${failed} assertion(s) failed` : '\nall assertions passed');
console.log('Live Chrome Web Speech was not executed. Rows are client-side handling of example hypotheses.');
process.exit(failed ? 1 : 0);
