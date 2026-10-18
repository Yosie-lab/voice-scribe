'use strict';

/** 必須1: 録音前・待機中にライブ STT を出さない */
module.exports = {
  id: '01-idle-no-stt',
  name: '待機画面にライブ字幕を出さない',
  run(ctx) {
    const { app, index, css, transcriberSrc, assert, methodBody } = ctx;
    assert(app.includes('_haltLiveTranscription'), 'idle STT is torn down off-session');
    assert(
      methodBody(app, '_bindLiveTranscriptCallback() {').includes('!this.isRecording'),
      'live captions only while recording'
    );
    assert(!app.includes('_gestureKickRecognition'), 'record pointerdown does not pre-start STT');
    assert(!css.includes('caption-stalled-recording'), 'no resume UI class in css');
    assert(!index.includes('resume-reading-header-btn'), 'header resume button removed');
    assert(!index.includes('resume-reading-btn'), 'deck resume button removed');
    assert(!index.includes('>再開<'), 'no manual STT resume label in html');
    assert(transcriberSrc.includes('manualResumeListening'), 'internal restart path stays available');
    assert(!app.includes('async _resumeReading()'), 'manual resume handler removed');
    assert(!app.includes('onListeningChange'), 'listening change does not feedback auto-recover');
    return { ok: true };
  }
};
