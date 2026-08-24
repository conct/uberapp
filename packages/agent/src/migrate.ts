/**
 * Carrying a host across the rename from uberapp to uberctrl.
 *
 * The name changed; the data did not. `~/.config/uberapp` holds the master
 * token that every paired device authenticates against, the registrar
 * credentials, and the orders. An agent that simply started looking somewhere
 * else would present itself as a fresh install: every device unpaired, and any
 * order in flight invisible.
 *
 * It matters here rather than only in `install.sh` because the self-update
 * path does not run the installer. It fetches, builds and restarts — so the
 * first restart after the rename is exactly where a host would lose itself.
 *
 * Deliberately narrow: it only acts when the new directory does not exist at
 * all. Once it has run, or on any host installed after the rename, it does
 * nothing and costs one failed stat.
 *
 * This is legacy code with a purpose and an end. It can go once no host is
 * older than the rename — which, for a project with a handful of installs,
 * is a matter of weeks rather than never.
 */

import { rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LEGACY_DIR = 'uberapp';
const CURRENT_DIR = 'uberctrl';

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Move the old config directory into place, if that is what the host needs.
 *
 * Returns what it did, so the caller can say so in the log — a silent rename
 * of the directory holding somebody's credentials is not the kind of thing to
 * discover later by inference.
 */
export async function migrateLegacyConfig(home: string = homedir()): Promise<string | null> {
  const current = join(home, '.config', CURRENT_DIR);
  const legacy = join(home, '.config', LEGACY_DIR);

  if (await exists(current)) return null;
  if (!(await exists(legacy))) return null;

  try {
    await rename(legacy, current);
    return `moved ${legacy} to ${current}`;
  } catch (err) {
    // Worth shouting about: the agent is about to behave like a fresh
    // install, and the reason is here rather than in anything it does next.
    return `could not move ${legacy} to ${current} — ${String(err)}`;
  }
}
