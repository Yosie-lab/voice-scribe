'use strict';

/** 必須4: 止まった／ゾンビ認識の自動復旧（stop、abort しない） */
module.exports = {
  id: '04-dead-engine-revive',
  name: '死んだエンジン・字幕ストールの自動復旧',
  run(ctx) {
    const { app, transcriberSrc, Transcriber, assert, methodBody } = ctx;
    assert(app.includes('_autoRecoverLiveStt'), 'app auto-recovers stalled STT');
    assert(transcriberSrc.includes('isZombieEngine'), 'zombie onstart without captions is detectable');
    assert(app.includes('isZombieEngine()'), 'app reattaches when recognition is zombie');
    assert(transcriberSrc.includes('stallAutoRestartMs'), 'revive uses unified stall restart ms');
    assert(transcriberSrc.includes('captionHealthPollMs'), 'caption poll interval is named in policy');
    assert(
      methodBody(app, '_startCaptionWatch() {').includes('captionHealthPollMs'),
      'caption health uses policy poll ms'
    );

    assert(Transcriber.stallAutoRestartMs === 1400, 'dead-engine restart gap (v96 snappy)');
    assert(Transcriber.captionStaleMs === 2800, 'desktop stall detect avoids cutting live engine');
    assert(Transcriber.iosCaptionStaleMs === 3000, 'ios stall detect');
    assert(Transcriber.jaStaleStopMs > Transcriber.captionStaleMs, 'ja stop stays after stall restart');
    assert(Transcriber.captionHealthPollMs === 250, 'caption health polls faster');

    assert(!transcriberSrc.includes('jaHungWatchMs'), '900ms speechend abort is gone');
    assert(!transcriberSrc.includes('shouldRecoverHungRecognition'), 'dead speechend abort policy is gone');
    const unwedge = methodBody(transcriberSrc, '  _unwedgeJaSession() {');
    assert(unwedge && !unwedge.includes('.abort('), 'ja unwedge does not abort');
    assert(unwedge.includes('.stop()'), 'ja unwedge asks Chrome for a result');
    assert(unwedge.includes('_armStopWatch'), 'stop() without onend still restarts recognition');
    const flush = methodBody(transcriberSrc, '  _armJaSpeechEndFlush() {');
    assert(flush && !flush.includes('.abort('), 'speechend flush does not abort');
    const restartNow = methodBody(transcriberSrc, '  _restartNow() {');
    assert(restartNow && !restartNow.includes('this.stop()'), 'failed recognition restarts do not end the session');
    assert(transcriberSrc.includes('isCaptionStalled'), 'zombie caption detection exists');
    assert(transcriberSrc.includes('inIosPhraseGap'), 'ios phrase gap avoids false stall');
    assert(transcriberSrc.includes('iosCaptionBootMs'), 'ios waits longer before caption stall revive');
    return { ok: true };
  }
};
