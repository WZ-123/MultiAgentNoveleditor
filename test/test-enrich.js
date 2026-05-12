'use strict';

/**
 * Test enrich_character tool's search engine.
 * Calls the character enricher for a real character to see if web search works.
 */
const path = require('node:path');
const fs = require('node:fs');

const USER_DATA = path.join(
  process.env.HOME || '',
  'Library/Application Support/multi-agent-novel-assistant/MultiAgentNovelAssistant'
);
const cfg = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'app-config.json'), 'utf8'));
const novels = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'novels.json'), 'utf8'));
const novel = novels.novels.find(n => n.id === cfg.lastNovelId);
console.log('Novel:', novel?.title);
console.log('Dir:', novel?.dir);

const charsDir = path.join(novel.dir, 'characters');
const charFiles = fs.readdirSync(charsDir).filter(f => f.endsWith('.json'));
const chars = charFiles.map(f => JSON.parse(fs.readFileSync(path.join(charsDir, f), 'utf8')));

// Pick a real fanwork character with sourceWork
const atago = chars.find(c => c.name === '爱宕' || c.name.includes('爱宕'));
if (!atago) {
  console.log('爱宕 not found, trying first character with sourceWork');
  // Just pick any character
}
const target = atago || chars[0];
console.log('\nTarget character:', target.name, `(id=${target.id})`);
console.log('sourceWork:', target.sourceWork || '(not set)');
console.log('isOriginal:', target.isOriginal);

// Load the enricher
const enricher = require('../src/main/import/characterEnricher');

async function main() {
  console.log('\nCalling enrichCharacters...');
  console.time('enrich');
  try {
    const results = await enricher.enrichCharacters(
      [target],
      null,      // worldOutput
      'zh-CN',   // userLang
      { fanworkNameOverride: target.sourceWork || '碧蓝航线' }
    );
    console.timeEnd('enrich');

    const r = results[0];
    console.log('\n--- Result ---');
    console.log('status:', r._enrichmentStatus);
    console.log('source:', r._enrichmentSource);

    const fields = ['name', 'hairColor', 'eyeColor', 'height', 'figure', 'personality', 'appearance', 'background', 'moeTraits', 'quotes', 'skins'];
    let changed = 0;
    for (const f of fields) {
      if (r[f] !== undefined && r[f] !== '' && r[f] !== target[f]) {
        console.log(`\n${f}:`);
        console.log('  before:', JSON.stringify(target[f] || '').slice(0, 100));
        console.log('  after: ', JSON.stringify(r[f]).slice(0, 200));
        changed++;
      }
    }
    if (changed === 0) {
      console.log('  (no fields changed from web data)');
    }

    if (r._enrichmentStatus === 'success') {
      console.log('\n✅ Enrichment succeeded!');
    } else {
      console.log(`\n❌ Enrichment failed: ${r._enrichmentStatus}`);
    }
  } catch (e) {
    console.timeEnd('enrich');
    console.error('\n❌ Error:', e.message);
    console.error(e.stack?.split('\n').slice(0, 5).join('\n'));
  }
}

main().catch(e => console.error(e));
