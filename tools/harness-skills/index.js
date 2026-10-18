'use strict';

const SKILLS = [
  require('./skill-01-idle-no-stt'),
  require('./skill-02-session-start-order'),
  require('./skill-03-continuity-live'),
  require('./skill-04-dead-engine-revive'),
  require('./skill-05-ja-transcript'),
  require('./skill-06-single-mic'),
  require('./skill-07-two-phase-whisper')
];

/**
 * @param {object} ctx — assert, app, transcriberSrc, Transcriber, …
 * @returns {{ failed: number, results: Array<{id: string, name: string}> }}
 */
function runMandatorySkills(ctx) {
  const results = [];
  for (const skill of SKILLS) {
    console.log(`\n### skill ${skill.id}: ${skill.name}`);
    try {
      skill.run(ctx);
      results.push({ id: skill.id, name: skill.name, status: 'pass' });
      console.log(`OK  ${skill.id}`);
    } catch (error) {
      ctx.failed += 1;
      results.push({ id: skill.id, name: skill.name, status: 'fail', error: String(error) });
      console.error(`FAIL skill ${skill.id}:`, error.message || error);
    }
  }
  return { failed: ctx.failed, results };
}

module.exports = {
  SKILLS,
  runMandatorySkills,
  BUILD: 'v96'
};
