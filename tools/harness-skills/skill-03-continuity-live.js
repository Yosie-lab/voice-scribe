'use strict';

/** 必須3: 動いている desktop ja エンジンを stop/unwedge しない */
module.exports = {
  id: '03-continuity-live',
  name: 'ライブエンジン連続性（desktop ja）',
  run(ctx) {
    const { app, transcriberSrc, assert, methodBody } = ctx;
    assert(
      methodBody(transcriberSrc, '  reviveLiveCaption() {').includes('!this.isZombieEngine()'),
      'running desktop engine is not stop-unwedged'
    );
    assert(transcriberSrc.includes('msSinceCaptionChange'), 'stall uses caption content time');
    assert(transcriberSrc.includes('reviveLiveCaption'), 'caption can recover without stopping recorder');
    assert(app.includes('_checkCaptionHealth'), 'caption health runs without the level meter');
    assert(app.includes('_liveRecoveryBlocked'), 'live recovery guard is shared');
    assert(app.includes('_needsDeadEngineRevive'), 'dead-engine revive is separate from live engine');

    const liveWatch = methodBody(transcriberSrc, '  _armJaLiveWatch() {');
    assert(liveWatch && !liveWatch.includes('.abort('), 'ja live watch does not abort');
    assert(liveWatch.includes('.stop()'), 'ja live watch asks Chrome to return a result');
    const ingest = methodBody(transcriberSrc, '  _ingestResult(event) {');
    assert(ingest && !ingest.includes('.abort(') && !ingest.includes('.stop('), 'result commit does not end the session');
    assert(transcriberSrc.includes('useContinuous'), 'continuous policy is named');
    assert(transcriberSrc.includes("this.recognition.lang = this.language"), 'recognition.lang follows setLanguage');
    return { ok: true };
  }
};
