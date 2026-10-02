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

assert(Transcriber.useContinuous('ja-JP', false) === false, 'desktop ja is utterance mode');
assert(Transcriber.useContinuous('ja-JP', true) === false, 'ios ja stays utterance mode');
assert(Transcriber.useContinuous('en-US', false) === true, 'english desktop stays continuous');

assert(Transcriber.shouldRecoverHungRecognition({
  language: 'ja-JP', ios: false, msSinceResult: 900, hasInterim: true
}) === false, 'speechend does not abort a ja interim');
assert(Transcriber.shouldRecoverHungRecognition({
  language: 'ja-JP', ios: false, msSinceResult: 5000, hasInterim: false
}) === false, 'no speechend abort without interim');
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
const app = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
const transcriberSrc = fs.readFileSync(path.join(root, 'js/transcriber.js'), 'utf8');
const viz = fs.readFileSync(path.join(root, 'js/visualizer.js'), 'utf8');
assert(viz.includes('getSpeechPeak'), 'frame peak for short bursts');
assert(viz.includes('_sampleSpeechPeak'), 'peak is sampled while drawing');
assert(app.includes('usePeak'), 'desktop ja watch reads the peak');
assert(app.includes('speechHotFlags'), 'stall does not reuse the gap peak');
assert(!index.includes('v=60'), 'index cache bust left 60');
assert(index.includes('v=61'), 'index is v61');
assert(sw.includes("voicescribe-v61"), 'sw cache name');
assert(!sw.includes('voicescribe-v60'), 'old sw name gone');
const micCalls = (src) => (src.match(/\.getUserMedia\s*\(/g) || []).length;
const recorderSrc = fs.readFileSync(path.join(root, 'js/recorder.js'), 'utf8');
assert(micCalls(viz) === 0, 'visualizer does not open a mic');
assert(micCalls(app) === 0, 'app must not open a mic');
assert(micCalls(transcriberSrc) === 0, 'transcriber must not open a mic');
assert(micCalls(recorderSrc) === 2, 'still one mic open path');
assert(!recorderSrc.includes('noiseSuppression: false'), 'no exact NS off before recognition');
assert(transcriberSrc.includes("this.language = 'ja-JP'"), 'default language stays ja-JP');
assert(transcriberSrc.includes('this.recognition.lang = this.language'), 'recognition.lang follows setLanguage');
const watchStart = transcriberSrc.indexOf('  _armJaLiveWatch() {');
const liveWatch = transcriberSrc.slice(watchStart, transcriberSrc.indexOf('  _restartDelayFor', watchStart));
assert(watchStart !== -1 && !liveWatch.includes('.abort('), 'ja live watch does not abort');
assert(liveWatch.includes('.stop()'), 'ja live watch asks Chrome to return a result');
assert(!transcriberSrc.includes('jaHungWatchMs'), '900ms speechend abort is gone');

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
assert(jaLive.nudge('stall') === false, 'live ja speech is not stall-aborted');
assert(jaAborted === false, 'stall does not call abort or stop on ja');

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

console.log('\n--- summary ---');
rows.forEach((row) => {
  console.log(`${row.changed ? 'CHANGED' : 'SAME   '} ${row.name}`);
});
console.log(failed ? `\n${failed} assertion(s) failed` : '\nall assertions passed');
console.log('Live Chrome Web Speech was not executed. Rows are client-side handling of example hypotheses.');
process.exit(failed ? 1 : 0);
