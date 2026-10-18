'use strict';

const fs = require('fs');
const path = require('path');

global.window = global;
Object.defineProperty(global, 'navigator', {
  configurable: true,
  value: {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36',
    platform: 'Linux',
    maxTouchPoints: 0
  }
});
global.document = { visibilityState: 'visible' };

const Transcriber = require('../../js/transcriber.js');
const AudioRecorder = require('../../js/recorder.js');
const UIManager = require('../../js/ui.js');
const { methodBody } = require('./_util');
const { runMandatorySkills, BUILD } = require('./index');

let failed = 0;
function assert(cond, message) {
  if (!cond) {
    failed += 1;
    console.error('FAIL:', message);
  }
}

const root = path.join(__dirname, '..', '..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css/style.css'), 'utf8');
const app = ['app.js', 'app-recording-health.js', 'app-recording-session.js']
  .map((name) => fs.readFileSync(path.join(root, 'js', name), 'utf8'))
  .join('\n');
const transcriberSrc = ['transcriber-policy.js', 'transcriber-ja-text.js', 'transcriber.js']
  .map((name) => fs.readFileSync(path.join(root, 'js', name), 'utf8'))
  .join('\n');
const recorderSrc = fs.readFileSync(path.join(root, 'js/recorder.js'), 'utf8');
const viz = fs.readFileSync(path.join(root, 'js/visualizer.js'), 'utf8');
const manifest = fs.readFileSync(path.join(root, 'manifest.json'), 'utf8');

const ctx = {
  root,
  index,
  sw,
  css,
  app,
  transcriberSrc,
  recorderSrc,
  viz,
  manifest,
  assert,
  methodBody,
  Transcriber,
  AudioRecorder,
  UIManager,
  BUILD,
  failed: 0
};

runMandatorySkills(ctx);
failed = ctx.failed;

console.log(failed ? `\n${failed} skill assertion(s) failed` : '\nall 7 mandatory skills passed');
process.exit(failed ? 1 : 0);
