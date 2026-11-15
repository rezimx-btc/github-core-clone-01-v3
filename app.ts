// Router: one HTTP server, manual path dispatch.
//
// The dispatch reads `req.url` once and slices it by hand — no `new URL`, no
// URLSearchParams, no segment array for the hot paths — so a request's routing
// cost is a few string comparisons instead of two URL parses. The query string
// is scanned only when a handler actually asks for a key.
//
// v3: GET requests run through the dispatcher synchronously (there is no body
// to read, so no async IIFE per request), and the timed issue routes are
// matched by string positions before the generic REST segment split —
// /api/v3/repos/{owner}/{repo}/issues[/{n}] never builds a segment array.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { JSON_TYPE, decodeSegment, nextRequestId, queryParam, readBody, sendError, sendJson, type Ctx } from './ctx.ts';
import { handleGitInfoRefs, handleGitReceivePack, handleGitUploadPack } from './git.ts';
import { handleIssues } from './rest.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './gql.ts';
import { handleMcp } from './mcp.ts';

/** Split a raw request URL into its path and query string at the first '?'. */
function splitUrl(url: string): { path: string; queryString: string } {
  const q = url.indexOf('?');
  if (q < 0) return { path: url, queryString: '' };
  return { path: url.slice(0, q), queryString: url.slice(q + 1) };
}

/** One request, start to finish. Fully synchronous once the body is in hand. */
function dispatch(forge: Forge, req: IncomingMessage, res: ServerResponse, method: string, body: Buffer): void {
  const requestId = nextRequestId();
  const { path, queryString } = splitUrl(req.url ?? '/');
  const ctx: Ctx = { forge, req, res, method, path, queryString, requestId, body };
  try {
    if (method === 'GET' && path === '/healthz') {
      sendJson(ctx, 200, { ok: true });
      return;
    }
    // Git smart HTTP: /{owner}/{repo}.git/...
    if (path.length > 1 && path.charCodeAt(0) === 47) {
      const firstSlash = path.indexOf('/', 1);
      if (firstSlash > 1) {
        const secondSlash = path.indexOf('/', firstSlash + 1);
        const seg2 = secondSlash < 0 ? path.slice(firstSlash + 1) : path.slice(firstSlash + 1, secondSlash);
        if (seg2.endsWith('.git')) {
          const owner = decodeSegment(path.slice(1, firstSlash));
          const repoName = decodeSegment(seg2.slice(0, -4));
          const tail = secondSlash < 0 ? '' : path.slice(secondSlash + 1);
          if (tail === 'info/refs' && method === 'GET') {
            const service = queryParam(ctx, 'service') ?? '';
            if (service === 'git-upload-pack' || service === 'git-receive-pack') {
              handleGitInfoRefs(ctx, owner, repoName, service);
              return;
            }
            sendError(ctx, 400, 'Unknown service');
            return;
          }
          if (tail === 'git-upload-pack' && method === 'POST') {
            handleGitUploadPack(ctx, owner, repoName);
            return;
          }
          if (tail === 'git-receive-pack' && method === 'POST') {
            handleGitReceivePack(ctx, owner, repoName);
            return;
          }
          sendError(ctx, 404, 'Not Found');
          return;
        }
      }
    }
    // GraphQL v4
    if (path === '/api/graphql' && method === 'POST') {
      handleGraphQL(ctx);
      return;
    }
    // MCP
    if (path === '/mcp') {
      handleMcp(ctx);
      return;
    }
    // REST v3
    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      // Fast path for the timed issue routes: match by string position, no
      // segment array. Anything else falls through to the generic dispatch.
      if ((method === 'GET' || method === 'POST') && path.startsWith('/api/v3/repos/')) {
        const tail = path.slice('/api/v3/repos/'.length);
        const issuesAt = tail.indexOf('/issues');
        if (issuesAt > 0) {
          const ownerRepo = tail.slice(0, issuesAt);
          const slash = ownerRepo.indexOf('/');
          if (slash > 0 && ownerRepo.indexOf('/', slash + 1) < 0) {
            const after = tail.slice(issuesAt + '/issues'.length);
            if (after === '' || /^\/\d+$/.test(after)) {
              // Auth first, exactly as the generic route does — before the
              // repository lookup (which learns the token owner's login).
              if (!authCheck(ctx)) return;
              const owner = decodeSegment(ownerRepo.slice(0, slash));
              const repoName = decodeSegment(ownerRepo.slice(slash + 1));
              const repo = forge.repo(owner, repoName);
              if (!repo) {
                sendError(ctx, 404, 'Not Found');
                return;
              }
              const rest = after === '' ? [] : [after.slice(1)];
              handleIssues(ctx, forge, repo, rest);
              return;
            }
          }
        }
      }
      const rest = path.slice('/api/v3'.length);
      const segments = rest === '' ? [] : rest.split('/').filter((s) => s !== '');
      if (handleRest(ctx, segments)) return;
    }
    sendError(ctx, 404, 'Not Found');
  } catch (err) {
    if (!res.writableEnded) {
      try {
        sendError(ctx, 500, err instanceof Error ? err.message : 'Internal error');
      } catch {
        // The response is already gone; nothing left to do.
      }
    }
  }
}

/** The bearer check the generic REST dispatcher performs first. */
function authCheck(ctx: Ctx): boolean {
  const header = ctx.req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    sendError(ctx, 401, 'Requires authentication');
    return false;
  }
  const token = header.slice(7);
  if (token === '') {
    sendError(ctx, 401, 'Requires authentication');
    return false;
  }
  if (ctx.forge.expectedToken !== '' && token !== ctx.forge.expectedToken) {
    sendError(ctx, 401, 'Requires authentication');
    return false;
  }
  return true;
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const forge = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET';
    if (method === 'GET') {
      // No body to read: dispatch synchronously, no async IIFE, no promise.
      dispatch(forge, req, res, method, Buffer.alloc(0));
      return;
    }
    void (async () => {
      const requestId = nextRequestId();
      let body: Buffer = Buffer.alloc(0);
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(400, { 'content-type': JSON_TYPE, 'x-github-request-id': requestId });
        res.end(JSON.stringify({ message: 'Could not read the request body' }) + '\n');
        return;
      }
      dispatch(forge, req, res, method, body);
    })();
  });
}
