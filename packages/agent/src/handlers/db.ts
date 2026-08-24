/**
 * MySQL administration.
 *
 * Uberspace writes the account's credentials into ~/.my.cnf, so every client
 * here logs in by itself and nothing has to carry a password. That also means
 * the agent inherits exactly the account's own rights — it cannot reach
 * anything the user could not reach from their own shell.
 *
 * On SQL and user input: statements are fixed strings wherever possible, and
 * the database name is passed as an argv argument rather than spliced into
 * SQL. The two statements that cannot work that way — CREATE and DROP
 * DATABASE — take a name that has already passed isOwnDatabase(), which admits
 * letters, digits and underscores and nothing else.
 */

import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, posix } from 'node:path';
import type { DatabaseInfo, TableInfo } from '@uberctrl/protocol';
import { isOwnDatabase } from '@uberctrl/protocol';
import { run, runPipe } from '../exec.js';
import { RpcError, type CallContext, type Handler } from '../rpc.js';
import { asObject, requireString } from '../validate.js';

/** --batch gives tab-separated rows without the ASCII box drawing. */
const BATCH = ['--batch', '--skip-column-names'];

export function myCnfPath(): string {
  return join(homedir(), '.my.cnf');
}

export async function hasMysqlCredentials(): Promise<boolean> {
  try {
    await access(myCnfPath());
    return true;
  } catch {
    return false;
  }
}

function databaseName(params: Record<string, unknown>, user: string, key = 'database'): string {
  const value = requireString(params, key, { maxLength: 64 });
  if (!isOwnDatabase(value, user)) {
    throw RpcError.badRequest(
      `"${value}" is not one of this account's databases. The name must be ${user} or start with ${user}_`,
    );
  }
  return value;
}

async function mysql(args: string[], timeoutMs = 30_000) {
  const result = await run('mysql', args, { timeoutMs });
  if (!result.ok) {
    const message = (result.stderr || result.stdout).trim().split('\n')[0] ?? 'mysql failed';
    // The client prints credential problems here; they read as plain failures
    // otherwise and send people looking in the wrong place.
    if (/access denied/i.test(message)) {
      throw RpcError.forbidden(`${message} — check ${myCnfPath()}`);
    }
    throw RpcError.commandFailed(message, result.stderr || result.stdout);
  }
  return result;
}

// --- listing ---------------------------------------------------------------

/** Tab-separated rows from `mysql --batch`, blank lines dropped. */
export function parseRows(stdout: string): string[][] {
  return stdout
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t'));
}

/** `NULL` is how --batch renders a null column. */
export function parseNumber(value: string | undefined): number | null {
  if (value === undefined || value === 'NULL' || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Merge `SHOW DATABASES` with the size rollup.
 *
 * Both are needed: information_schema omits a database that holds no tables,
 * and a freshly created, empty database is exactly the one a user wants to see
 * confirmed.
 */
export function mergeDatabases(
  names: string[],
  sizes: Map<string, { size: number | null; tables: number | null }>,
  user: string,
): DatabaseInfo[] {
  return names
    .filter((name) => isOwnDatabase(name, user))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      size: sizes.get(name)?.size ?? null,
      tables: sizes.get(name)?.tables ?? null,
      // Uberspace creates the account database; dropping it is not recoverable
      // from the app and not something the platform expects.
      removable: name !== user,
    }));
}

const list: Handler = async (_params, ctx) => {
  const shown = await mysql([...BATCH, '-e', 'SHOW DATABASES']);
  const names = parseRows(shown.stdout).map((row) => row[0] ?? '');

  // No user input in this statement, so it stays a fixed string.
  const rollup = await mysql([
    ...BATCH,
    '-e',
    'SELECT table_schema, SUM(data_length + index_length), COUNT(*) ' +
      'FROM information_schema.tables GROUP BY table_schema',
  ]);

  const sizes = new Map<string, { size: number | null; tables: number | null }>();
  for (const row of parseRows(rollup.stdout)) {
    if (!row[0]) continue;
    sizes.set(row[0], { size: parseNumber(row[1]), tables: parseNumber(row[2]) });
  }

  return mergeDatabases(names, sizes, ctx.config.user);
};

const tables: Handler = async (params, ctx) => {
  const p = asObject(params);
  const database = databaseName(p, ctx.config.user);

  // The database is selected by argument, so the statement carries no input.
  const result = await mysql([...BATCH, '-e', 'SHOW TABLE STATUS', database]);

  // Columns: Name, Engine, Version, Row_format, Rows, Avg_row_length,
  // Data_length, Max_data_length, Index_length, ...
  const entries: TableInfo[] = [];
  for (const row of parseRows(result.stdout)) {
    if (!row[0]) continue;
    entries.push({
      name: row[0],
      engine: row[1] ?? '',
      rows: parseNumber(row[4]),
      size: (parseNumber(row[6]) ?? 0) + (parseNumber(row[8]) ?? 0) || null,
    });
  }
  return { database, tables: entries };
};

// --- create and drop -------------------------------------------------------

const create: Handler = async (params, ctx) => {
  const p = asObject(params);
  const database = databaseName(p, ctx.config.user);

  // Safe to interpolate: isOwnDatabase() admits [A-Za-z0-9_] only.
  await mysql(['-e', `CREATE DATABASE \`${database}\``], 60_000);
  return { database, created: true };
};

const drop: Handler = async (params, ctx) => {
  const p = asObject(params);
  const database = databaseName(p, ctx.config.user);

  if (database === ctx.config.user) {
    throw RpcError.forbidden(
      `${database} is the account's own database and cannot be dropped from here`,
    );
  }

  await mysql(['-e', `DROP DATABASE \`${database}\``], 60_000);
  return { database, dropped: true };
};

// --- dump and import -------------------------------------------------------

/**
 * Where a dump may be written or read.
 *
 * The home directory, and nothing else. A dump is a full copy of the data, so
 * writing one somewhere the account does not control would be a quiet way to
 * leak it.
 */
function assertInHome(path: string, home: string): string {
  const normalized = posix.normalize(path);
  if (!normalized.startsWith('/')) throw RpcError.badRequest('path must be absolute');
  if (path.split('/').includes('..')) {
    throw RpcError.badRequest('path must not contain ".." segments');
  }
  const root = posix.normalize(home);
  if (normalized !== root && !normalized.startsWith(`${root}/`)) {
    throw RpcError.forbidden(`Only paths under ${root} can be used`);
  }
  return normalized;
}

const dump: Handler = async (params, ctx) => {
  const p = asObject(params);
  const database = databaseName(p, ctx.config.user);
  const target = assertInHome(requireString(p, 'path', { maxLength: 4096 }), ctx.config.home);

  // Refuse to overwrite: a dump silently replacing yesterday's is the kind of
  // mistake that is only noticed when the older one is needed.
  const exists = await access(target).then(
    () => true,
    () => false,
  );
  if (exists) throw RpcError.badRequest(`${target} already exists`);

  return new Promise((resolve, reject) => {
    ctx.emit('stdout', `mysqldump ${database} > ${target}\n`);
    ctx.emit('stdout', 'Dumping. There is no output until it finishes.\n');

    const handle = runPipe(
      { file: 'mysqldump', args: [database] },
      // tee writes the stream to the file; nothing here needs a shell redirect.
      { file: 'tee', args: [target] },
      {
        // tee echoes the dump on stdout, which would be the whole database.
        onChunk: (stream, data) => {
          if (stream === 'stderr') ctx.emit('stderr', data);
        },
        onDone: async (code) => {
          if (code !== 0) {
            ctx.emit('stderr', `\nDump failed (exit ${code}).\n`);
            resolve({ ended: true, exitCode: code });
            return;
          }
          const size = await stat(target).then(
            (stats) => stats.size,
            () => 0,
          );
          ctx.emit('stdout', `\nWrote ${size} bytes to ${target}\n`);
          resolve({ ended: true, exitCode: 0 });
        },
        onError: (err) => reject(RpcError.commandFailed(err.message)),
      },
    );
    ctx.onCancel(() => handle.cancel());
  });
};

/**
 * Feed a dump file into a database.
 *
 * Shared with backup.db.restore, which does the same thing from a different
 * directory: the only difference between the two is which files are allowed
 * as a source, and that decision belongs to the caller.
 */
export function importDump(ctx: CallContext, file: string, database: string): Promise<unknown> {
  const reader = file.endsWith('.xz')
    ? { file: 'xzcat', args: [file] }
    : { file: 'cat', args: [file] };

  return new Promise((resolve, reject) => {
    // mysql says nothing on success, so without this the screen sits blank for
    // however long the import takes.
    ctx.emit('stdout', `${reader.file} ${file} | mysql ${database}\n`);
    ctx.emit('stdout', 'Importing. There is no output until it finishes.\n');

    const handle = runPipe(reader, { file: 'mysql', args: [database] }, {
      onChunk: (stream, data) => ctx.emit(stream, data),
      onDone: (code) => {
        ctx.emit(
          'stdout',
          code === 0 ? '\nImport finished.\n' : `\nImport failed (exit ${code}).\n`,
        );
        resolve({ ended: true, exitCode: code });
      },
      onError: (err) => reject(RpcError.commandFailed(err.message)),
    });
    ctx.onCancel(() => handle.cancel());
  });
}

const importFile: Handler = async (params, ctx) => {
  const p = asObject(params);
  const database = databaseName(p, ctx.config.user);
  const file = assertInHome(requireString(p, 'path', { maxLength: 4096 }), ctx.config.home);

  try {
    await stat(file);
  } catch {
    throw RpcError.notFound(`No such file: ${file}`);
  }

  return importDump(ctx, file, database);
};

export const dbHandlers: Record<string, Handler> = {
  'db.mysql.list': list,
  'db.mysql.create': create,
  'db.mysql.drop': drop,
  'db.mysql.tables': tables,
  'db.mysql.dump': dump,
  'db.mysql.import': importFile,
};
