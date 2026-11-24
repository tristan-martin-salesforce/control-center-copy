/** Free space where the state folder lives (DEP.DISK.LOW). */
import { stateDir } from '../paths';
import { bad, ok, type Check } from './types';

export const checkDisk: Check = async (c) => {
  const free = c.freeBytes(stateDir(c.env));
  if (free === null) return bad('skip', 'disk', 'Disk space', 'could not read free space');
  const gb = free / 1024 ** 3;
  const detail = `${gb.toFixed(1)} GB free`;
  if (gb < 2) return bad('fail', 'disk', 'Disk space', detail, 'free up space (backups, logs, and Postgres need room)', { free_gb: gb }, { code: 'DEP.DISK.LOW' });
  if (gb < 5) return bad('warn', 'disk', 'Disk space', detail, 'free up space soon', { free_gb: gb }, { code: 'DEP.DISK.LOW' });
  return ok('disk', 'Disk space', detail, { free_gb: gb });
};
