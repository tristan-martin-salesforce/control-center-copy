#!/usr/bin/env node
/**
 * load-guard: watches this Mac's load and memory while agents build in parallel, and keeps it from falling over.
 *
 *   node scripts/dev/load-guard.mjs            run in the foreground (Ctrl-C resumes everything it paused)
 *   npm run load:guard -- --start              start it in the background (log: ~/Library/Logs/load-guard.log)
 *   npm run load:guard -- --stop               stop the background guard (it resumes everything first)
 *   npm run load:guard -- --once               print one reading and the processes it would manage; change nothing
 *   npm run load:guard -- --resume-all         SIGCONT every stopped build process, then exit
  *   npm run load:guard -- --drill              pause the heaviest managed group for 3 s, check it stopped, resume it, check again
 *   --root <regex>                             which checkouts' processes to manage (default: the (control|command)-center checkouts)
 *
 * What it manages: build and test processes only (vitest, next, tsc, esbuild, drizzle-kit, tsx, npm run/test and
 * their node children). Never Claude Code, Orca, terminals, browsers, Postgres or launchd services.
 *
 * Signals go to the build processes one by one, never to a process group (a shell or Claude Code may share it).
 *
 * Three tiers, with hysteresis so it does not flap:
 *   hot   load1 > cores x 1.25 for 2 samples        renice the managed processes to 19 (CPU yields to you)
 *   critical  memory pressure critical, or free+inactive < 1.5 GB, or pressure warn with swap nearly full
 *                                                    SIGSTOP the heaviest managed process group, one per sample,
 *                                                    until pressure clears (a paused test run may time out; a crash is worse)
 *   calm  pressure normal and load1 < cores x 0.8 for 3 samples
 *                                                    SIGCONT the most recently paused group, one every 10 s
 * A group paused longer than 10 minutes is resumed once pressure is no worse than "warn". On start it resumes any
 * stopped build process it finds; on exit it resumes everything it paused. macOS only (vm_stat, sysctl, ps, renice).
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const LOG_DIR = path.join(HOME, 'Library', 'Logs');
const LOG = path.join(LOG_DIR, 'load-guard.log');
const PIDFILE = path.join(LOG_DIR, 'load-guard.pid');
const CORES = os.cpus().length;
const SAMPLE_MS = 3000;
const HOT_LOAD = CORES * 1.25;
const CALM_LOAD = CORES * 0.8;
const MIN_FREE_BYTES = 1.5 * 1024 ** 3;
const MIN_SWAP_FREE_MB = 256;
const RESUME_EVERY_MS = 10_000;
const MAX_PAUSE_MS = 10 * 60_000;
const PRESSURE = { 1: 'normal', 2: 'warn', 4: 'critical' };

const MANAGED = /(vitest|next(-server)?( dev| build| start)?|\/tsc(\s|$)|\btsc\b|esbuild|drizzle-kit|\btsx\b|npm (run|test|exec)|npx |node_modules\/\.bin\/)/;
const NEVER = /(claude|orca|Code Helper|Electron|Terminal|iTerm|Chrome|Safari|Arc|postgres|launchd|load-guard|concurrently)/i;

const argv = process.argv.slice(2);
const args = new Set(argv);
const rootArg = argv[argv.indexOf('--root') + 1];
const ROOT = new RegExp(argv.includes('--root') && rootArg ? rootArg : '(control|command)-center');
const log = (line) => {
  const msg = `${new Date().toISOString()} ${line}`;
  console.log(msg);
};

function sh(cmd, argv) {
  try { return execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; }
}

function reading() {
  const load1 = os.loadavg()[0];
  const vm = sh('vm_stat', []);
  const swap = sh('sysctl', ['-n', 'vm.swapusage']);
  // A failed spawn reads as "no memory"; a skipped sample is safer than pausing everything on a blank reading.
  if (!/Pages free/.test(vm) || !/free = /.test(swap)) return null;
  const page = Number(/page size of (\d+)/.exec(vm)?.[1] ?? 16384);
  const pages = (name) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(vm)?.[1] ?? 0);
  const freeBytes = (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative')) * page;
  const swapFreeMb = Number(/free = ([\d.]+)M/.exec(swap)?.[1] ?? 1e9);
  const swapUsedMb = Number(/used = ([\d.]+)M/.exec(swap)?.[1] ?? 0);
  const pressure = Number(sh('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']).trim() || 1);
  return { load1, freeBytes, swapFreeMb, swapUsedMb, pressure };
}

function managedProcesses() {
  const out = sh('ps', ['-axo', 'pid=,pgid=,ppid=,stat=,pcpu=,rss=,command=']);
  const all = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, pid, pgid, ppid, stat, pcpu, rss, command] = m;
    if (Number(pid) === process.pid) continue;
    all.push({ pid: Number(pid), pgid: Number(pgid), ppid: Number(ppid), stat, pcpu: Number(pcpu), rssMb: Number(rss) / 1024, command: command.slice(0, 110) });
  }
  // A build process of one of our checkouts. vitest and next rename themselves ("node (vitest)", "next-server"), so a
  // process with no path counts when its parent's command names the checkout (the Bash tool's zsh -c wrapper does,
  // and is itself never managed), and children of a managed process are managed too.
  const byPid = new Map(all.map((r) => [r.pid, r]));
  const isBuild = (r) => MANAGED.test(r.command) && !NEVER.test(r.command);
  const managed = new Set(all.filter((r) => isBuild(r) && (ROOT.test(r.command) || ROOT.test(byPid.get(r.ppid)?.command ?? ''))).map((r) => r.pid));
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of all) if (!managed.has(r.pid) && managed.has(r.ppid) && !NEVER.test(r.command)) { managed.add(r.pid); grew = true; }
  }
  return all.filter((r) => managed.has(r.pid));
}

/** Process groups by weight (memory first, then CPU), heaviest first. */
function groups(rows) {
  const byPgid = new Map();
  for (const r of rows) {
    const g = byPgid.get(r.pgid) ?? { pgid: r.pgid, pids: [], rssMb: 0, pcpu: 0, stopped: false, label: r.command };
    g.pids.push(r.pid); g.rssMb += r.rssMb; g.pcpu += r.pcpu; if (r.stat.includes('T')) g.stopped = true;
    if (r.rssMb > (byPgid.get(r.pgid)?.maxRss ?? 0)) { g.maxRss = r.rssMb; g.label = r.command; }
    byPgid.set(r.pgid, g);
  }
  return [...byPgid.values()].sort((a, b) => b.rssMb + b.pcpu * 10 - (a.rssMb + a.pcpu * 10));
}

const fmt = (r) => `load1 ${r.load1.toFixed(1)}/${CORES} · pressure ${PRESSURE[r.pressure] ?? r.pressure} · free+inactive ${(r.freeBytes / 1024 ** 3).toFixed(1)} GB · swap used ${Math.round(r.swapUsedMb)} MB, free ${Math.round(r.swapFreeMb)} MB`;

/**
 * Signals the managed pids of a group one by one, never the group itself: a build started from a shell shares that
 * shell's process group (and often Claude Code's), and kill(-pgid) would freeze the shell, the agent and the guard.
 */
function signalGroup(pgid, sig) {
  if (pgid === process.pid || pgid === processGroupOfSelf()) return false;
  const pids = managedProcesses().filter((r) => r.pgid === pgid).map((r) => r.pid);
  let ok = 0;
  for (const pid of pids) { try { process.kill(pid, sig); ok++; } catch { /* gone */ } }
  return ok > 0;
}
const processGroupOfSelf = () => Number(sh('ps', ['-o', 'pgid=', '-p', String(process.pid)]).trim() || -1);

function resumeAllStopped(reason) {
  const stopped = groups(managedProcesses()).filter((g) => g.stopped);
  for (const g of stopped) if (signalGroup(g.pgid, 'SIGCONT')) log(`resume pgid ${g.pgid} (${g.label}) · ${reason}`);
  return stopped.length;
}

if (args.has('--once')) {
  const r = reading();
  log(fmt(r));
  for (const g of groups(managedProcesses())) log(`  pgid ${g.pgid} ${g.stopped ? 'STOPPED ' : ''}rss ${Math.round(g.rssMb)} MB cpu ${g.pcpu.toFixed(0)}% pids ${g.pids.length} · ${g.label}`);
  process.exit(0);
}
if (args.has('--drill')) {
  const g = groups(managedProcesses()).find((x) => !x.stopped);
  if (!g) { log('drill: nothing to manage right now (start a build or test first)'); process.exit(1); }
  const stat = () => sh('ps', ['-o', 'stat=', '-p', String(g.pids[0])]).trim();
  signalGroup(g.pgid, 'SIGSTOP');
  await new Promise((r) => setTimeout(r, 3000));
  const stopped = stat().includes('T');
  log(`drill: paused pgid ${g.pgid} (${g.label}) · state ${stat()} · ${stopped ? 'stopped as expected' : 'NOT stopped'}`);
  signalGroup(g.pgid, 'SIGCONT');
  await new Promise((r) => setTimeout(r, 1000));
  const resumed = !stat().includes('T');
  log(`drill: resumed · state ${stat()} · ${resumed ? 'running again' : 'STILL stopped'}`);
  process.exit(stopped && resumed ? 0 : 1);
}
if (args.has('--resume-all')) { log(`resumed ${resumeAllStopped('--resume-all')} group(s)`); process.exit(0); }

if (args.has('--stop')) {
  const pid = Number(fs.existsSync(PIDFILE) ? fs.readFileSync(PIDFILE, 'utf8') : 0);
  if (pid && sh('ps', ['-p', String(pid), '-o', 'pid=']).trim()) { process.kill(pid, 'SIGTERM'); log(`stopping guard pid ${pid} (it resumes what it paused first)`); }
  else log('no guard running');
  process.exit(0);
}
if (args.has('--start')) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const pid = Number(fs.existsSync(PIDFILE) ? fs.readFileSync(PIDFILE, 'utf8') : 0);
  if (pid && sh('ps', ['-p', String(pid), '-o', 'pid=']).trim()) { log(`guard already running as pid ${pid} · log ${LOG}`); process.exit(0); }
  const fd = fs.openSync(LOG, 'a');
  const child = spawn(process.execPath, [process.argv[1]], { detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  log(`guard started as pid ${child.pid} · log ${LOG} · stop with: npm run load:guard -- --stop`);
  process.exit(0);
}

// ---- the loop ----
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.writeFileSync(PIDFILE, String(process.pid));
log(`load-guard up · ${CORES} cores · hot > ${HOT_LOAD.toFixed(1)} · calm < ${CALM_LOAD.toFixed(1)} · critical = pressure critical, or free+inactive < 1.5 GB, or pressure warn with swap free < ${MIN_SWAP_FREE_MB} MB`);
resumeAllStopped('found stopped at start');

const paused = []; // { pgid, label, at }
const reniced = new Set();
let hotStreak = 0, calmStreak = 0, lastResume = 0, lastSummary = 0;

function tick() {
  const r = reading();
  if (!r) { log('reading failed (vm_stat or sysctl returned nothing); sample skipped'); return; }
  const rows = managedProcesses();
  // macOS grows swap files on demand, so a small swap-free number alone is not an emergency; it is one when the kernel
  // also reports pressure. Critical pressure or almost no free+inactive memory is an emergency on its own.
  const critical = r.pressure >= 4 || r.freeBytes < MIN_FREE_BYTES || (r.pressure >= 2 && r.swapFreeMb < MIN_SWAP_FREE_MB);
  const hot = r.load1 > HOT_LOAD;
  const calm = r.pressure <= 1 && r.load1 < CALM_LOAD;
  hotStreak = hot ? hotStreak + 1 : 0;
  calmStreak = calm ? calmStreak + 1 : 0;

  if (hotStreak >= 2) {
    const fresh = rows.filter((p) => !reniced.has(p.pid)).map((p) => p.pid);
    if (fresh.length) { sh('renice', ['19', '-p', ...fresh.map(String)]); fresh.forEach((p) => reniced.add(p)); log(`hot · ${fmt(r)} · reniced ${fresh.length} process(es) to 19`); }
  }

  if (critical) {
    const next = groups(rows).find((g) => !g.stopped && !paused.some((p) => p.pgid === g.pgid));
    if (next && signalGroup(next.pgid, 'SIGSTOP')) { paused.push({ pgid: next.pgid, label: next.label, at: Date.now() }); log(`critical · ${fmt(r)} · PAUSED pgid ${next.pgid} rss ${Math.round(next.rssMb)} MB (${next.label}) · ${paused.length} paused`); }
    else if (!next && paused.length === 0) log(`critical · ${fmt(r)} · nothing left to pause (not a build process)`);
  } else if (paused.length) {
    const now = Date.now();
    const oldest = paused[0];
    const overdue = now - oldest.at > MAX_PAUSE_MS && r.pressure <= 2;
    if ((calmStreak >= 3 || overdue) && now - lastResume > RESUME_EVERY_MS) {
      const p = overdue ? paused.shift() : paused.pop();
      signalGroup(p.pgid, 'SIGCONT'); lastResume = now;
      log(`${overdue ? 'overdue' : 'calm'} · ${fmt(r)} · RESUMED pgid ${p.pgid} (${p.label}) · ${paused.length} still paused`);
    }
  }
  // groups that ended while paused drop out of the list
  const alive = new Set(rows.map((p) => p.pgid));
  for (let i = paused.length - 1; i >= 0; i--) if (!alive.has(paused[i].pgid)) paused.splice(i, 1);
  for (const pid of reniced) if (!rows.some((p) => p.pid === pid)) reniced.delete(pid);

  if (Date.now() - lastSummary > 5 * 60_000) { lastSummary = Date.now(); log(`${fmt(r)} · managing ${rows.length} process(es) in ${groups(rows).length} group(s) · ${paused.length} paused`); }
}

function shutdown(sig) {
  for (const p of paused.splice(0)) if (signalGroup(p.pgid, 'SIGCONT')) log(`resume pgid ${p.pgid} (${p.label}) · guard exiting on ${sig}`);
  try { fs.unlinkSync(PIDFILE); } catch {}
  log('load-guard down');
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => shutdown(sig));
setInterval(() => { try { tick(); } catch (e) { log(`tick failed: ${e instanceof Error ? e.message : e}`); } }, SAMPLE_MS);
