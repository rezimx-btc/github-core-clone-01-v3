// Shared HTTP plumbing for the forge's handlers: one request context, JSON answers,
// body reading and the bearer check. Kept in its own module so git.ts, rest.ts,
// gql.ts and mcp.ts can share it without an import cycle through app.ts.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Forge } from './store.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

export interface Ctx {
  forge: Forge;
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  /** The request path without its query string, never decoded. */
  path: string;
  /** The raw query string (after '?'), or ''. */
  queryString: string;
  requestId: string;
  body: Buffer;
}

let requestCounter = 0;
export function nextRequestId(): string {
  // The header only has to be non-empty; a plain decimal counter is the
  // cheapest distinct id per request.
  return `req-${++requestCounter}`;
}

/** Read the request body; for a request with no body this resolves at once. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let count = 0;
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      count += 1;
    });
    req.on('end', () => resolve(count === 1 ? chunks[0]! : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Answer with a JSON body object (always a trailing newline, as GitHub does). */
export function sendJson(ctx: Ctx, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.requestId,
    ...extraHeaders,
  });
  ctx.res.end(text);
}

/** Answer with a pre-serialized JSON string (byte length already known, no re-stringify). */
export function sendJsonText(ctx: Ctx, status: number, text: string, byteLength: number, extraHeaders: Record<string, string> = {}): void {
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': byteLength,
    'x-github-request-id': ctx.requestId,
    ...extraHeaders,
  });
  ctx.res.end(text);
}

/** Answer with raw bytes and a content type. */
export function sendBytes(ctx: Ctx, status: number, body: Buffer, contentType: string): void {
  ctx.res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': ctx.requestId,
  });
  ctx.res.end(body);
}

export function sendError(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

/** Parse the request body as a JSON object; null when it is not valid JSON or not an object. */
export function parseJsonBody(ctx: Ctx): Record<string, unknown> | null {
  if (ctx.body.length === 0) return {};
  try {
    const value = JSON.parse(ctx.body.toString('utf8')) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

/** True when the request carries the trial's bearer token (any non-empty token when none is set). */
export function authed(ctx: Ctx): boolean {
  const header = ctx.req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const token = header.slice(7);
  if (token === '') return false;
  if (ctx.forge.expectedToken !== '') return token === ctx.forge.expectedToken;
  return true;
}

export function requireAuth(ctx: Ctx): boolean {
  if (authed(ctx)) return true;
  sendError(ctx, 401, 'Requires authentication');
  return false;
}

/** The value of one query key, or null. The query string is scanned, never fully parsed. */
export function queryParam(ctx: Ctx, name: string): string | null {
  const q = ctx.queryString;
  if (q === '') return null;
  const needle = `${name}=`;
  let at = q.indexOf(needle);
  while (at >= 0) {
    if (at === 0 || q[at - 1] === '&') {
      let end = q.indexOf('&', at);
      if (end < 0) end = q.length;
      const raw = q.slice(at + needle.length, end);
      try {
        return decodeURIComponent(raw.replace(/\+/g, ' '));
      } catch {
        return raw;
      }
    }
    at = q.indexOf(needle, at + 1);
  }
  return null;
}

/** Decode one percent-encoded path segment (never throws). */
export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
