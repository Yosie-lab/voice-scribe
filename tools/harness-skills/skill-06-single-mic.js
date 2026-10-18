'use strict';

const { micCalls } = require('./_util');

/** 必須6: getUserMedia は recorder 一本。STT は共有ストリーム */
module.exports = {
  id: '06-single-mic',
  name: 'マイク単一路（録音＋認識の共有）',
  run(ctx) {
    const { app, transcriberSrc, recorderSrc, viz, AudioRecorder, assert } = ctx;

    assert(micCalls(viz) === 0, 'visualizer does not open a mic');
    assert(micCalls(app) === 0, 'app must not open a mic');
    assert(micCalls(transcriberSrc) === 0, 'transcriber must not open a mic');
    assert(micCalls(recorderSrc) === 2, 'still one mic open path');
    assert(!recorderSrc.includes('noiseSuppression: false'), 'no exact NS off before recognition');

    const jaMic = AudioRecorder.speechAudioConstraints('ja-JP', false);
    const enMic = AudioRecorder.speechAudioConstraints('en-US', false);
    assert(jaMic.noiseSuppression.ideal === true, 'ja desktop keeps NS on');
    assert(jaMic.googNoiseSuppression === true, 'ja goog NS stays on');
    assert(
      jaMic.noiseSuppression.ideal === enMic.noiseSuppression.ideal
        && jaMic.googNoiseSuppression === enMic.googNoiseSuppression,
      'ja mic constraints match english'
    );

    const recoverFn = ctx.methodBody(app, 'async _recoverActiveRecordingBody() {');
    assert(recoverFn && !recoverFn.includes('_stopRecording'), 'a lost mic does not end the recording');
    assert(recoverFn.includes('ensureCapture'), 'a lost mic reopens through the recorder');

    return { ok: true };
  }
};
