import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES } from './helpers';

const SKILLS_DIR = join(__dirname, '..', '..', '..', 'skills');
const SKILLS = ['scan-gmail', 'scan-calendar', 'scan-gemini-notes', 'scan-drive', 'scan-claude-sessions', 'scan-trainings', 'scan-watch'];
const read = (n: string) => readFileSync(join(SKILLS_DIR, `${n}.md`), 'utf8');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('skills (SCANNER.md §4)', () => {
  it.each(SKILLS)('%s has versioned frontmatter and every required section', (name) => {
    const t = read(name);
    const fm = t.match(/^---\n([\s\S]*?)\n---/);
    expect(fm, 'frontmatter').toBeTruthy();
    expect(fm![1]).toMatch(new RegExp(`^skill: ${name}$`, 'm'));
    expect(fm![1]).toMatch(/^version: \d+$/m);
    expect(fm![1]).toMatch(/^model: claude-haiku-5-5$/m);
    // §4: scope, tool calls, traversal/extraction, linking, redaction, stop + coverage, worked examples
    expect(t).toMatch(/^## 1\. Scope/m);
    expect(t).toMatch(/^## .*(Exact (steps|tool calls))/m);
    expect(t).toMatch(/^## .*Extraction rules/m);
    expect(t).toMatch(/^## .*Linking rules/m);
    expect(t).toMatch(/^## .*Redaction/m);
    expect(t).toMatch(/^## .*Stop condition and coverage/m);
    expect(t).toMatch(/^## .*Worked examples/m);
    expect(t).toMatch(/^## Rules/m);
    expect((t.match(/^\*\*[A-F]\. /gm) ?? []).length, 'worked examples').toBeGreaterThanOrEqual(3);
    expect(t).toMatch(/cc_report_coverage/);
    expect(t).toMatch(/cc_finish/);
  });

  it('deterministic skills declare no MCP servers; watch declares only slack read tools', () => {
    for (const n of ['scan-gmail', 'scan-calendar', 'scan-gemini-notes', 'scan-drive', 'scan-claude-sessions']) expect(read(n)).toMatch(/^mcp_servers: \[\]/m);
    const w = read('scan-watch');
    expect(w).toMatch(/^mcp_servers: \[slack\]/m);
    for (const bad of ['slack_send_message', 'slack_add_reaction', 'slack_mark_read', 'slack_create_canvas', 'slack_update_canvas']) {
      expect(w.match(new RegExp(`^  - .*${bad}`, 'm')), bad).toBeNull();
    }
    expect(w).not.toMatch(/allowed_tools:[\s\S]*cc_propose_item[\s\S]*never_tools/);
  });

  it('R-UI-22: gmail and gemini notes teach the loop-back rule with a worked example', () => {
    for (const n of ['scan-gmail', 'scan-gemini-notes']) {
      const t = read(n);
      expect(t).toMatch(/R-UI-22/);
      expect(t).toMatch(/handed_off/);
      expect(t).toMatch(/`context` \*\*only\*\*|`context` only/);
      expect(t).toMatch(/loop_back:/);
      expect(t).toMatch(/Loop-back|loop-back/);
    }
    expect(read('scan-gemini-notes')).toMatch(/assignment to me|assigns me|assigned to me on that topic is a loop-back/);
  });

  it('scan-drive judges against expected.changes and says when the diff cannot tell', () => {
    const t = read('scan-drive');
    expect(t).toMatch(/expected\.changes/);
    expect(t).toMatch(/cannot_tell/);
    expect(t).toMatch(/image/i);
  });

  it('scan-claude-sessions documents both ids and the cc tag', () => {
    const t = read('scan-claude-sessions');
    expect(t).toMatch(/hostSessionId/);
    expect(t).toMatch(/\[cc:<id>\]/);
    expect(t).toMatch(/local_/);
  });

  it('scan-trainings documents the Slack hand-off for the runner', () => {
    const t = read('scan-trainings');
    expect(t).toMatch(/Slack hand-off/);
    expect(t).toMatch(/Astro's Course Tracker/);
    expect(t).toMatch(/slack_read_channel/);
  });
});

describe('fixtures are placeholders only', () => {
  const files = walk(FIXTURES);
  const ALLOWED_DOMAINS = /@(example\.com|customer\.example|partner\.example|mail\.example\.com|mail\.customer\.example)\b/;

  it('contains fixtures for every source', () => {
    for (const d of ['gmail', 'calendar', 'drive', 'gemini', 'claude', 'trainings']) expect(files.some((f) => f.includes(`/${d}/`)), d).toBe(true);
  });

  it('has no real-looking email addresses', () => {
    for (const f of [...files, ...SKILLS.map((s) => join(SKILLS_DIR, `${s}.md`))]) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
        expect(`${f}: ${m[0]}`, 'non-placeholder email').toMatch(ALLOWED_DOMAINS);
      }
    }
  });

  it('has no tokens, keys or customer names from the recordings', () => {
    // real customer and people names are checked by `npm run scan:private` (read from the local DB at run time, never listed here)
    const banned = /(xox[abp]-|sk-ant|Bearer [A-Za-z0-9]{12,}|eyJ[A-Za-z0-9_-]{10,}\.|00D[A-Za-z0-9]{12}!)/;
    for (const f of [...files, ...SKILLS.map((s) => join(SKILLS_DIR, `${s}.md`))]) {
      const text = readFileSync(f, 'utf8');
      const m = text.match(banned);
      expect(m ? `${f}: ${m[0]}` : null).toBeNull();
    }
  });
});
