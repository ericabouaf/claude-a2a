import type { RequestHandler } from 'express';
import {
  defaultServerCallContextBuilder,
  type RequestHeaders,
  type ServerCallContext,
  type ServerCallContextBuilder,
} from '@a2a-js/sdk/server';
import { a2aLog } from './logger';

/**
 * Key under which the caller identity is stored in `ServerCallContext.state`,
 * next to the raw headers the default builder puts under `STATE_HEADERS_KEY`.
 */
export const STATE_CALLER_KEY = 'caller';

/**
 * Who is calling, as reported by the reverse proxy in front of this server.
 *
 * `tailscale serve` adds `Tailscale-User-Login` / `Tailscale-User-Name` /
 * `Tailscale-User-Profile-Pic` to every request it proxies, so on a tailnet
 * those headers identify the tailnet user. They are *proxy-asserted*: nothing
 * stops a direct caller from forging them, which is exactly why the server
 * binds to loopback by default.
 */
export interface CallerIdentity {
  /** `Tailscale-User-Login`, e.g. `eric.abouaf@gmail.com`. Absent = anonymous. */
  login?: string;
  /** `Tailscale-User-Name`, the human-readable display name. */
  name?: string;
  /** First hop of `X-Forwarded-For`, when the proxy sets it. */
  remoteAddress?: string;
}

/** Reads a header case-insensitively, taking the first value of a list. */
function readHeader(headers: RequestHeaders, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const first = Array.isArray(value) ? value[0] : value;
    const trimmed = first?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/** Extracts the caller identity from a request's headers. */
export function readCallerFromHeaders(headers: RequestHeaders): CallerIdentity {
  return {
    login: readHeader(headers, 'tailscale-user-login'),
    name: readHeader(headers, 'tailscale-user-name'),
    remoteAddress: readHeader(headers, 'x-forwarded-for')?.split(',')[0]?.trim(),
  };
}

/**
 * `ServerCallContextBuilder` that keeps everything the default builder does
 * (raw headers under `STATE_HEADERS_KEY`, user, extensions, version, tenant)
 * and additionally stores the {@link CallerIdentity} under
 * {@link STATE_CALLER_KEY}, so the executor can trace who asked.
 */
export const callerServerCallContextBuilder: ServerCallContextBuilder = (options) => {
  const context = defaultServerCallContextBuilder(options);
  context.state.set(STATE_CALLER_KEY, readCallerFromHeaders(options.headers));
  return context;
};

/** Reads back the caller identity stored by {@link callerServerCallContextBuilder}. */
export function readCaller(context: ServerCallContext | undefined): CallerIdentity {
  const caller = context?.state?.get(STATE_CALLER_KEY);
  return (caller ?? {}) as CallerIdentity;
}

/**
 * Express middleware rejecting any caller whose `Tailscale-User-Login` is
 * absent or not in `allowedLogins`. Mounted only when the list is non-empty,
 * and only in front of the JSON-RPC handler — the agent card stays public.
 */
export function allowedLoginsGate(allowedLogins: string[]): RequestHandler {
  const allowed = new Set(allowedLogins.map((login) => login.trim().toLowerCase()));

  return (req, res, next) => {
    const login = readCallerFromHeaders(req.headers).login;
    if (login && allowed.has(login.toLowerCase())) {
      next();
      return;
    }
    a2aLog('error', `Rejected caller ${login ?? 'anonymous'} (not in server.allowedLogins)`);
    res.status(403).json({ error: 'forbidden' });
  };
}
