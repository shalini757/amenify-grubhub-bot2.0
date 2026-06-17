// Single-instance guard. Prevents two order-processing bots from running at
// once — which would defeat the in-memory single-flight drain and let two
// processes work different sheet rows in parallel (the row-60/61 overlap).
//
// Mechanism: a PID lock file. On acquire we check whether the recorded PID is
// still alive; a live PID means another bot is running → refuse to start. A
// stale PID (process gone, e.g. after a hard crash) is reclaimed.

import fs from 'fs';
import path from 'path';
import { logger } from '../logger';

const LOCK_FILE = path.resolve(process.cwd(), '.bot-instance.lock');

function isAlive(pid: number): boolean {
  if (!pid || Number.isNaN(pid)) return false;
  try {
    // Signal 0 doesn't kill — it just probes existence/permission.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process (stale). EPERM = exists but not ours (alive).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Acquire the lock or throw. Call once at startup of any order-processing command.
function acquire(label: string): () => void {
  if (fs.existsSync(LOCK_FILE)) {
    const raw = (fs.readFileSync(LOCK_FILE, 'utf8') || '').trim();
    const pid = parseInt(raw.split('|')[0], 10);
    if (isAlive(pid) && pid !== process.pid) {
      throw new Error(
        `Another bot instance is already running (PID ${pid}). ` +
        `Refusing to start a second "${label}" — two bots would process orders in parallel. ` +
        `Stop the other process first, or delete ${LOCK_FILE} if you're sure it's dead.`,
      );
    }
    logger.warn({ stalePid: pid, lockFile: LOCK_FILE }, 'reclaiming stale instance lock');
  }
  fs.writeFileSync(LOCK_FILE, `${process.pid}|${label}|${new Date().toISOString()}`);
  logger.info({ pid: process.pid, label, lockFile: LOCK_FILE }, 'instance lock acquired');

  const release = (): void => {
    try {
      const raw = fs.existsSync(LOCK_FILE) ? fs.readFileSync(LOCK_FILE, 'utf8') : '';
      const pid = parseInt((raw || '').split('|')[0], 10);
      // Only remove if it's still ours (don't clobber a successor's lock).
      if (pid === process.pid) fs.unlinkSync(LOCK_FILE);
    } catch (_) { /* best-effort */ }
  };

  process.on('exit', release);
  process.on('SIGINT', () => { release(); process.exit(130); });
  process.on('SIGTERM', () => { release(); process.exit(143); });
  return release;
}

export { acquire };
