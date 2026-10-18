'use strict';

/** 必須2: デスクトップは MediaRecorder → STT。iOS はジェスチャ内キック */
module.exports = {
  id: '02-session-start-order',
  name: '録音開始順序（マイク → ライブ STT）',
  run(ctx) {
    const { app, transcriberSrc, index, assert, methodBody } = ctx;
    assert(index.includes('app-recording-health.js'), 'app recording health module is loaded');
    assert(index.includes('app-recording-session.js'), 'app recording session module is loaded');
    assert(app.includes('_bootstrapLiveTranscriptionAfterMic'), 'mic open bootstraps live STT');
    assert(app.includes('_kickLiveRecognitionAtRecordStart'), 'record start kicks STT once');
    assert(app.includes('_kickIosRecognitionInRecordGesture'), 'ios STT starts after recording is armed');
    assert(app.includes('setLanguage(this._activeLanguage())'), 'language set before early STT kick');
    assert(app.includes('_reattachLiveSttAfterMic'), 'recording session reattaches STT after mic');
    assert(transcriberSrc.includes('startAckMs'), 'start ack prevents early gap nudge');
    assert(transcriberSrc.includes('iosStartAckMs'), 'ios has longer start ack');
    assert(transcriberSrc.includes('awaitingStartAck'), 'start waits for onstart before re-init');
    assert(transcriberSrc.includes('reattachAfterSharedMic'), 'mic open reattaches STT after ack stall');
    assert(
      methodBody(app, '_ensureLiveRecognition() {').includes('awaitingStartAck'),
      'ensure live skips ack wait appropriately'
    );
    assert(
      methodBody(app, '_checkCaptionHealth() {').includes('awaitingStartAck'),
      'caption health waits for onstart ack'
    );

    const startFn = app.slice(app.indexOf('async _startRecording'), app.indexOf('async _stopRecording'));
    const recorderAt = startFn.indexOf('this.recorder.start');
    const bootstrapAt = startFn.indexOf('_bootstrapLiveTranscriptionAfterMic');
    assert(recorderAt !== -1 && bootstrapAt > recorderAt, 'STT bootstrap runs right after mic open');
    const iosKickAt = startFn.indexOf('_kickIosRecognitionInRecordGesture');
    assert(iosKickAt !== -1 && recorderAt !== -1 && iosKickAt < recorderAt, 'iOS STT kick in click gesture before mic await');
    assert(
      transcriberSrc.includes('get startBeforeRecorder') && transcriberSrc.includes('return this._isIOS'),
      'iOS starts STT before mic, desktop after'
    );
    assert(app.includes('reattachAfterSharedMic({ micContended: true })'), 'post-mic STT always reattaches');
    return { ok: true };
  }
};
