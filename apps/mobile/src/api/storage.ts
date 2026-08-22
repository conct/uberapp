/**
 * Credential storage for one or more Uberspace accounts.
 *
 * A token grants full control of the account it belongs to, so on native every
 * token goes into the Keychain / Keystore via expo-secure-store. SecureStore
 * has no web implementation; there we fall back to localStorage and say so in
 * the UI rather than pretending the browser offers the same protection.
 *
 * Layout, and why it is split rather than one blob:
 *
 *   uberapp.accounts     JSON [{ id, label, url }]   — no secrets
 *   uberapp.active       the id currently connected
 *   uberapp.token.<id>   one token per account
 *
 * Keeping tokens out of the list means each stored value stays small (iOS
 * SecureStore warns past 2 KB, and a list of accounts would grow past it), and
 * removing an account can delete exactly its own secret.
 *
 * The id is derived from the URL rather than random: one agent lives at one
 * address, so the address *is* the identity. Adding an account that is already
 * there updates it instead of producing a second card for the same host.
 */

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const ACCOUNTS_KEY = 'uberapp.accounts';
const ACTIVE_KEY = 'uberapp.active';
const tokenKey = (id: string) => `uberapp.token.${id}`;

/** The single-account keys this replaced. Read once, then removed. */
const LEGACY_URL_KEY = 'uberapp.url';
const LEGACY_TOKEN_KEY = 'uberapp.token';

export const secureStorageAvailable = Platform.OS !== 'web';

async function getItem(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }
  return SecureStore.getItemAsync(key);
}

async function setItem(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      /* private mode; the session simply will not be remembered */
    }
    return;
  }
  await SecureStore.setItemAsync(key, value, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

async function removeItem(key: string): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      globalThis.localStorage?.removeItem(key);
    } catch {
      /* ignore */
    }
    return;
  }
  await SecureStore.deleteItemAsync(key);
}

export interface Account {
  /** Derived from the URL. Stable, and the key its token is stored under. */
  id: string;
  /** What the user sees. Defaults to the host, and can be renamed. */
  label: string;
  url: string;
}

export interface StoredCredentials {
  url: string;
  token: string;
}

/**
 * SecureStore keys accept letters, digits, '.', '-' and '_' only, so the URL
 * is reduced to that. Truncated because a very long path would otherwise make
 * a key of unbounded length; collisions after truncation would merge two
 * accounts, so the length is generous rather than tight.
 */
export function accountId(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

/** The host, which is what distinguishes one Uberspace from another. */
export function defaultLabel(url: string): string {
  const withoutScheme = url.trim().replace(/^[a-z]+:\/\//i, '');
  const host = withoutScheme.split('/')[0] ?? withoutScheme;
  return host || url.trim();
}

function parseAccounts(raw: string | null): Account[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is Account =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as Account).id === 'string' &&
        typeof (entry as Account).url === 'string' &&
        typeof (entry as Account).label === 'string',
    );
  } catch {
    // A corrupt list is not worth crashing over; the user re-adds the account.
    return [];
  }
}

/**
 * Carry a single-account install over to the list.
 *
 * Someone using the app right now has a token under the old keys and no list.
 * Losing it would log them out with no way back short of the whole SSH setup,
 * so this runs before any read and is a no-op once done.
 */
async function migrateLegacy(): Promise<void> {
  const [existing, url, token] = await Promise.all([
    getItem(ACCOUNTS_KEY),
    getItem(LEGACY_URL_KEY),
    getItem(LEGACY_TOKEN_KEY),
  ]);

  if (existing || !url || !token) return;

  const id = accountId(url);
  await Promise.all([
    setItem(ACCOUNTS_KEY, JSON.stringify([{ id, label: defaultLabel(url), url }])),
    setItem(ACTIVE_KEY, id),
    setItem(tokenKey(id), token),
  ]);

  // Only now, so an interruption above leaves the old keys to try again.
  await Promise.all([removeItem(LEGACY_URL_KEY), removeItem(LEGACY_TOKEN_KEY)]);
}

export async function listAccounts(): Promise<Account[]> {
  await migrateLegacy();
  return parseAccounts(await getItem(ACCOUNTS_KEY));
}

export async function getActiveId(): Promise<string | null> {
  await migrateLegacy();
  return getItem(ACTIVE_KEY);
}

export async function getToken(id: string): Promise<string | null> {
  return getItem(tokenKey(id));
}

/**
 * The account to connect to on start: the active one, or the only one if
 * nothing was ever marked active.
 */
export async function loadCredentials(): Promise<StoredCredentials | null> {
  const accounts = await listAccounts();
  if (accounts.length === 0) return null;

  const activeId = await getItem(ACTIVE_KEY);
  const account = accounts.find((entry) => entry.id === activeId) ?? accounts[0];
  if (!account) return null;

  const token = await getToken(account.id);
  if (!token) return null;

  return { url: account.url, token };
}

/**
 * Add an account, or update the one already at that URL, and make it active.
 */
export async function saveAccount(input: {
  url: string;
  token: string;
  label?: string;
}): Promise<Account> {
  const url = input.url.trim();
  const id = accountId(url);
  const accounts = await listAccounts();
  const existing = accounts.find((entry) => entry.id === id);

  const account: Account = {
    id,
    url,
    label: input.label?.trim() || existing?.label || defaultLabel(url),
  };

  const next = existing
    ? accounts.map((entry) => (entry.id === id ? account : entry))
    : [...accounts, account];

  await Promise.all([
    setItem(ACCOUNTS_KEY, JSON.stringify(next)),
    setItem(tokenKey(id), input.token),
    setItem(ACTIVE_KEY, id),
  ]);

  return account;
}

/** Kept for the callers that only ever dealt with one account. */
export async function saveCredentials(credentials: StoredCredentials): Promise<void> {
  await saveAccount(credentials);
}

export async function setActive(id: string): Promise<void> {
  await setItem(ACTIVE_KEY, id);
}

export async function renameAccount(id: string, label: string): Promise<void> {
  const accounts = await listAccounts();
  const next = accounts.map((entry) =>
    entry.id === id ? { ...entry, label: label.trim() || entry.label } : entry,
  );
  await setItem(ACCOUNTS_KEY, JSON.stringify(next));
}

/**
 * Forget one account, token included. Returns what is left active, so the
 * caller can connect to it — or null when nothing remains.
 */
export async function removeAccount(id: string): Promise<Account | null> {
  const accounts = await listAccounts();
  const next = accounts.filter((entry) => entry.id !== id);

  await Promise.all([setItem(ACCOUNTS_KEY, JSON.stringify(next)), removeItem(tokenKey(id))]);

  const activeId = await getItem(ACTIVE_KEY);
  if (activeId !== id) return next.find((entry) => entry.id === activeId) ?? null;

  const fallback = next[0] ?? null;
  if (fallback) await setItem(ACTIVE_KEY, fallback.id);
  else await removeItem(ACTIVE_KEY);
  return fallback;
}

/** Forget everything — every account and every token. */
export async function clearCredentials(): Promise<void> {
  const accounts = await listAccounts();
  await Promise.all([
    ...accounts.map((entry) => removeItem(tokenKey(entry.id))),
    removeItem(ACCOUNTS_KEY),
    removeItem(ACTIVE_KEY),
    removeItem(LEGACY_URL_KEY),
    removeItem(LEGACY_TOKEN_KEY),
  ]);
}

// --- SSH keys ---------------------------------------------------------------

/**
 * The private key that replaces the account password on later setup runs.
 *
 * Kept under the SSH target rather than the account id, because the two are
 * not the same thing: a host is set up before any account exists for it, and
 * the same host may be reachable under more than one agent address. What the
 * key belongs to is the login it was installed for.
 *
 * Never stored where the OS cannot protect it. On web that means not at all,
 * which costs nothing: a browser cannot open an SSH connection anyway.
 */
const SSH_KEY_PREFIX = 'uberapp.sshkey.';

function sshKeyKey(host: string, user: string): string {
  // SecureStore takes only alphanumerics, '.', '-' and '_' in a key name, and
  // the obvious identifier for a login — user@host — contains the one
  // character it refuses. It throws rather than returning null, so getting
  // this wrong turned every keystroke in the host field into an uncaught
  // rejection. accountId() already normalises exactly this way for the token
  // keys; following it beats inventing a second rule that can drift from it.
  return `${SSH_KEY_PREFIX}${accountId(`${user}-at-${host}`)}`;
}

export async function saveSshKey(host: string, user: string, privateKey: string): Promise<void> {
  if (!secureStorageAvailable) return;
  await setItem(sshKeyKey(host, user), privateKey);
}

export async function loadSshKey(host: string, user: string): Promise<string | null> {
  if (!secureStorageAvailable) return null;
  return getItem(sshKeyKey(host, user));
}

export async function removeSshKey(host: string, user: string): Promise<void> {
  if (!secureStorageAvailable) return;
  await removeItem(sshKeyKey(host, user));
}
