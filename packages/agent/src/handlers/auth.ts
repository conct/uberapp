/**
 * Issuing and revoking pairing tokens.
 *
 * Only the master token may mint. A pairing token that could mint further
 * pairing tokens would make revocation meaningless: take one away and it has
 * already handed out three more.
 */

import {
  DEFAULT_TOKEN_TTL_SECONDS,
  MAX_TOKEN_TTL_SECONDS,
  MIN_TOKEN_TTL_SECONDS,
} from '@uberapp/protocol';
import { issueToken, listTokens, revokeToken } from '../tokens.js';
import { RpcError, type CallContext, type Handler } from '../rpc.js';
import { asObject, optionalNumber, optionalString, requireString } from '../validate.js';

function requireMaster(ctx: CallContext): void {
  if (ctx.auth.kind !== 'master') {
    throw RpcError.forbidden(
      'Only the original token can hand out pairing tokens. Do this from the device that set the agent up.',
    );
  }
}

const issue: Handler = async (params, ctx) => {
  requireMaster(ctx);

  const p = asObject(params);
  const label = optionalString(p, 'label', { maxLength: 64 }) ?? null;
  const requested = optionalNumber(p, 'ttlSeconds') ?? DEFAULT_TOKEN_TTL_SECONDS;

  if (!Number.isInteger(requested)) {
    throw RpcError.badRequest('ttlSeconds must be a whole number of seconds');
  }
  if (requested < MIN_TOKEN_TTL_SECONDS || requested > MAX_TOKEN_TTL_SECONDS) {
    throw RpcError.badRequest(
      `ttlSeconds must be between ${MIN_TOKEN_TTL_SECONDS} and ${MAX_TOKEN_TTL_SECONDS}`,
    );
  }

  let issued;
  try {
    issued = await issueToken(ctx.config, { label, ttlSeconds: requested });
  } catch (err) {
    throw RpcError.badRequest((err as Error).message);
  }

  // The client needs its own address back to build a pairing code: the agent
  // does not know the URL it is reached under, only the client does. So the
  // payload is assembled there and this returns the parts.
  return issued;
};

const list: Handler = async (_params, ctx) => listTokens(ctx.config);

const revoke: Handler = async (params, ctx) => {
  requireMaster(ctx);

  const p = asObject(params);
  const id = requireString(p, 'id', { maxLength: 64 });

  const removed = await revokeToken(ctx.config, id);
  if (!removed) throw RpcError.notFound(`No pairing token with id ${id}`);
  return { id, revoked: true };
};

export const authHandlers: Record<string, Handler> = {
  'auth.issueToken': issue,
  'auth.listTokens': list,
  'auth.revokeToken': revoke,
};
