'use strict';

/** 必須7: ライブ Web Speech + 停止後 Groq Whisper、録音保存 */
module.exports = {
  id: '07-two-phase-whisper',
  name: '二段構え（ライブ STT + 停止後 Whisper + 録音）',
  run(ctx) {
    const { app, index, sw, manifest, assert, BUILD } = ctx;
    const cacheTag = BUILD.startsWith('v') ? BUILD.slice(1) : BUILD;

    assert(app.includes('_finalizeTranscriptWithWhisper'), 'whisper finish lives in session mixin');
    assert(app.includes('_stageDraftFromStop'), 'stop shows draft play before save finishes');
    assert(index.includes('文字起こしの二段構え'), 'settings explain two-phase STT');
    assert(index.includes('app-live-stt-hint'), 'settings explain live STT limits');

    assert(index.includes(`v=${cacheTag}`), `index cache bust is ${BUILD}`);
    assert(sw.includes(`voicescribe-${BUILD}`), `sw cache name is ${BUILD}`);
    assert(!sw.includes('voicescribe-v95'), 'previous sw cache name gone');
    assert(
      app.includes(`APP_BUILD = '${BUILD}'`) || app.includes(`const APP_BUILD = '${BUILD}'`),
      `app build tag is ${BUILD}`
    );
    assert(app.includes(`sw.js?v=${cacheTag}`), 'service worker registration is cache-busted');
    assert(manifest.includes(`./?v=${cacheTag}`), 'manifest start_url cache bust');

    assert(index.includes('transcriber-policy.js'), 'transcriber policy module is loaded');
    assert(index.includes('transcriber-ja-text.js'), 'transcriber ja text module is loaded');
    return { ok: true };
  }
};
