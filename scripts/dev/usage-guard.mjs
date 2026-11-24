#!/usr/bin/env node
/**
 * usage-guard: keeps an orchestration session inside its Claude quota until a deadline, and says which model tier
 * the next sub-agent should run on. Claude Code exposes no quota API, so the inputs are marks the user reports
 * ("43% used, 10 hours left") and the token counts each sub-agent's completion notification carries.
 *
 *   npm run usage:guard -- --mark 43 --hours-left 10        record a user-reported mark (percent used, time left)
 *   npm run usage:guard -- --spent 390705 p4-page-reads     book a sub-agent's tokens (from its notification)
 *   npm run usage:guard -- --status                          burn rate, projection at the deadline, the tier to use
 *   npm run usage:guard -- --reset                           start over
 *
 * Projection between marks: percent ≈ last mark + tokens booked since / tokens-per-percent. The ratio is calibrated
 * from two marks when there are two; before that it uses the seed below (a session's early estimate, say so in status).
 * Tiers, from the projected percent at the deadline. The quota is there to be used: the target is to land at 100 at
 * the deadline, with the work finished (Tristan, 2026-11-21: "we can go to 100%, would actually rather we did that").
 *   < 90   under-spending: opus for every builder and review, run more chunks in parallel (the load guard permits)
 *   ≤ 100  on track: opus for hard chunks and reviews, sonnet for mechanical ones
 *   ≤ 105  slightly hot: sonnet for builders, opus only for a review that gates a merge
 *   ≤ 112  hot: sonnet/haiku builders, no fork reviews
 *   > 112  stop dispatching; finish integration only, report
 * State: ~/Library/Logs/usage-guard.json. Nothing here calls the API.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE = path.join(os.homedir(), 'Library', 'Logs', 'usage-guard.json');
const SEED_TOKENS_PER_PERCENT = 400_000;
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i === -1 ? undefined : argv[i + 1]; };
const load = () => (fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : { marks: [], spent: [] });
const save = (s) => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(s, null, 2) + '\n'); };
const now = Date.now();

if (argv.includes('--reset')) { save({ marks: [], spent: [] }); console.log('usage-guard: reset'); process.exit(0); }

const state = load();
if (arg('--mark') !== undefined) {
  const percent = Number(arg('--mark'));
  const hoursLeft = Number(arg('--hours-left') ?? NaN);
  if (!Number.isFinite(percent)) { console.error('--mark needs a percent'); process.exit(2); }
  const mark = { at: now, percent, spentBefore: state.spent.reduce((a, s) => a + s.tokens, 0) };
  if (Number.isFinite(hoursLeft)) mark.deadline = now + hoursLeft * 3600_000;
  state.marks.push(mark);
  save(state);
  console.log(`usage-guard: marked ${percent}% used${Number.isFinite(hoursLeft) ? `, deadline in ${hoursLeft} h (${new Date(mark.deadline).toLocaleString()})` : ''}`);
}
if (arg('--spent') !== undefined) {
  const tokens = Number(arg('--spent'));
  const label = argv[argv.indexOf('--spent') + 2] ?? 'unlabelled';
  if (!Number.isFinite(tokens)) { console.error('--spent needs a token count'); process.exit(2); }
  state.spent.push({ at: now, tokens, label });
  save(state);
  console.log(`usage-guard: booked ${tokens.toLocaleString()} tokens for ${label}`);
}

// ---- status (always printed) ----
const marks = state.marks;
if (!marks.length) { console.log('usage-guard: no marks yet. Record one: --mark <percent> --hours-left <h>'); process.exit(0); }
const last = marks.at(-1);
const totalSpent = state.spent.reduce((a, s) => a + s.tokens, 0);
const sinceMark = totalSpent - last.spentBefore;
let tokensPerPercent = SEED_TOKENS_PER_PERCENT, calibrated = false;
if (marks.length >= 2) {
  const a = marks.at(-2), b = last;
  const dp = b.percent - a.percent, dt = b.spentBefore - a.spentBefore;
  if (dp > 0 && dt > 0) { tokensPerPercent = dt / dp; calibrated = true; }
}
const estimatedNow = last.percent + sinceMark / tokensPerPercent;
const deadline = [...marks].reverse().find((m) => m.deadline)?.deadline;
const hoursLeft = deadline ? Math.max(0, (deadline - now) / 3600_000) : null;
// the burn rate needs a window: under an hour after a mark, one booked agent would look like a runaway
const hoursSinceMark = Math.max((now - last.at) / 3600_000, 1);
const burnPerHour = sinceMark / tokensPerPercent / hoursSinceMark; // %/h over at least one hour
const projected = hoursLeft !== null ? estimatedNow + burnPerHour * hoursLeft : null;
const budgetPerHour = hoursLeft !== null && hoursLeft > 0 ? (100 - estimatedNow) / hoursLeft : null;
const tier = (p) =>
  p < 90 ? 'UNDER-SPENDING: opus for every builder and review; run more in parallel'
  : p <= 100 ? 'on track: opus for hard chunks and reviews, sonnet for mechanical ones'
  : p <= 105 ? 'slightly hot: sonnet for builders, opus only for a gating review'
  : p <= 112 ? 'hot: sonnet/haiku builders, no fork reviews'
  : 'STOP dispatching; integrate and report';
const basis = projected ?? estimatedNow;
console.log(`usage-guard: ${estimatedNow.toFixed(1)}% used now (last mark ${last.percent}% ${hoursSinceMark.toFixed(1)} h ago + ${sinceMark.toLocaleString()} tokens booked since; ${calibrated ? 'calibrated' : 'SEED'} ${Math.round(tokensPerPercent).toLocaleString()} tokens/%)`);
if (hoursLeft !== null) console.log(`usage-guard: ${hoursLeft.toFixed(1)} h to the deadline · burning ${burnPerHour.toFixed(1)}%/h · budget ${budgetPerHour?.toFixed(1)}%/h · projected ${projected.toFixed(0)}% at the deadline`);
console.log(`usage-guard: tier → ${tier(basis)}`);
process.exit(basis > 112 ? 3 : 0);
