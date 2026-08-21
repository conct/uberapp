/**
 * Credential storage.
 *
 * The token grants full control of the Uberspace account, so on native it goes
 * into the Keychain / Keystore via expo-secure-store. SecureStore has no web
 * implementation; there we fall back to localStorage and say so in the UI
 * rather than pretending the browser offers the same protection.
 */

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const URL_KEY = 'uberapp.url';
const TOKEN_KEY = 'uberapp.token';

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

export interface StoredCredentials {
  url: string;
  token: string;
}

export async function loadCredentials(): Promise<StoredCredentials | null> {
  const [url, token] = await Promise.all([getItem(URL_KEY), getItem(TOKEN_KEY)]);
  if (!url || !token) return null;
  return { url, token };
}

export async function saveCredentials(credentials: StoredCredentials): Promise<void> {
  await Promise.all([setItem(URL_KEY, credentials.url), setItem(TOKEN_KEY, credentials.token)]);
}

export async function clearCredentials(): Promise<void> {
  await Promise.all([removeItem(URL_KEY), removeItem(TOKEN_KEY)]);
}
