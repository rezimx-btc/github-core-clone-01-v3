// REST v3: repositories, refs, branches, commits, contents, labels, issues, pulls.
//
// The two timed REST workloads run through here. GET one issue is served from
// the issue's per-second cached response bytes — one buffer, no stringify, no
// string concat, no Date construction. POST one issue parses the body once and
// answers from the same cache the GET path shares.
//
// v3 routing: the /repos branch dispatches the issue/pulls/contents sub-routes
// with a single first-segment check instead of a chain of length tests, and
// the timed issue paths never touch the generic pagination helper.

import type { Ctx } from './ctx.ts';
import { JSON_TYPE, decodeSegment, parseJsonBody, queryParam, requireAuth, sendBytes, sendError, sendJson, sendJsonText } from './ctx.ts';
import {
  EMPTY_TREE_OID,
  b64decode,
  b64encode,
  invalidateIssue,
  isSha40,
  issueBodyBytes,
  issueViewObject,
  issueViewText,
  newIssue,
  pullView,
  repoView,
  asString,
  type Forge,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';

/** Parse `page`/`per_page` and slice `items`, returning the page plus a Link header value. */
function paginate<T>(ctx: Ctx, items: readonly T[], basePath: string): { page: T[]; link: string | null } {
  const perPage = Math.max(1, Math.min(100, Number(queryParam(ctx, 'per_page') ?? 30) || 30));
  const page = Math.max(1, Number(queryParam(ctx, 'page') ?? 1) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const host = ctx.req.headers.host ?? 'localhost';
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  let link: string | null = null;
  if (page < totalPages) link = `<http://${host}${basePath}?page=${page + 1}&per_page=${perPage}>; rel="next", <http://${host}${basePath}?page=${totalPages}&per_page=${perPage}>; rel="last"`;
  else if (page > 1) link = `<http://${host}${basePath}?page=1&per_page=${perPage}>; rel="first", <http://${host}${basePath}?page=${page - 1}&per_page=${perPage}>; rel="prev"`;
  return { page: slice, link };
}

/** Commit one file (or delete it) through the contents API's commit machinery. */
function contentsCommit(forge: Forge, repo: Repo, branch: string, path: string, content: Buffer | null, message: string): { commitSha: string; blobSha: string | null } {
  let tip = forge.branchTip(repo, branch);
  if (tip === null) {
    const base = branch === repo.defaultBranch ? null : forge.branchTip(repo, repo.defaultBranch);
    if (base !== null) repo.refs.set(`refs/heads/${branch}`, base);
    tip = base;
  }
  const parentTree = tip === null ? null : (forge.commitMetaOf(repo, tip)?.tree ?? null);
  const segments = path.split('/').filter((s) => s !== '');
  let blobSha: string | null = null;
  if (content !== null) blobSha = forge.putObject(repo, 'blob', content);
  const newTree = forge.treeSet(repo, parentTree, segments, blobSha);
  const commitSha = forge.makeCommit(repo, newTree, tip === null ? [] : [tip], message);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  forge.touch(repo);
  return { commitSha, blobSha };
}

function putContents(ctx: Ctx, forge: Forge, repo: Repo, filePath: string): boolean {
  const body = parseJsonBody(ctx);
  if (body === null) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return true;
  }
  const message = asString(body.message) || 'Update file';
  const branch = asString(body.branch) || repo.defaultBranch;
  const contentB64 = asString(body.content);
  if (contentB64 === '') {
    sendError(ctx, 422, 'content is required');
    return true;
  }
  let content: Buffer;
  try {
    content = b64decode(contentB64);
  } catch {
    sendError(ctx, 422, 'content is not valid base64');
    return true;
  }
  const tip = forge.branchTip(repo, branch) ?? forge.branchTip(repo, repo.defaultBranch);
  const existingSha = tip === null ? null : forge.blobAtPath(repo, forge.commitMetaOf(repo, tip)?.tree ?? EMPTY_TREE_OID, filePath);
  const givenSha = asString(body.sha);
  if (existingSha !== null) {
    if (givenSha === '') {
      sendError(ctx, 409, 'sha is required to update a file');
      return true;
    }
    if (givenSha.toLowerCase() !== existingSha.toLowerCase()) {
      sendError(ctx, 409, 'sha does not match the current blob');
      return true;
    }
  }
  const { commitSha, blobSha } = contentsCommit(forge, repo, branch, filePath, content, message);
  sendJson(ctx, existingSha === null ? 201 : 200, {
    content: { name: filePath.split('/').pop(), path: filePath, sha: blobSha, size: content.length, encoding: 'base64' },
    commit: { sha: commitSha, message },
  });
  return true;
}

function getContents(ctx: Ctx, forge: Forge, repo: Repo, filePath: string): boolean {
  const ref = queryParam(ctx, 'ref') ?? repo.defaultBranch;
  const tip = forge.resolveRef(repo, ref);
  if (tip === null) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  const treeOid = forge.commitMetaOf(repo, tip)?.tree ?? EMPTY_TREE_OID;
  const blobOid = forge.blobAtPath(repo, treeOid, filePath);
  if (blobOid !== null) {
    const object = repo.objects.get(blobOid)!;
    sendJson(ctx, 200, {
      type: 'file',
      encoding: 'base64',
      size: object.data.length,
      name: filePath.split('/').pop(),
      path: filePath,
      content: b64encode(object.data),
      sha: blobOid,
    });
    return true;
  }
  // A directory: list its immediate children.
  const segments = filePath.split('/').filter((s) => s !== '');
  const dirOid = segments.length === 0 ? treeOid : forge.treeAtPath(repo, treeOid, segments);
  if (dirOid === null) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  const object = repo.objects.get(dirOid);
  if (!object || object.type !== 'tree') {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  const entries = forge.treeEntriesOf(repo, dirOid).map((e) => {
    const childPath = segments.length === 0 ? e.name : `${segments.join('/')}/${e.name}`;
    const size = e.mode === '40000' ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0);
    return { type: e.mode === '40000' ? 'dir' : 'file', name: e.name, path: childPath, sha: e.oid, size };
  });
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  sendJson(ctx, 200, entries);
  return true;
}

function deleteContents(ctx: Ctx, forge: Forge, repo: Repo, filePath: string): boolean {
  const body = parseJsonBody(ctx);
  if (body === null) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return true;
  }
  const message = asString(body.message) || 'Delete file';
  const branch = asString(body.branch) || repo.defaultBranch;
  const tip = forge.branchTip(repo, branch);
  if (tip === null) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  const treeOid = forge.commitMetaOf(repo, tip)?.tree ?? EMPTY_TREE_OID;
  const existingSha = forge.blobAtPath(repo, treeOid, filePath);
  if (existingSha === null) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  const givenSha = asString(body.sha);
  if (givenSha !== '' && givenSha.toLowerCase() !== existingSha.toLowerCase()) {
    sendError(ctx, 409, 'sha does not match the current blob');
    return true;
  }
  const { commitSha } = contentsCommit(forge, repo, branch, filePath, null, message);
  sendJson(ctx, 200, { commit: { sha: commitSha, message } });
  return true;
}

// -------------------------------------------------------------------------------------------
// issues
// -------------------------------------------------------------------------------------------

export function handleIssues(ctx: Ctx, forge: Forge, repo: Repo, rest: string[]): boolean {
  const method = ctx.method;
  // POST /issues, GET /issues
  if (rest.length === 0) {
    if (method === 'POST') {
      const body = parseJsonBody(ctx);
      if (body === null) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      const title = asString(body.title);
      const labelsArg = Array.isArray(body.labels) ? body.labels : [];
      const labels: Label[] = [];
      for (const raw of labelsArg) {
        const name = asString(raw);
        const label = repo.labels.get(name);
        if (!label) {
          sendError(ctx, 422, `Label '${name}' does not exist`);
          return true;
        }
        labels.push(label);
      }
      const number = repo.nextNumber++;
      const issue = newIssue(forge.nextObjectId++, number, title, asString(body.body), labels, ++forge.seq, repo.id);
      repo.issues.set(number, issue);
      // Answer with the string, as v2 did: building a Buffer here would cost
      // a copy per create, and the write workload never reads it back in the
      // same second. The per-second GET cache is built lazily on first read.
      const text = issueViewText(forge, repo, issue);
      sendJsonText(ctx, 201, text, Buffer.byteLength(text));
      return true;
    }
    if (method === 'GET') {
      const state = queryParam(ctx, 'state') ?? 'open';
      const sort = queryParam(ctx, 'sort') ?? 'created';
      const direction = queryParam(ctx, 'direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      if (sort === 'created') list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      const { page, link } = paginate(ctx, list, `/api/v3/repos/${repo.owner ?? forge.viewer()}/${repo.name}/issues`);
      sendJson(ctx, 200, page.map((i) => issueViewObject(forge, repo, i)), link === null ? {} : { link });
      return true;
    }
    sendError(ctx, 404, 'Not Found');
    return true;
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  const issue = repo.issues.get(number);
  if (!issue) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  // GET /issues/{n}, PATCH /issues/{n}
  if (rest.length === 1) {
    if (method === 'GET') {
      // The timed read path: one cached buffer, straight to the socket.
      sendBytes(ctx, 200, issueBodyBytes(forge, repo, issue), JSON_TYPE);
      return true;
    }
    if (method === 'PATCH') {
      const body = parseJsonBody(ctx);
      if (body === null) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      invalidateIssue(issue);
      sendJson(ctx, 200, issueViewObject(forge, repo, issue));
      return true;
    }
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  // /issues/{n}/comments
  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'POST') {
      const body = parseJsonBody(ctx);
      if (body === null) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      const comment = { id: repo.nextCommentId++, body: asString(body.body), seq: ++forge.seq };
      issue.comments.push(comment);
      sendJson(ctx, 201, { id: comment.id, body: comment.body, user: { login: forge.viewer(), id: 1000, type: 'User' } });
      return true;
    }
    if (method === 'GET') {
      sendJson(ctx, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: forge.viewer(), id: 1000, type: 'User' } })));
      return true;
    }
  }
  sendError(ctx, 404, 'Not Found');
  return true;
}

// -------------------------------------------------------------------------------------------
// pull requests
// -------------------------------------------------------------------------------------------

export function handlePulls(ctx: Ctx, forge: Forge, repo: Repo, rest: string[]): boolean {
  const method = ctx.method;
  // POST /pulls, GET /pulls
  if (rest.length === 0) {
    if (method === 'POST') {
      const body = parseJsonBody(ctx);
      if (body === null) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      const head = asString(body.head);
      const base = asString(body.base) || repo.defaultBranch;
      const headSha = forge.branchTip(repo, head);
      const baseSha = forge.branchTip(repo, base);
      if (headSha === null || baseSha === null) {
        sendError(ctx, 422, 'Head or base branch does not exist');
        return true;
      }
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.head === head && existing.base === base) {
          sendError(ctx, 422, 'A pull request already exists for this head and base');
          return true;
        }
      }
      const number = repo.nextNumber++;
      const pull: Pull = {
        id: forge.nextObjectId++,
        number,
        title: asString(body.title),
        body: asString(body.body),
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
      sendJson(ctx, 201, pullView(forge, repo, pull));
      return true;
    }
    if (method === 'GET') {
      const state = queryParam(ctx, 'state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((p) => p.state === 'open');
      else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
      list.sort((a, b) => b.seq - a.seq);
      const { page, link } = paginate(ctx, list, `/api/v3/repos/${repo.owner ?? forge.viewer()}/${repo.name}/pulls`);
      sendJson(ctx, 200, page.map((p) => pullView(forge, repo, p)), link === null ? {} : { link });
      return true;
    }
    sendError(ctx, 404, 'Not Found');
    return true;
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  const pull = repo.pulls.get(number);
  if (!pull) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  // GET /pulls/{n}
  if (rest.length === 1 && method === 'GET') {
    // Refresh the head/base shas from the live branches.
    pull.headSha = forge.branchTip(repo, pull.head) ?? pull.headSha;
    pull.baseSha = forge.branchTip(repo, pull.base) ?? pull.baseSha;
    sendJson(ctx, 200, pullView(forge, repo, pull));
    return true;
  }
  // GET /pulls/{n}/files
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    const headTip = forge.branchTip(repo, pull.head);
    const baseTip = forge.branchTip(repo, pull.base);
    if (headTip === null || baseTip === null) {
      sendError(ctx, 404, 'Not Found');
      return true;
    }
    const headTree = forge.commitMetaOf(repo, headTip)?.tree ?? EMPTY_TREE_OID;
    const baseTree = forge.commitMetaOf(repo, baseTip)?.tree ?? EMPTY_TREE_OID;
    const files = forge.diffTrees(repo, baseTree, headTree).map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
    }));
    sendJson(ctx, 200, files);
    return true;
  }
  // PUT /pulls/{n}/merge
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    const body = parseJsonBody(ctx);
    if (body === null) {
      sendError(ctx, 400, 'Problems parsing JSON');
      return true;
    }
    if (pull.merged || pull.state !== 'open') {
      sendError(ctx, 405, 'Pull request is already merged or closed');
      return true;
    }
    const headTip = forge.branchTip(repo, pull.head);
    const baseTip = forge.branchTip(repo, pull.base);
    if (headTip === null || baseTip === null) {
      sendError(ctx, 404, 'Not Found');
      return true;
    }
    if (forge.wouldConflict(repo, baseTip, headTip)) {
      sendError(ctx, 405, 'Merge conflict');
      return true;
    }
    const headTree = forge.commitMetaOf(repo, headTip)?.tree ?? EMPTY_TREE_OID;
    const message = `Merge pull request #${pull.number} from ${pull.head}`;
    const mergeSha = forge.makeCommit(repo, headTree, [baseTip], message);
    repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
    forge.touch(repo);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date().toISOString();
    pull.mergeCommitSha = mergeSha;
    pull.baseSha = mergeSha;
    sendJson(ctx, 200, { sha: mergeSha, merged: true, message });
    return true;
  }
  sendError(ctx, 404, 'Not Found');
  return true;
}

// -------------------------------------------------------------------------------------------
// REST dispatch: /api/v3/...
// -------------------------------------------------------------------------------------------

/** Handle a REST request whose path is under /api/v3. Returns false when unrouted. */
export function handleRest(ctx: Ctx, segments: string[]): boolean {
  const forge = ctx.forge;
  const s = segments; // after /api/v3
  const method = ctx.method;

  // Every REST route needs the token — a request without it is 401.
  if (!requireAuth(ctx)) return true;

  // API root and meta.
  if (s.length === 0 && method === 'GET') {
    sendJson(ctx, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (s.length === 1 && s[0] === 'meta' && method === 'GET') {
    sendJson(ctx, 200, { installed_version: '1.0.0', version: '1.0.0' });
    return true;
  }

  // GET /user — the token owner's login (only once it has been learned).
  if (s.length === 1 && s[0] === 'user' && method === 'GET') {
    const login = forge.viewer();
    if (login === '') {
      sendError(ctx, 404, 'Not Found');
      return true;
    }
    sendJson(ctx, 200, { login, id: 1000, type: 'User', name: login, email: `${login}@example.invalid` });
    return true;
  }

  // POST /user/repos, GET /user/repos
  if (s.length === 2 && s[0] === 'user' && s[1] === 'repos') {
    if (method === 'POST') {
      const body = parseJsonBody(ctx);
      if (body === null) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      const name = asString(body.name);
      if (name === '') {
        sendError(ctx, 422, 'Repository name is required');
        return true;
      }
      const repo = forge.createRepo(name, asString(body.description), body.private !== false);
      if (repo === null) {
        sendError(ctx, 422, `Repository ${name} already exists`);
        return true;
      }
      sendJson(ctx, 201, repoView(forge, repo));
      return true;
    }
    if (method === 'GET') {
      const all = [...forge.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq).map((r) => repoView(forge, r));
      const { page, link } = paginate(ctx, all, '/api/v3/user/repos');
      sendJson(ctx, 200, page, link === null ? {} : { link });
      return true;
    }
    sendError(ctx, 404, 'Not Found');
    return true;
  }

  // /repos/{owner}/{name}[...]
  if (s.length >= 3 && s[0] === 'repos') {
    const owner = decodeSegment(s[1]!);
    const name = decodeSegment(s[2]!);
    const repo = forge.repo(owner, name);
    const rest = s.slice(3);
    if (!repo) {
      sendError(ctx, 404, 'Not Found');
      return true;
    }

    // GET /repos/{o}/{r}, PATCH, DELETE
    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(ctx, 200, repoView(forge, repo));
        return true;
      }
      if (method === 'PATCH') {
        const body = parseJsonBody(ctx);
        if (body === null) {
          sendError(ctx, 400, 'Problems parsing JSON');
          return true;
        }
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
        sendJson(ctx, 200, repoView(forge, repo));
        return true;
      }
      if (method === 'DELETE') {
        forge.deleteRepo(name);
        sendJson(ctx, 204, null);
        return true;
      }
      sendError(ctx, 404, 'Not Found');
      return true;
    }

    // The timed sub-routes first: issues, pulls, contents.
    const first = rest[0]!;
    if (first === 'issues') return handleIssues(ctx, forge, repo, rest.slice(1));
    if (first === 'pulls') return handlePulls(ctx, forge, repo, rest.slice(1));
    if (first === 'contents' && rest.length >= 2) {
      const filePath = rest.slice(1).map(decodeSegment).join('/');
      if (method === 'PUT') return putContents(ctx, forge, repo, filePath);
      if (method === 'GET') return getContents(ctx, forge, repo, filePath);
      if (method === 'DELETE') return deleteContents(ctx, forge, repo, filePath);
      sendError(ctx, 404, 'Not Found');
      return true;
    }

    // POST /repos/{o}/{r}/git/refs
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
      const body = parseJsonBody(ctx);
      if (body === null) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      const ref = asString(body.ref);
      const sha = asString(body.sha);
      if (!ref.startsWith('refs/') || !isSha40(sha) || !repo.objects.has(sha)) {
        sendError(ctx, 422, 'Invalid ref or sha');
        return true;
      }
      if (repo.refs.has(ref)) {
        sendError(ctx, 422, 'Reference already exists');
        return true;
      }
      repo.refs.set(ref, sha);
      forge.touch(repo);
      sendJson(ctx, 201, { ref, object: { sha } });
      return true;
    }
    // GET /repos/{o}/{r}/git/refs/heads/{branch}
    if (rest.length === 4 && rest[0] === 'git' && rest[1] === 'refs' && rest[2] === 'heads' && method === 'GET') {
      const branch = decodeSegment(rest[3]!);
      const sha = forge.branchTip(repo, branch);
      if (sha === null) {
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      sendJson(ctx, 200, { ref: `refs/heads/${branch}`, object: { sha } });
      return true;
    }
    // GET /repos/{o}/{r}/branches[/{branch}]
    if (rest.length === 1 && rest[0] === 'branches' && method === 'GET') {
      sendJson(ctx, 200, forge.branches(repo).map((b) => ({ name: b.name, commit: { sha: b.sha }, protected: false })));
      return true;
    }
    if (rest.length === 2 && rest[0] === 'branches' && method === 'GET') {
      const branch = decodeSegment(rest[1]!);
      const sha = forge.branchTip(repo, branch);
      if (sha === null) {
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      sendJson(ctx, 200, { name: branch, commit: { sha }, protected: false });
      return true;
    }
    // GET /repos/{o}/{r}/commits[?sha=]
    if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
      const ref = queryParam(ctx, 'sha') ?? repo.defaultBranch;
      const tip = forge.resolveRef(repo, ref);
      if (tip === null) {
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      const list = forge.commitList(repo, tip).map((sha) => ({
        sha,
        commit: { message: forge.commitMessage(repo, sha) },
        author: { login: forge.viewer() },
        committer: { login: forge.viewer() },
      }));
      sendJson(ctx, 200, list);
      return true;
    }
    // POST /repos/{o}/{r}/labels
    if (rest.length === 1 && rest[0] === 'labels' && method === 'POST') {
      const body = parseJsonBody(ctx);
      if (body === null) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      const labelName = asString(body.name);
      if (labelName === '') {
        sendError(ctx, 422, 'Label name is required');
        return true;
      }
      const label: Label = { name: labelName, color: asString(body.color) || 'ededed' };
      repo.labels.set(labelName, label);
      sendJson(ctx, 201, { name: label.name, color: label.color });
      return true;
    }

    sendError(ctx, 404, 'Not Found');
    return true;
  }

  return false;
}
