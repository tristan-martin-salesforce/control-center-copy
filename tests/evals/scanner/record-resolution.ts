/**
 * Offline cassette upkeep for the resolution check's golden runs (no model, no network, no spend):
 *   npx tsx tests/evals/scanner/record-resolution.ts [--show-missing] [--case <id>]
 * Re-keys hand-written entries by label after a prompt or skill change and lists the calls with no entry (with
 * --show-missing, their user prompts: placeholder data only, so a person can hand-write the reply).
 */
import { CassetteMissError, cassetteModel } from '@/scanner/completion/cassette';
import type { CompletionModel } from '@/scanner/completion/types';

import { loadGoldenCases } from './golden';
import { runCase } from './harness';
import { readResolutionCassette, resolutionLabel, resolutionSkillTag, writeResolutionCassette } from './resolution-cassettes';

const args = process.argv.slice(2);
const only = args.includes('--case') ? args[args.indexOf('--case') + 1] : undefined;

async function main(): Promise<number> {
  const skill = resolutionSkillTag();
  let missing = 0;
  for (const c of loadGoldenCases().filter((x) => !only || x.id === only)) {
    const file = readResolutionCassette(c.id);
    const cas = cassetteModel({ skill, entries: file.entries, labelOf: resolutionLabel, mode: 'rekey' });
    const prompts = new Map<string, string>();
    const model: CompletionModel = async (req) => {
      try {
        return await cas.model(req);
      } catch (err) {
        if (!(err instanceof CassetteMissError)) throw err;
        prompts.set(err.hash, req.user);
        return { ok: true, text: '{"verdicts":[]}', costUsd: 0, inputTokens: 0, outputTokens: 0 };
      }
    };
    await runCase(c, model, { closer: 'resolution' });
    const unused = file.entries.filter((e) => !e.hash || !cas.used.has(e.hash));
    if (cas.rekeyed.length) writeResolutionCassette(c.id, file);
    console.log(`${c.id}: ${cas.used.size} replayed, ${cas.rekeyed.length} re-keyed, ${cas.misses.length} missing, ${unused.length} unused`);
    for (const m of cas.misses) {
      missing += 1;
      console.log(`  missing ${m.hash}  label "${m.label}"`);
      if (args.includes('--show-missing')) console.log(`    user prompt: ${prompts.get(m.hash)}`);
    }
    for (const u of unused) console.log(`  unused  ${u.hash ?? '(no hash)'}  label "${u.label}"`);
  }
  return missing ? 1 : 0;
}

main().then((code) => process.exit(code));
