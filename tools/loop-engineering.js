#!/usr/bin/env node
/**
 * VoiceScribe loop engineering: measure → change one lever → remeasure.
 *
 *   node tools/loop-engineering.js           # 7 skills + full ja-live-speech-harness
 *   node tools/loop-engineering.js --skills-only
 *
 * Hillclimb round log (append to tools/LOOP_ROUNDS.md):
 *   Fixture: node tools/loop-engineering.js
 *   Hypothesis: …
 *   Change: …
 *   Before → after: …
 *   Verdict: keep | revert
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const skillsOnly = process.argv.includes('--skills-only');

function runNode(script) {
  const r = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe']
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.status ?? 1;
}

console.log('## Loop engineering — mandatory 7 skills\n');
const skillStatus = runNode(path.join(__dirname, 'harness-skills', 'run-standalone.js'));
if (skillStatus !== 0) {
  console.error('\nMandatory skills failed. Fix before hillclimb.');
  process.exit(skillStatus);
}

if (skillsOnly) {
  console.log('\nSkills-only mode: full harness skipped.');
  process.exit(0);
}

console.log('\n## Full ja-live-speech-harness\n');
const harnessStatus = runNode(path.join(__dirname, 'ja-live-speech-harness.js'));
process.exit(harnessStatus);
