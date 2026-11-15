// MCP (Model Context Protocol, streamable HTTP): the 2026-07-28 era plus the
// legacy initialize handshake. Eight tools act on the same store as REST, so a
// repository or issue created over MCP reads back over /api/v3 unchanged.
//
// v3: the tools/list result — byte-identical on every call — is serialized
// once at module load and spliced into the response envelope, instead of
// being re-stringified per request.

import type { Ctx } from './ctx.ts';
import { authed, JSON_TYPE } from './ctx.ts';
import {
  EMPTY_TREE_OID,
  asString,
  isRecord,
  issueViewObject,
  newIssue,
  pullView,
  repoView,
  tsNow,
  type Forge,
  type Pull,
} from './store.ts';

const MCP_VERSION = '2026-07-28';
const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_SERVER_INFO = { name: 'github-core-clone-forge', version: '1.0.0' };

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the token user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login (the token user).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by owner, repository and number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Pull request state filter: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
];

/** The tools/list result, serialized once: only the `id` in the envelope varies. */
const TOOLS_LIST_RESULT_JSON = JSON.stringify({ tools: MCP_TOOLS });

function mcpSend(ctx: Ctx, status: number, payload: unknown): void {
  const text = `${JSON.stringify(payload)}\n`;
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.requestId,
  });
  ctx.res.end(text);
}

function mcpSendText(ctx: Ctx, status: number, text: string): void {
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.requestId,
  });
  ctx.res.end(text);
}

function mcpResult(ctx: Ctx, id: unknown, result: unknown): void {
  mcpSend(ctx, 200, { jsonrpc: '2.0', id: id ?? null, result });
}

function mcpError(ctx: Ctx, id: unknown, code: number, message: string, status = 200): void {
  mcpSend(ctx, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function mcpToolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, isError: false };
}

function mcpToolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callMcpTool(forge: Forge, name: string, args: Record<string, unknown>): { ok: boolean; value: unknown } {
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, value: null };
  const owner = asString(args.owner);
  if (owner !== '') forge.learnOwner(owner);
  switch (name) {
    case 'create_repo': {
      const repoName = asString(args.name);
      if (repoName === '') return { ok: false, value: 'name is required' };
      const repo = forge.createRepo(repoName, asString(args.description), args.private !== false);
      if (repo === null) return { ok: false, value: `Repository ${repoName} already exists` };
      const effectiveOwner = owner !== '' ? owner : forge.viewer();
      if (effectiveOwner !== '') repo.owner = effectiveOwner;
      return { ok: true, value: repoView(forge, repo) };
    }
    case 'get_repo': {
      const repo = forge.repo(owner, asString(args.repo));
      if (!repo) return { ok: false, value: 'Not Found' };
      return { ok: true, value: repoView(forge, repo) };
    }
    case 'create_issue': {
      const repo = forge.repo(owner, asString(args.repo));
      if (!repo) return { ok: false, value: 'Not Found' };
      const number = repo.nextNumber++;
      const issue = newIssue(forge.nextObjectId++, number, asString(args.title), asString(args.body), [], ++forge.seq, repo.id);
      repo.issues.set(number, issue);
      return { ok: true, value: issueViewObject(forge, repo, issue) };
    }
    case 'list_issues': {
      const repo = forge.repo(owner, asString(args.repo));
      if (!repo) return { ok: false, value: 'Not Found' };
      const state = asString(args.state) || 'open';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      list.sort((a, b) => b.seq - a.seq);
      return { ok: true, value: list.map((i) => issueViewObject(forge, repo, i)) };
    }
    case 'create_pull_request': {
      const repo = forge.repo(owner, asString(args.repo));
      if (!repo) return { ok: false, value: 'Not Found' };
      const head = asString(args.head);
      const base = asString(args.base) || repo.defaultBranch;
      const headSha = forge.branchTip(repo, head);
      const baseSha = forge.branchTip(repo, base);
      if (headSha === null || baseSha === null) return { ok: false, value: 'Head or base branch does not exist' };
      const number = repo.nextNumber++;
      const pull: Pull = {
        id: forge.nextObjectId++,
        number,
        title: asString(args.title),
        body: asString(args.body),
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        head,
        base,
        headSha,
        baseSha,
        seq: ++forge.seq,
      };
      repo.pulls.set(number, pull);
      return { ok: true, value: pullView(forge, repo, pull) };
    }
    case 'merge_pull_request': {
      const repo = forge.repo(owner, asString(args.repo));
      if (!repo) return { ok: false, value: 'Not Found' };
      const pull = repo.pulls.get(Number(args.pull_number));
      if (!pull) return { ok: false, value: 'Not Found' };
      if (pull.merged || pull.state !== 'open') return { ok: false, value: 'Pull request is already merged or closed' };
      const headTip = forge.branchTip(repo, pull.head);
      const baseTip = forge.branchTip(repo, pull.base);
      if (headTip === null || baseTip === null) return { ok: false, value: 'Not Found' };
      if (forge.wouldConflict(repo, baseTip, headTip)) return { ok: false, value: 'Merge conflict' };
      const headTree = forge.commitMetaOf(repo, headTip)?.tree ?? EMPTY_TREE_OID;
      const mergeSha = forge.makeCommit(repo, headTree, [baseTip], `Merge pull request #${pull.number} from ${pull.head}`);
      repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
      forge.touch(repo);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = tsNow();
      pull.mergeCommitSha = mergeSha;
      pull.baseSha = mergeSha;
      return { ok: true, value: { sha: mergeSha, merged: true, message: `Merge pull request #${pull.number} from ${pull.head}` } };
    }
    case 'get_issue': {
      const repo = forge.repo(owner, asString(args.repo));
      if (!repo) return { ok: false, value: 'Not Found' };
      const issue = repo.issues.get(Number(args.issue_number));
      if (!issue) return { ok: false, value: 'Not Found' };
      return { ok: true, value: issueViewObject(forge, repo, issue) };
    }
    case 'list_pull_requests': {
      const repo = forge.repo(owner, asString(args.repo));
      if (!repo) return { ok: false, value: 'Not Found' };
      const state = asString(args.state) || 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((p) => p.state === 'open');
      else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
      list.sort((a, b) => b.seq - a.seq);
      return { ok: true, value: list.map((p) => pullView(forge, repo, p)) };
    }
    default:
      return { ok: false, value: 'Unknown tool' };
  }
}

export function handleMcp(ctx: Ctx): boolean {
  const forge = ctx.forge;
  if (ctx.method === 'DELETE') {
    ctx.res.writeHead(204, { 'x-github-request-id': ctx.requestId });
    ctx.res.end();
    return true;
  }
  if (ctx.method !== 'POST') {
    mcpSend(ctx, 405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method not allowed' } });
    return true;
  }
  if (!authed(ctx)) {
    // Authentication is decided before any tool exists: a missing token is a plain 401.
    ctx.res.writeHead(401, { 'content-type': JSON_TYPE, 'x-github-request-id': ctx.requestId });
    ctx.res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }) + '\n');
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse(ctx.body.toString('utf8')) as unknown;
  } catch {
    mcpError(ctx, null, -32700, 'Parse error', 400);
    return true;
  }
  if (!isRecord(body) || typeof body.method !== 'string') {
    mcpError(ctx, isRecord(body) ? body.id : null, -32600, 'Invalid Request');
    return true;
  }
  const id = body.id ?? null;
  const params = isRecord(body.params) ? body.params : {};
  switch (body.method) {
    case 'server/discover': {
      mcpResult(ctx, id, {
        resultType: 'discover',
        supportedVersions: MCP_SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests, git smart HTTP.',
        serverInfo: MCP_SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
      });
      return true;
    }
    case 'initialize': {
      const offered = asString(params.protocolVersion);
      const negotiated = MCP_SUPPORTED_VERSIONS.includes(offered) ? offered : MCP_VERSION;
      mcpResult(ctx, id, { protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: MCP_SERVER_INFO });
      return true;
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/progress': {
      ctx.res.writeHead(202, { 'x-github-request-id': ctx.requestId });
      ctx.res.end();
      return true;
    }
    case 'ping': {
      mcpResult(ctx, id, {});
      return true;
    }
    case 'tools/list': {
      // Byte-identical to v2's answer: the pre-serialized result is spliced
      // into the envelope; only the request id is written fresh.
      mcpSendText(ctx, 200, `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":${TOOLS_LIST_RESULT_JSON}}\n`);
      return true;
    }
    case 'tools/call': {
      const toolName = asString(params.name);
      const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      const tool = MCP_TOOLS.find((t) => t.name === toolName);
      if (!tool) {
        mcpError(ctx, id, -32602, `Unknown tool: ${toolName}`);
        return true;
      }
      const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) {
        mcpError(ctx, id, -32602, `Missing required arguments: ${missing.join(', ')}`);
        return true;
      }
      const outcome = callMcpTool(forge, toolName, args);
      if (!outcome.ok) {
        mcpResult(ctx, id, mcpToolError(asString(outcome.value) || 'Tool failed'));
        return true;
      }
      mcpResult(ctx, id, mcpToolResult(outcome.value));
      return true;
    }
    default: {
      mcpError(ctx, id, -32601, `Method not found: ${body.method}`);
      return true;
    }
  }
}
