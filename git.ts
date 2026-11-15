// git smart HTTP: info/refs, upload-pack (protocol v2 and v0), receive-pack (v0).
//
// The clone workload fires 50 identical depth-1 fetches of one tip, so the
// fetch response body is cached per repository version and served 49 times
// from the cache; the v0 ref advertisement is cached the same way, and the
// v2 capability advertisement is a module constant (it never changes).
//
// v3: the upload-pack request is scanned in one pass (no packet objects), the
// receive-pack command list is parsed straight off the buffer with a hand
// hex reader, and the report-status answer is framed into a single buffer.

import type { Ctx } from './ctx.ts';
import { decodeSegment, sendBytes, sendError } from './ctx.ts';
import {
  EMPTY_TREE_OID,
  ZERO_OID,
  collectReachable,
  isAncestor,
  isSha40,
  parseTag,
  pktLenAt,
  pktLine,
  pktLines,
  readPack,
  scanPktLineStrings,
  writePack,
  PKT_FLUSH,
  type Forge,
  type GitObject,
  type Repo,
} from './store.ts';

const UPLOAD_V2_CAPS = ['version 2', 'ls-refs=unborn', 'fetch=shallow wait-for-done', 'object-format=sha1'];
const UPLOAD_V0_CAPS = 'side-band-64k shallow ofs-delta multi_ack thin-pack symref=HEAD:refs/heads/main';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta';

/** The v2 capability advertisement: identical for every repository, built once. */
const UPLOAD_V2_AD: Buffer = Buffer.concat([
  pktLine('# service=git-upload-pack\n'),
  PKT_FLUSH,
  pktLines([...UPLOAD_V2_CAPS.map((c) => `${c}\n`), 'flush']),
]);

function sortedRefs(repo: Repo): Array<{ name: string; oid: string; peeled?: string }> {
  const out: Array<{ name: string; oid: string; peeled?: string }> = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: { name: string; oid: string; peeled?: string } = { name, oid };
    if (name.startsWith('refs/tags/')) {
      const object = repo.objects.get(oid);
      if (object && object.type === 'tag') entry.peeled = parseTag(object.data).object;
    }
    out.push(entry);
  }
  return out;
}

function refLinesV0(repo: Repo, caps: string): Buffer {
  const refs = sortedRefs(repo);
  const parts: Buffer[] = [];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const head = repo.refs.get('refs/heads/main') ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? refs[0]!.oid;
    parts.push(pktLine(`${head} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v0 advertisement body for a service, cached on the repository's version. */
function advertisementV0(repo: Repo, service: string): Buffer {
  const isUpload = service === 'git-upload-pack';
  const cachedVersion = isUpload ? repo.refsCache.uploadVersion : repo.refsCache.receiveVersion;
  const cached = isUpload ? repo.refsCache.upload : repo.refsCache.receive;
  if (cached !== null && cachedVersion === repo.version) return cached;
  const preamble = isUpload ? '# service=git-upload-pack\n' : '# service=git-receive-pack\n';
  const caps = isUpload ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const body = Buffer.concat([pktLine(preamble), PKT_FLUSH, refLinesV0(repo, caps)]);
  if (isUpload) {
    repo.refsCache.upload = body;
    repo.refsCache.uploadVersion = repo.version;
  } else {
    repo.refsCache.receive = body;
    repo.refsCache.receiveVersion = repo.version;
  }
  return body;
}

export function handleGitInfoRefs(ctx: Ctx, owner: string, name: string, service: string): boolean {
  const forge = ctx.forge;
  const repo = forge.repo(owner, name);
  if (!repo) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  const isUpload = service === 'git-upload-pack';
  const contentType = `application/x-${service}-advertisement`;
  const v2 = isUpload && (ctx.req.headers['git-protocol'] ?? '').includes('version=2');
  if (v2) {
    sendBytes(ctx, 200, UPLOAD_V2_AD, contentType);
    return true;
  }
  sendBytes(ctx, 200, advertisementV0(repo, service), contentType);
  return true;
}

/**
 * Sideband-framed pack data: band-1 packets, each at most 65515 bytes of
 * payload, framed into one buffer (one length prefix per chunk, no per-chunk
 * allocations).
 */
function sidebandPack(pack: Buffer): Buffer {
  if (pack.length === 0) return Buffer.alloc(0);
  const CHUNK = 65515;
  const count = Math.ceil(pack.length / CHUNK);
  // Total size: 4 hex bytes + 1 band byte + payload, per chunk.
  let total = 0;
  for (let i = 0; i < count; i += 1) total += 4 + 1 + Math.min(CHUNK, pack.length - i * CHUNK);
  const out = Buffer.allocUnsafe(total);
  let at = 0;
  for (let i = 0; i < count; i += 1) {
    const start = i * CHUNK;
    const len = Math.min(CHUNK, pack.length - start);
    const frameLen = len + 5;
    out.write(frameLen.toString(16).padStart(4, '0'), at, 4, 'ascii');
    at += 4;
    out[at] = 1;
    at += 1;
    pack.copy(out, at, start, start + len);
    at += len;
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// fetch: what a client gets for its wants, minus what it already holds
// -------------------------------------------------------------------------------------------

/** Objects to send for a fetch: reachable from wants within `depth`, minus held objects. */
function fetchObjects(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | null,
): { objects: GitObject[]; newShallow: string[]; unshallow: string[] } {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const shallowSet = new Set(shallowBoundaries);
  // What the client already holds: full closures of haves, except shallow boundaries
  // (commit + tree + blobs only).
  const held = new Set<string>();
  for (const have of haves) {
    if (shallowSet.has(have)) {
      const object = repo.objects.get(have);
      if (object && object.type === 'commit') {
        held.add(have);
        const meta = repo.commitMeta.get(have);
        if (meta) for (const oid of collectReachable([meta.tree], lookup, repo)) held.add(oid);
      } else {
        for (const oid of collectReachable([have], lookup, repo)) held.add(oid);
      }
    } else {
      for (const oid of collectReachable([have], lookup, repo)) held.add(oid);
    }
  }
  // Walk from the wants, at most `depth` generations of commits (depth 1 = the tips only).
  // A FIFO queue with a head index: no O(n) shift on every dequeue.
  const wanted = new Set<string>();
  const newShallow = new Set<string>();
  const queue: Array<{ oid: string; generation: number }> = wants.map((oid) => ({ oid, generation: 1 }));
  let head = 0;
  const seenCommits = new Set<string>();
  while (head < queue.length) {
    const { oid, generation } = queue[head++]!;
    if (seenCommits.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    if (object.type === 'tag') {
      wanted.add(oid);
      queue.push({ oid: parseTag(object.data).object, generation });
      continue;
    }
    if (object.type !== 'commit') {
      wanted.add(oid);
      continue;
    }
    seenCommits.add(oid);
    const meta = repo.commitMeta.get(oid);
    if (!meta) continue;
    wanted.add(oid);
    for (const treeOid of collectReachable([meta.tree], lookup, repo)) wanted.add(treeOid);
    if (depth !== null && generation >= depth) {
      newShallow.add(oid);
      continue;
    }
    for (const parent of meta.parents) queue.push({ oid: parent, generation: generation + 1 });
  }
  // A commit at the depth cutoff is the new shallow boundary; a boundary now fully inside
  // is unshallow.
  const unshallow: string[] = [];
  for (const boundary of shallowBoundaries) {
    if (wanted.has(boundary) && !newShallow.has(boundary)) {
      const meta = repo.commitMeta.get(boundary);
      if (meta && meta.parents.every((p) => wanted.has(p))) unshallow.push(boundary);
    }
  }
  const objects: GitObject[] = [];
  for (const oid of wanted) {
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  return { objects, newShallow: [...newShallow], unshallow };
}

/** The frame around a fetch response, so identical fetches can share one cached body. */
function fetchCacheKey(wants: readonly string[], haves: readonly string[], shallow: readonly string[], depth: number | null, v2: boolean): string {
  return `${v2 ? '2' : '0'}|w:${wants.join(',')}|h:${haves.join(',')}|s:${shallow.join(',')}|d:${depth === null ? '' : depth}`;
}

function sendFetch(
  ctx: Ctx,
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallow: readonly string[],
  depth: number | null,
  contentType: string,
  v2: boolean,
): boolean {
  const key = fetchCacheKey(wants, haves, shallow, depth, v2);
  const cached = repo.fetchCache.get(key);
  if (cached !== undefined && cached.version === repo.version) {
    sendBytes(ctx, 200, cached.body, contentType);
    return true;
  }
  const { objects, newShallow, unshallow } = fetchObjects(repo, wants, haves, shallow, depth);
  const pack = writePack(objects);
  // Acknowledge a have the server can reach from a want; otherwise NAK.
  let ack: string | null = null;
  for (const have of haves) {
    if (wants.some((want) => isAncestor(repo, have, want))) {
      ack = have;
      break;
    }
  }
  const parts: Buffer[] = [];
  if (v2) {
    parts.push(pktLine('acknowledgments\n'));
    if (ack !== null) {
      parts.push(pktLine(`ACK ${ack}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(PKT_FLUSH);
    if ((depth !== null || shallow.length > 0) && (newShallow.length > 0 || unshallow.length > 0)) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of newShallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(PKT_FLUSH);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(pack));
    parts.push(PKT_FLUSH);
  } else {
    if (ack !== null) parts.push(pktLine(`ACK ${ack}\n`));
    else parts.push(pktLine('NAK\n'));
    for (const oid of newShallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(sidebandPack(pack));
    parts.push(PKT_FLUSH);
  }
  const body = Buffer.concat(parts);
  if (repo.fetchCache.size > 64) repo.fetchCache.clear();
  repo.fetchCache.set(key, { version: repo.version, body });
  sendBytes(ctx, 200, body, contentType);
  return true;
}

function uploadPackLsRefs(ctx: Ctx, repo: Repo, lines: readonly string[], contentType: string): boolean {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let seenDelim = false;
  for (const raw of lines.slice(1)) {
    const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    if (line === '') continue;
    if (!seenDelim) {
      if (line.startsWith('agent=') || line.startsWith('object-format=')) continue;
      seenDelim = true;
    }
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const key = `ls|p:${peel ? 1 : 0}|s:${symrefs ? 1 : 0}|u:${unborn ? 1 : 0}|x:${prefixes.join(',')}`;
  const cached = repo.fetchCache.get(key);
  if (cached !== undefined && cached.version === repo.version) {
    sendBytes(ctx, 200, cached.body, contentType);
    return true;
  }
  const refs = sortedRefs(repo);
  const keep = (refName: string): boolean => prefixes.length === 0 || prefixes.some((p) => refName.startsWith(p));
  const out: string[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (prefixes.length === 0) {
    if (headOid) out.push(`${headOid} HEAD${symrefs ? ` symref-target:${headTarget}` : ''}\n`);
    else if (unborn) out.push(`unborn HEAD symref-target:${headTarget}\n`);
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    out.push(`${line}\n`);
  }
  const body = pktLines([...out, 'flush']);
  if (repo.fetchCache.size > 64) repo.fetchCache.clear();
  repo.fetchCache.set(key, { version: repo.version, body });
  sendBytes(ctx, 200, body, contentType);
  return true;
}

/** Parse the `want`/`have`/`shallow`/`deepen` lines of an upload-pack fetch body. */
function parseFetchLines(lines: readonly string[]): { wants: string[]; haves: string[]; shallow: string[]; depth: number | null } {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let seenDelim = false;
  for (const raw of lines.slice(1)) {
    const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    if (line === '') continue;
    if (!seenDelim) {
      if (line.startsWith('agent=') || line.startsWith('object-format=')) continue;
      seenDelim = true;
    }
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim()) || null;
  }
  return { wants, haves, shallow, depth };
}

function uploadPackFetchV2(ctx: Ctx, repo: Repo, lines: readonly string[], contentType: string): boolean {
  const { wants, haves, shallow, depth } = parseFetchLines(lines);
  return sendFetch(ctx, repo, wants, haves, shallow, depth, contentType, true);
}

function uploadPackFetchV0(ctx: Ctx, repo: Repo, lines: readonly string[], contentType: string): boolean {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const raw of lines) {
    const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]!.trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim()) || null;
  }
  return sendFetch(ctx, repo, wants, haves, shallow, depth, contentType, false);
}

export function handleGitUploadPack(ctx: Ctx, owner: string, name: string): boolean {
  const forge = ctx.forge;
  const repo = forge.repo(owner, name);
  if (!repo) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  const v2 = (ctx.req.headers['git-protocol'] ?? '').includes('version=2');
  const contentType = 'application/x-git-upload-pack-result';
  let lines: string[];
  try {
    lines = scanPktLineStrings(ctx.body);
  } catch {
    sendError(ctx, 400, 'Malformed pkt-line stream');
    return true;
  }

  if (v2) {
    const command = (lines[0] ?? '').endsWith('\n') ? (lines[0] ?? '').slice(0, -1) : (lines[0] ?? '');
    if (command === 'command=ls-refs') return uploadPackLsRefs(ctx, repo, lines, contentType);
    if (command === 'command=fetch') return uploadPackFetchV2(ctx, repo, lines, contentType);
    sendError(ctx, 400, `Unknown upload-pack command ${JSON.stringify(command)}`);
    return true;
  }
  return uploadPackFetchV0(ctx, repo, lines, contentType);
}

// -------------------------------------------------------------------------------------------
// receive-pack: ref updates plus a pack, answered with a report-status
// -------------------------------------------------------------------------------------------

export function handleGitReceivePack(ctx: Ctx, owner: string, name: string): boolean {
  const forge = ctx.forge;
  const repo = forge.repo(owner, name);
  if (!repo) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  const contentType = 'application/x-git-receive-pack-result';
  const report = (unpack: string, refs: Array<{ ref: string; ok: boolean; reason: string }>): void => {
    const lines: Array<string | 'flush'> = [`unpack ${unpack}\n`];
    for (const r of refs) lines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
    lines.push('flush');
    const inner = pktLines(lines);
    const body = Buffer.concat([sidebandPack(inner), PKT_FLUSH]);
    ctx.res.writeHead(200, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': ctx.requestId });
    ctx.res.end(body);
  };
  // Parse command pkt-lines one at a time until the flush packet; the pack follows it raw.
  // Each command is "<old-oid> <new-oid> <ref>\n", the first carrying the capability
  // trailer after a NUL. Lengths are read by hand (four hex digits), not parseInt.
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let offset = 0;
  let sawFlush = false;
  try {
    for (;;) {
      if (offset + 4 > ctx.body.length) break;
      const len = pktLenAt(ctx.body, offset);
      if (!Number.isFinite(len) || len < 0) throw new Error('invalid pkt-line length');
      if (len === 0) {
        offset += 4;
        sawFlush = true;
        break;
      }
      if (len === 1 || len === 2) {
        offset += 4;
        continue;
      }
      if (len < 4 || offset + len > ctx.body.length) throw new Error('truncated pkt-line');
      const text = ctx.body.subarray(offset + 4, offset + len).toString('utf8');
      offset += len;
      const clean = text.endsWith('\n') ? text.slice(0, -1) : text;
      const nul = clean.indexOf('\0');
      const line = nul >= 0 ? clean.slice(0, nul) : clean;
      const firstSpace = line.indexOf(' ');
      const secondSpace = firstSpace < 0 ? -1 : line.indexOf(' ', firstSpace + 1);
      if (firstSpace > 0 && secondSpace > firstSpace) {
        commands.push({
          oldOid: line.slice(0, firstSpace),
          newOid: line.slice(firstSpace + 1, secondSpace),
          ref: line.slice(secondSpace + 1),
        });
      }
    }
  } catch {
    report('malformed request', []);
    return true;
  }
  if (!sawFlush || commands.length === 0) {
    report('malformed request', []);
    return true;
  }
  const packBytes = ctx.body.subarray(offset);
  const needsPack = commands.some((c) => c.newOid !== ZERO_OID);
  let incoming = new Map<string, GitObject>();
  if (needsPack) {
    if (packBytes.length === 0) {
      report('unpacker error', []);
      return true;
    }
    try {
      incoming = readPack(packBytes, (oid) => repo.objects.get(oid));
    } catch (err) {
      report(err instanceof Error ? err.message : 'unpacker error', []);
      return true;
    }
  }
  // Store every unpacked object, then apply the ref updates that fast-forward.
  forge.storePack(repo, incoming);
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'no such ref' });
      } else if (current !== command.oldOid) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        forge.touch(repo);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      forge.touch(repo);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (current === undefined || current !== command.oldOid) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    // The fast-forward check: generation numbers bound the walk to the depth
    // difference, so the push workload's one-commit advance is a single step.
    if (!isAncestor(repo, command.oldOid, command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    forge.touch(repo);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  report('ok', results);
  return true;
}

// -------------------------------------------------------------------------------------------
// git reference data for the REST layer (read-only)
// -------------------------------------------------------------------------------------------

export { EMPTY_TREE_OID };
