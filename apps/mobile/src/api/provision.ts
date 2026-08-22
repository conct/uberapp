/**
 * The simple setup: install the agent on the host and come back with the two
 * things the app needs afterwards.
 *
 * This is the same sequence tools/setup.mjs performs from a developer machine,
 * expressed once more here because the phone has no shell to run it in. Keeping
 * the two in step matters — if one grows a step, so must the other.
 *
 * The transport is injected. This file decides what to run and what counts as
 * success; how bytes reach the host is somebody else's problem.
 */

import type { SshCredentials, SshResult, SshRunner } from './ssh';

export const AGENT_PORT = 8399;
/** The handoff broker, installed beside the agent as its own process. */
export const CONNECT_PORT = 8400;
/**
 * Where the broker answers, always on the default domain and always at this
 * path. A browser has to be able to reach it before it knows anything else, so
 * it cannot be somewhere that depends on the user's own DNS.
 */
export const CONNECT_PATH = 'connect';
export const INSTALL_DIR = 'uberapp';
export const REPO_URL = 'https://github.com/conct/uberapp.git';

export type StepId = 'check' | 'fetch' | 'install' | 'expose' | 'verify';
export type StepState = 'pending' | 'running' | 'ok' | 'failed';

export interface ProvisionStep {
  id: StepId;
  title: string;
  state: StepState;
  detail?: string;
}

export interface ProvisionResult {
  url: string;
  token: string;
}

export function initialSteps(): ProvisionStep[] {
  return [
    { id: 'check', title: 'Host prüfen', state: 'pending' },
    { id: 'fetch', title: 'Projekt holen', state: 'pending' },
    { id: 'install', title: 'Agent bauen und starten', state: 'pending' },
    { id: 'expose', title: 'Erreichbar machen', state: 'pending' },
    { id: 'verify', title: 'Antwort prüfen', state: 'pending' },
  ];
}

export class ProvisionError extends Error {
  constructor(
    readonly step: StepId,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'ProvisionError';
  }
}

/** First non-empty line, which is where these tools put the useful part. */
function firstLine(text: string): string {
  return text.trim().split('\n').find((line) => line.trim().length > 0)?.trim() ?? '';
}

export interface ProvisionOptions {
  credentials: SshCredentials;
  runner: SshRunner;
  /** Route a whole domain instead of a path on <user>.uber.space. */
  domain?: string | null;
  onStep: (id: StepId, patch: Partial<ProvisionStep>) => void;
  onOutput?: (chunk: string) => void;
}

export async function provision(options: ProvisionOptions): Promise<ProvisionResult> {
  const { credentials, runner, onStep, onOutput } = options;
  const domain = options.domain?.trim() || null;

  const step = async <T,>(id: StepId, work: () => Promise<T>, detail?: (r: T) => string) => {
    onStep(id, { state: 'running' });
    try {
      const result = await work();
      onStep(id, { state: 'ok', detail: detail?.(result) });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onStep(id, { state: 'failed', detail: message });
      throw err instanceof ProvisionError ? err : new ProvisionError(id, message);
    }
  };

  const sh = async (id: StepId, command: string, whatFailed: string): Promise<SshResult> => {
    const result = await runner.run(credentials, command);
    if (result.code !== 0) {
      throw new ProvisionError(
        id,
        firstLine(result.stderr || result.stdout) || whatFailed,
        (result.stderr || result.stdout).slice(0, 2000),
      );
    }
    return result;
  };

  // --- 1. is this even an Uberspace, and can it build ---------------------
  await step(
    'check',
    async () => {
      const probe = await sh(
        'check',
        'command -v uberspace >/dev/null && node -v || echo NO_UBERSPACE',
        'Der Host hat nicht geantwortet.',
      );
      const output = probe.stdout.trim();
      if (output.includes('NO_UBERSPACE')) {
        throw new ProvisionError(
          'check',
          'Auf diesem Host gibt es kein uberspace-Kommando — das ist kein Uberspace 7.',
        );
      }

      const major = Number(/^v(\d+)/.exec(output)?.[1] ?? 0);
      if (major < 20) {
        // Switching the version needs a fresh login to take effect, so this
        // stops here rather than building against the old one.
        await sh('check', 'uberspace tools version use node 22', 'Node liess sich nicht umstellen.');
        throw new ProvisionError(
          'check',
          `Node ${major || '?'} ist zu alt. Ich habe auf Node 22 umgestellt — starte die Einrichtung bitte noch einmal.`,
        );
      }
      return output;
    },
    (version) => `Node ${version}`,
  );

  // --- 2. get the sources onto the host ------------------------------------
  await step('fetch', async () =>
    sh(
      'fetch',
      `if [ -d ~/${INSTALL_DIR}/.git ]; then cd ~/${INSTALL_DIR} && git fetch --depth 1 origin main && git reset --hard origin/main; ` +
        `else rm -rf ~/${INSTALL_DIR} && git clone --depth 1 ${REPO_URL} ~/${INSTALL_DIR}; fi`,
      'Das Projekt liess sich nicht holen.',
    ),
  );

  // --- 3. build and start --------------------------------------------------
  await step('install', async () => {
    const result = await runner.stream(
      credentials,
      `cd ~/${INSTALL_DIR} && UBERAPP_PORT=${AGENT_PORT} bash packages/agent/deploy/install.sh`,
      (chunk) => onOutput?.(chunk),
    );
    if (result.code !== 0) {
      throw new ProvisionError(
        'install',
        firstLine(result.stderr) || 'Die Installation ist fehlgeschlagen.',
        result.stderr.slice(0, 2000),
      );
    }
    return result;
  });

  // --- 4. route something to it -------------------------------------------
  const target = await step(
    'expose',
    async () => {
      const existing = await sh(
        'expose',
        `uberspace web backend list 2>/dev/null | grep "http:${AGENT_PORT}" || true`,
        '',
      );
      const line = existing.stdout.trim().split('\n')[0]?.trim();
      if (line) {
        const found = line.split(/\s+/)[0] ?? '';
        if (found) {
          return found.startsWith('/')
            ? `${credentials.user}.uber.space${found}`
            : found.replace(/\/$/, '');
        }
      }

      if (domain) {
        await sh('expose', `uberspace web domain add ${domain} 2>&1 || true`, '');
        await sh(
          'expose',
          `uberspace web backend set ${domain}/ --http --port ${AGENT_PORT}`,
          'Das Web-Backend liess sich nicht setzen.',
        );
        return domain;
      }

      // The default domain always exists and already has a certificate, so a
      // path on it works immediately and needs no DNS anywhere.
      await sh(
        'expose',
        `uberspace web backend set /${INSTALL_DIR} --http --port ${AGENT_PORT} --remove-prefix`,
        'Das Web-Backend liess sich nicht setzen.',
      );
      return `${credentials.user}.uber.space/${INSTALL_DIR}`;
    },
    (value) => value,
  );

  // The broker is reachable at a fixed path on the default domain, whatever
  // the agent ended up on. A browser needs it before it knows which Uberspace
  // it is even talking to, so it cannot sit behind a domain the user may or
  // may not have pointed here. Failure is not fatal: the agent works without
  // it, and only the QR handoff is missing.
  await sh(
    'expose',
    `uberspace web backend set /${CONNECT_PATH} --http --port ${CONNECT_PORT} --remove-prefix 2>&1 || true`,
    '',
  );

  // --- 5. confirm it actually answers --------------------------------------
  const token = await step(
    'verify',
    async () => {
      // Asked from the host itself, so a DNS or certificate delay on the
      // client side cannot make a working agent look broken.
      const health = await sh(
        'verify',
        `curl -sS -m 15 https://${target}/healthz 2>&1 || echo REQUEST_FAILED`,
        '',
      );
      if (!health.stdout.includes('"ok":true')) {
        throw new ProvisionError(
          'verify',
          domain
            ? 'Der Endpunkt antwortet noch nicht. Eine neue Domain braucht erst ihren DNS-Eintrag, danach ein paar Minuten für das Zertifikat.'
            : 'Der Endpunkt antwortet noch nicht.',
          health.stdout.slice(0, 500),
        );
      }

      const read = await sh('verify', 'cat ~/.config/uberapp/token', 'Kein Token gefunden.');
      const value = read.stdout.trim();
      if (value.length < 24) {
        throw new ProvisionError('verify', 'Das Token auf dem Host sieht nicht brauchbar aus.');
      }
      return value;
    },
    () => 'Agent antwortet',
  );

  return { url: `wss://${target}`, token };
}
