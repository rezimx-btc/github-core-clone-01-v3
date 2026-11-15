// github-core-clone-forge v3 — the in-memory store and the git object model.
//
// One Node process, no database, no git binary, no outside service. Every git
// object, issue, pull request and label lives in memory. This file owns the
// object model (SHA-1 ids, commit / tree / tag parsing and building, packfile
// read and write) and the Forge class; the HTTP handlers live in git.ts,
// rest.ts, gql.ts and mcp.ts.
//
// v3 speed work, over v2 (all behavior identical, only the cost changed):
//   - Pack reads take one pass with no index maps when the pack carries no
//     deltas (the trial's packs never do): entries resolve inline, in order.
//   - A pack entry keeps its verified deflated bytes (`zdata`) beside the
//     inflated ones. A later pack write re-emits those bytes verbatim instead
//     of deflating again — the bytes were inflated and hash-checked when they
//     arrived, so re-emitting them is exact.
//   - A fresh commit whose parents are already stored gets its generation
//     straight from them (max + 1) instead of a memoized walk.
//   - Trees are parsed lazily on first use, never at insert time.
//   - Issue views are built with a fast string escaper and a node id computed
//     once at creation; one timestamp string is shared per wall-clock second.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const SHA40_RE = /^[0-9a-f]{40}$/;
export function isSha40(s: string): boolean {
  return SHA40_RE.test(s);
}

/** SHA-1 of raw bytes, as 40 hex characters. */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The SHA-1 id of a git object: sha1("<type> <len>\0" + data). */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  const h = createHash('sha1');
  h.update(head);
  h.update(data);
  return h.digest('hex');
}

export function b64encode(data: Buffer | string): string {
  return Buffer.from(data).toString('base64');
}

export function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, ''), 'base64');
}

export function b64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function b64urlDecode(text: string): string | null {
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/** The current UTC second's ISO timestamp, shared until the second rolls over. */
let tsCacheSec = -1;
let tsCacheStr = '';
export function tsNow(): string {
  const sec = Math.floor(Date.now() / 1000);
  if (sec !== tsCacheSec) {
    tsCacheSec = sec;
    tsCacheStr = new Date(sec * 1000).toISOString();
  }
  return tsCacheStr;
}

/** A fresh ISO timestamp (the per-second cache above, kept as a function). */
export function isoNow(): string {
  return tsNow();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A global id: base64url("<kind>:<parts joined by :>"). */
export function globalId(kind: string, ...parts: Array<string | number>): string {
  return b64urlEncode(`${kind}:${parts.join(':')}`);
}

// -------------------------------------------------------------------------------------------
// git object model
// -------------------------------------------------------------------------------------------

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
  /**
   * The entry's deflated bytes as received in a pack, when they came from one:
   * already inflated and hash-checked on arrival, so a later pack write can
   * re-emit them verbatim. Null for objects built locally.
   */
  zdata: Buffer | null;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitMeta {
  tree: string;
  parents: string[];
  message: string;
  /** Depth from the root commit (root = 0): the fast-forward check's ruler. */
  generation: number;
}

/** Parse a tree object into its entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** Build a tree object; entries sort by name (directories sort as "name/"). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const left = a.mode === '40000' ? `${a.name}/` : a.name;
    const right = b.mode === '40000' ? `${b.name}/` : b.name;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const parts: Buffer[] = new Array(sorted.length * 2);
  for (let i = 0; i < sorted.length; i += 1) {
    const e = sorted[i]!;
    parts[i * 2] = Buffer.from(`${e.mode} ${e.name}\0`, 'utf8');
    parts[i * 2 + 1] = Buffer.from(e.oid, 'hex');
  }
  return Buffer.concat(parts);
}

/** Parse a commit's headers and message (generation is filled in by the store). */
export function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string } {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  const header = data.subarray(0, headerEnd).toString('utf8');
  let start = 0;
  for (let i = 0; i <= header.length; i += 1) {
    if (i === header.length || header.charCodeAt(i) === 10) {
      const line = header.slice(start, i);
      start = i + 1;
      if (line === '') continue;
      const space = line.indexOf(' ');
      const key = space < 0 ? line : line.slice(0, space);
      const value = space < 0 ? '' : line.slice(space + 1);
      if (key === 'tree') tree = value;
      else if (key === 'parent') parents.push(value);
    }
  }
  return { tree, parents, message };
}

/** Build a commit object's bytes. */
export function buildCommitText(tree: string, parents: readonly string[], author: string, committer: string, message: string): Buffer {
  let text = `tree ${tree}\n`;
  for (const p of parents) text += `parent ${p}\n`;
  text += `author ${author}\ncommitter ${committer}\n\n${message}`;
  return Buffer.from(text, 'utf8');
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): { object: string; type: GitObjectType; tag: string; tagger: string; message: string } {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  const header = data.subarray(0, headerEnd).toString('utf8');
  let start = 0;
  for (let i = 0; i <= header.length; i += 1) {
    if (i === header.length || header.charCodeAt(i) === 10) {
      const line = header.slice(start, i);
      start = i + 1;
      if (line === '') continue;
      const space = line.indexOf(' ');
      if (space >= 0) headers.set(line.slice(0, space), line.slice(space + 1));
    }
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

// -------------------------------------------------------------------------------------------
// pkt-line codec (git's framing: 4 hex length bytes, 0000 flush, 0001 delim, 0002 response-end)
// -------------------------------------------------------------------------------------------

const HEX_DIGITS = '0123456789abcdef';

/** One pkt-line framing: 4 hex length bytes + payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.alloc(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Several pkt-lines (or flush/delim markers) in one buffer. */
export function pktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

export interface PktPacket {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** The 4-byte hex length at `buf[offset]` as a number, or NaN when it is not hex. */
export function pktLenAt(buf: Buffer, offset: number): number {
  let len = 0;
  for (let i = 0; i < 4; i += 1) {
    const c = buf[offset + i]!;
    let v: number;
    if (c >= 48 && c <= 57) v = c - 48;
    else if (c >= 97 && c <= 102) v = c - 87;
    else if (c >= 65 && c <= 70) v = c - 55;
    else return NaN;
    len = len * 16 + v;
  }
  return len;
}

/** Split a buffer into pkt-line packets; also returns where framing stopped. */
export function decodePktLines(buf: Buffer): { packets: PktPacket[]; offset: number } {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const len = pktLenAt(buf, offset);
    if (!Number.isFinite(len) || len < 0) throw new Error('invalid pkt-line length');
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { packets, offset };
}

/**
 * The `data` payloads of a pkt-line stream as strings, in order — one pass,
 * no packet objects. Stops at the first flush packet; throws on bad framing.
 */
export function scanPktLineStrings(buf: Buffer): string[] {
  const out: string[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const len = pktLenAt(buf, offset);
    if (!Number.isFinite(len) || len < 0) throw new Error('invalid pkt-line length');
    if (len === 0) return out;
    if (len === 1 || len === 2) {
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) throw new Error('truncated pkt-line');
    out.push(buf.subarray(offset + 4, offset + len).toString('utf8'));
    offset += len;
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// packfile write and read (plain objects on write; full OFS/REF delta resolution on read)
// -------------------------------------------------------------------------------------------

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const out: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    out.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  out.push(first);
  return Buffer.from(out);
}

/**
 * Serialize objects as a v2 packfile (no deltas), with the SHA-1 trailer.
 * An object that still carries the deflated bytes it arrived with re-emits
 * them verbatim instead of deflating again.
 */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = new Array(objects.length * 2 + 2);
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts[0] = header;
  for (let i = 0; i < objects.length; i += 1) {
    const object = objects[i]!;
    parts[1 + i * 2] = packObjectHeader(object.type, object.data.length);
    parts[2 + i * 2] = object.zdata ? object.zdata : deflateSync(object.data);
  }
  const body = Buffer.concat(parts.slice(0, objects.length * 2 + 1));
  parts[objects.length * 2 + 1] = createHash('sha1').update(body).digest();
  return Buffer.concat([body, parts[objects.length * 2 + 1]!]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git delta to its base, producing the target object. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

/**
 * Read a packfile; resolves OFS/REF deltas against pack entries and `resolveBase`.
 *
 * Fast path: a pack with no delta entries resolves inline, in one pass, with
 * no index maps. Delta packs take the same result through the indexed path.
 * Every plain entry keeps its deflated bytes (`zdata`) so a later pack write
 * can re-emit them without deflating again.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    zdata: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolved?: GitObject;
    oid?: string;
  }
  const raw: Raw[] = new Array(count);
  let hasDelta = false;
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0), zdata: Buffer.alloc(0) };
    if (typeCode === 6) {
      hasDelta = true;
      let byte = pack[offset]!;
      offset += 1;
      let value = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset++]!;
        value = ((value + 1) * 128) + (byte & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      hasDelta = true;
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type ${typeCode}`);
    }
    const dataStart = offset;
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    entry.zdata = pack.subarray(dataStart, inflated.next);
    offset = inflated.next;
    raw[i] = entry;
  }
  if (offset !== trailerStart) throw new Error('pack has trailing bytes');
  const objects = new Map<string, GitObject>();
  if (!hasDelta) {
    // No deltas: hash and store inline, in pack order.
    for (const entry of raw) {
      const type = CODE_TYPE[entry.typeCode]!;
      const object: GitObject = { type, data: entry.data, zdata: entry.zdata };
      const oid = hashObject(type, entry.data);
      if (!objects.has(oid)) objects.set(oid, object);
    }
    return objects;
  }
  const byOffset = new Map<number, Raw>();
  for (const entry of raw) byOffset.set(entry.offset, entry);
  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): GitObject => {
    if (entry.resolved && entry.oid) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let result: GitObject;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      result = { type: base.type, data: applyDelta(base.data, entry.data), zdata: null };
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        result = { type: base.type, data: applyDelta(base.data, entry.data), zdata: null };
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} missing`);
        result = { type: external.type, data: applyDelta(external.data, entry.data), zdata: null };
      }
    } else {
      result = { type: CODE_TYPE[entry.typeCode]!, data: entry.data, zdata: entry.zdata };
    }
    const oid = hashObject(result.type, result.data);
    entry.resolved = result;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return result;
  };
  for (const entry of raw) {
    const object = resolve(entry);
    if (!objects.has(entry.oid!)) objects.set(entry.oid!, object);
  }
  return objects;
}

// -------------------------------------------------------------------------------------------
// the store: repositories, issues, pull requests, labels, comments
// -------------------------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  seq: number;
  /** The issue's global id, computed once at creation. */
  nodeId: string;
  /** Cached GET response: JSON with `"updated_at":"` as the final field, split at the timestamp. */
  cachedHead: string | null;
  cachedTail: string | null;
  cachedHeadBytes: number;
  cachedTailBytes: number;
  /** The whole GET response as bytes, valid while the wall-clock second matches. */
  cachedBody: Buffer | null;
  cachedBodySec: number;
}

export interface Comment {
  id: number;
  body: string;
  seq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  seq: number;
}

export interface ChangedFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  oldOid: string | null;
  newOid: string | null;
}

export interface Repo {
  name: string;
  owner: string | null;
  id: number;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  commitSeq: number;
  objects: Map<string, GitObject>;
  /** Parsed commit headers, filled at insert: no re-parse on any walk. */
  commitMeta: Map<string, CommitMeta>;
  /** Parsed tree entries, filled lazily on first use. */
  treeMeta: Map<string, TreeEntry[]>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  nextNumber: number;
  nextCommentId: number;
  /** Bumped on every mutation: git response caches key on it. */
  version: number;
  /** Cached v0 ref advertisement (upload and receive), each with its own version. */
  refsCache: { uploadVersion: number; upload: Buffer | null; receiveVersion: number; receive: Buffer | null };
  /** Cached fetch response bodies: key = tip + depth + haves, value = { version, body }. */
  fetchCache: Map<string, { version: number; body: Buffer }>;
}

export class Forge {
  repos = new Map<string, Repo>();
  viewerLogin: string | null = null;
  nextRepoId = 1;
  nextObjectId = 1;
  seq = 0;
  expectedToken: string;

  constructor() {
    this.expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  }

  /** Learn the token owner's login from the first owner-bearing request; first sight wins. */
  learnOwner(owner: string): void {
    if (this.viewerLogin === null && owner !== '') this.viewerLogin = owner;
  }

  viewer(): string {
    return this.viewerLogin ?? '';
  }

  /** Find a repository by name, binding it to `owner` on first sight; null when absent or foreign. */
  repo(owner: string, name: string): Repo | null {
    this.learnOwner(owner);
    const repo = this.repos.get(name);
    if (!repo) return null;
    if (repo.owner === null) repo.owner = owner;
    if (repo.owner !== owner) return null;
    return repo;
  }

  repoByName(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(name)) return null;
    const repo: Repo = {
      name,
      owner: null,
      id: this.nextRepoId++,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdSeq: ++this.seq,
      commitSeq: 0,
      objects: new Map(),
      commitMeta: new Map(),
      treeMeta: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      version: 1,
      refsCache: { uploadVersion: 0, upload: null, receiveVersion: 0, receive: null },
      fetchCache: new Map(),
    };
    // The empty tree, so an unborn repository's first commit has a tree to build on.
    this.putObject(repo, 'tree', Buffer.alloc(0));
    this.repos.set(name, repo);
    return repo;
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  /** Store an object; for commits also cache the parsed metadata and generation. */
  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data, zdata: null });
      if (type === 'commit') {
        const parsed = parseCommit(data);
        repo.commitMeta.set(oid, { tree: parsed.tree, parents: parsed.parents, message: parsed.message, generation: 0 });
        const meta = repo.commitMeta.get(oid)!;
        meta.generation = generationOf(repo, oid, new Set([oid]), new Map(), new Set());
      }
    }
    return oid;
  }

  /** Store a pack's objects; fills the same metadata caches as putObject. */
  storePack(repo: Repo, objects: Map<string, GitObject>): void {
    // Pass 1: store every object and parse commit headers. Trees stay unparsed
    // until first use (treeEntriesOf parses and caches them then).
    const fresh: string[] = [];
    for (const [oid, object] of objects) {
      if (repo.objects.has(oid)) continue;
      repo.objects.set(oid, object);
      if (object.type === 'commit') {
        const parsed = parseCommit(object.data);
        repo.commitMeta.set(oid, { tree: parsed.tree, parents: parsed.parents, message: parsed.message, generation: 0 });
        fresh.push(oid);
      }
    }
    // Pass 2: generations for the fresh commits only. A commit whose parents
    // are all already stored takes max(parent generation) + 1 straight from
    // them — the one-commit push is one lookup, not a walk of its history.
    for (const oid of fresh) {
      const meta = repo.commitMeta.get(oid);
      if (!meta) continue;
      let direct = -1;
      let allStored = meta.parents.length > 0;
      for (const parent of meta.parents) {
        const parentMeta = repo.commitMeta.get(parent);
        if (!parentMeta || fresh.includes(parent)) {
          allStored = false;
          break;
        }
        if (parentMeta.generation > direct) direct = parentMeta.generation;
      }
      if (allStored) {
        meta.generation = direct + 1;
      } else {
        const freshSet = new Set(fresh);
        meta.generation = generationOf(repo, oid, freshSet, new Map(), new Set());
      }
    }
  }

  /** Bump the mutation counter so cached git responses rebuild. */
  touch(repo: Repo): void {
    repo.version += 1;
  }

  commitMetaOf(repo: Repo, oid: string): CommitMeta | undefined {
    return repo.commitMeta.get(oid);
  }

  treeEntriesOf(repo: Repo, oid: string): TreeEntry[] {
    let entries = repo.treeMeta.get(oid);
    if (entries === undefined) {
      const object = repo.objects.get(oid);
      entries = object && object.type === 'tree' ? parseTree(object.data) : [];
      repo.treeMeta.set(oid, entries);
    }
    return entries;
  }

  /** The commit a ref (branch name, full ref or oid) resolves to, or null. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (isSha40(ref)) return repo.objects.has(ref) ? ref : null;
    if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
    return repo.refs.get(`refs/heads/${ref}`) ?? null;
  }

  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  branches(repo: Repo): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /** Create a commit object (and store it); the message is kept verbatim. */
  makeCommit(repo: Repo, treeOid: string, parents: readonly string[], message: string): string {
    const login = this.viewer() || 'forge';
    const stamp = 1700000000 + repo.commitSeq++;
    const who = `${login} <${login}@example.invalid> ${stamp} +0000`;
    const data = buildCommitText(treeOid, parents, who, who, message);
    return this.putObject(repo, 'commit', data);
  }

  commitMessage(repo: Repo, oid: string): string {
    return repo.commitMeta.get(oid)?.message ?? '';
  }

  /** Commits reachable from `tip`, tip first, parents after (depth-first, deduplicated). */
  commitList(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      const meta = repo.commitMeta.get(oid);
      if (!meta) continue;
      seen.add(oid);
      out.push(oid);
      for (let i = meta.parents.length - 1; i >= 0; i -= 1) stack.push(meta.parents[i]!);
    }
    return out;
  }

  /** The first common ancestor of two commits, or null. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = new Set(this.commitList(repo, a));
    const queue = [b];
    let head = 0;
    const seen = new Set<string>();
    while (head < queue.length) {
      const oid = queue[head++]!;
      if (ancestorsA.has(oid)) return oid;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const meta = repo.commitMeta.get(oid);
      if (!meta) continue;
      for (const parent of meta.parents) queue.push(parent);
    }
    return null;
  }

  /** Flatten a tree to path -> {oid, mode}; null tree means empty. */
  flattenTree(repo: Repo, treeOid: string | null, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
    if (treeOid === null) return out;
    for (const entry of this.treeEntriesOf(repo, treeOid)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.flattenTree(repo, entry.oid, path, out);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
    return out;
  }

  /** The tree oid at `path` inside `treeOid` (a directory), or null when absent. */
  treeAtPath(repo: Repo, treeOid: string, segments: readonly string[]): string | null {
    let current: string | null = treeOid;
    for (const segment of segments) {
      if (current === null) return null;
      const entry: TreeEntry | undefined = this.treeEntriesOf(repo, current).find((e) => e.name === segment);
      if (!entry) return null;
      current = entry.mode === '40000' ? entry.oid : null;
      if (current === null && entry.mode !== '40000') return null;
    }
    return current;
  }

  /** The blob oid at `path` inside the tree, or null. */
  blobAtPath(repo: Repo, treeOid: string, path: string): string | null {
    const segments = path.split('/').filter((s) => s !== '');
    if (segments.length === 0) return null;
    const parent = segments.length === 1 ? treeOid : this.treeAtPath(repo, treeOid, segments.slice(0, -1));
    if (parent === null) return null;
    const entry: TreeEntry | undefined = this.treeEntriesOf(repo, parent).find((e) => e.name === segments[segments.length - 1]);
    return entry && entry.mode !== '40000' ? entry.oid : null;
  }

  /** A new root tree with `path` set to `blobOid` (or removed when null). */
  treeSet(repo: Repo, rootOid: string | null, segments: readonly string[], blobOid: string | null): string {
    if (segments.length === 0) return rootOid ?? EMPTY_TREE_OID;
    const [head, ...rest] = segments as [string, ...string[]];
    const entries = rootOid === null ? [] : this.treeEntriesOf(repo, rootOid);
    const map = new Map<string, TreeEntry>();
    for (const e of entries) map.set(e.name, e);
    if (rest.length === 0) {
      if (blobOid === null) map.delete(head);
      else map.set(head, { mode: '100644', name: head, oid: blobOid });
    } else {
      const child = map.get(head);
      const childOid = child && child.mode === '40000' ? child.oid : null;
      const next = this.treeSet(repo, childOid, rest, blobOid);
      if (next === EMPTY_TREE_OID && blobOid === null) {
        const still = this.flattenTree(repo, next);
        if (still.size === 0) map.delete(head);
        else map.set(head, { mode: '40000', name: head, oid: next });
      } else {
        map.set(head, { mode: '40000', name: head, oid: next });
      }
    }
    if (map.size === 0) return EMPTY_TREE_OID;
    return this.putObject(repo, 'tree', buildTree([...map.values()]));
  }

  /** Diff two trees (null = empty): changed files with line counts. */
  diffTrees(repo: Repo, baseTree: string | null, headTree: string | null): ChangedFile[] {
    const base = this.flattenTree(repo, baseTree);
    const head = this.flattenTree(repo, headTree);
    const out: ChangedFile[] = [];
    const lineCount = (oid: string | null): number => {
      if (oid === null) return 0;
      const object = repo.objects.get(oid);
      if (!object) return 0;
      const text = object.data.toString('utf8');
      if (text === '') return 0;
      const lines = text.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      return lines.length;
    };
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) {
        out.push({ filename: path, status: 'removed', additions: 0, deletions: lineCount(b.oid), changes: lineCount(b.oid), oldOid: b.oid, newOid: null });
      } else if (!b && h) {
        out.push({ filename: path, status: 'added', additions: lineCount(h.oid), deletions: 0, changes: lineCount(h.oid), oldOid: null, newOid: h.oid });
      } else if (b && h && b.oid !== h.oid) {
        const additions = lineCount(h.oid);
        const deletions = lineCount(b.oid);
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions, oldOid: b.oid, newOid: h.oid });
      }
    }
    return out;
  }

  /** True when the head's changes overlap the base's on any path with a different result. */
  wouldConflict(repo: Repo, baseTip: string, headTip: string): boolean {
    const base = this.mergeBase(repo, baseTip, headTip);
    const baseTree = base === null ? null : this.commitMetaOf(repo, base)?.tree ?? null;
    const baseTreeOf = (tip: string): string => this.commitMetaOf(repo, tip)?.tree ?? EMPTY_TREE_OID;
    const headChanges = new Map(this.diffTrees(repo, baseTree, baseTreeOf(headTip)).map((f) => [f.filename, f]));
    const baseChanges = new Map(this.diffTrees(repo, baseTree, baseTreeOf(baseTip)).map((f) => [f.filename, f]));
    for (const [path, h] of headChanges) {
      const b = baseChanges.get(path);
      if (!b) continue;
      if (h.newOid === b.newOid) continue;
      return true;
    }
    return false;
  }

  /** The mergeable state of a pull request's head against its base. */
  mergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    const headTip = this.branchTip(repo, pull.head);
    const baseTip = this.branchTip(repo, pull.base);
    if (headTip === null || baseTip === null) return 'UNKNOWN';
    if (pull.merged) return 'MERGEABLE';
    return this.wouldConflict(repo, baseTip, headTip) ? 'CONFLICTING' : 'MERGEABLE';
  }
}

// -------------------------------------------------------------------------------------------
// JSON views. The issue view is cached as pre-serialized text: `updated_at` is the view's
// last field, so a cached head (everything through `"updated_at":"`) plus the live timestamp
// plus `"}\n` rebuilds a fresh, correct response with two string concats and no stringify.
// A mutation (PATCH, close) clears the cache; a read never does. The GET path goes one
// step further: the whole response body is cached as bytes for the current second.
// -------------------------------------------------------------------------------------------

/** JSON-escape a string: the fast path when nothing needs escaping. */
export function jsonEscape(value: string): string {
  let needs = false;
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c === 34 || c === 92 || c < 32) {
      needs = true;
      break;
    }
  }
  if (!needs) return `"${value}"`;
  return JSON.stringify(value);
}

export function repoView(forge: Forge, repo: Repo): Record<string, unknown> {
  const owner = repo.owner ?? forge.viewer();
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${owner}/${repo.name}`,
    url: `/api/v3/repos/${owner}/${repo.name}`,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: tsNow(),
    pushed_at: tsNow(),
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

export function pullView(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  const owner = repo.owner ?? forge.viewer();
  return {
    id: pull.id,
    node_id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: pull.headSha, label: `${owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${owner}:${pull.base}` },
    user: { login: owner, id: 1000, type: 'User' },
    html_url: `https://github.com/${owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${owner}/${repo.name}/pulls/${pull.number}`,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: tsNow(),
  };
}

/** Build (and cache) an issue's serialized view, split around the live timestamp. */
export function issueViewParts(forge: Forge, repo: Repo, issue: Issue): { head: string; tail: string; headBytes: number; tailBytes: number } {
  if (issue.cachedHead !== null && issue.cachedTail !== null) {
    return { head: issue.cachedHead, tail: issue.cachedTail, headBytes: issue.cachedHeadBytes, tailBytes: issue.cachedTailBytes };
  }
  const owner = repo.owner ?? forge.viewer();
  let labels = '';
  for (let i = 0; i < issue.labels.length; i += 1) {
    const l = issue.labels[i]!;
    if (i > 0) labels += ',';
    labels += `{"name":${jsonEscape(l.name)},"color":${jsonEscape(l.color)}}`;
  }
  const head =
    `{"id":${issue.id},"node_id":${jsonEscape(issue.nodeId)},"number":${issue.number},` +
    `"title":${jsonEscape(issue.title)},"body":${jsonEscape(issue.body)},"state":${jsonEscape(issue.state)},` +
    `"labels":[${labels}],"user":{"login":${jsonEscape(owner)},"id":1000,"type":"User"},` +
    `"html_url":${jsonEscape(`https://github.com/${owner}/${repo.name}/issues/${issue.number}`)},` +
    `"url":${jsonEscape(`/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`)},` +
    `"created_at":"2026-01-01T00:00:00Z","updated_at":"`;
  const tail = `"}\n`;
  issue.cachedHead = head;
  issue.cachedTail = tail;
  issue.cachedHeadBytes = Buffer.byteLength(head);
  issue.cachedTailBytes = Buffer.byteLength(tail);
  return { head, tail, headBytes: issue.cachedHeadBytes, tailBytes: issue.cachedTailBytes };
}

/** The issue's full serialized view (fresh timestamp), as one string. */
export function issueViewText(forge: Forge, repo: Repo, issue: Issue): string {
  const parts = issueViewParts(forge, repo, issue);
  return `${parts.head}${tsNow()}${parts.tail}`;
}

/** The issue's full GET body as bytes, cached for the current wall-clock second. */
export function issueBodyBytes(forge: Forge, repo: Repo, issue: Issue): Buffer {
  const sec = Math.floor(Date.now() / 1000);
  if (issue.cachedBody !== null && issue.cachedBodySec === sec) return issue.cachedBody;
  const parts = issueViewParts(forge, repo, issue);
  const body = Buffer.from(`${parts.head}${tsNow()}${parts.tail}`, 'utf8');
  issue.cachedBody = body;
  issue.cachedBodySec = sec;
  return body;
}

/** The issue view as an object (for GraphQL / MCP surfaces that reshape it). */
export function issueViewObject(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  const owner = repo.owner ?? forge.viewer();
  return {
    id: issue.id,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    user: { login: owner, id: 1000, type: 'User' },
    html_url: `https://github.com/${owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: tsNow(),
  };
}

/** Invalidate an issue's cached view after any mutation. */
export function invalidateIssue(issue: Issue): void {
  issue.cachedHead = null;
  issue.cachedTail = null;
  issue.cachedHeadBytes = 0;
  issue.cachedTailBytes = 0;
  issue.cachedBody = null;
  issue.cachedBodySec = -1;
}

/** A fresh issue record, with its response cache empty and its node id fixed. */
export function newIssue(id: number, number: number, title: string, body: string, labels: Label[], seq: number, repoId = 0): Issue {
  return {
    id,
    number,
    title,
    body,
    state: 'open',
    labels,
    comments: [],
    seq,
    nodeId: globalId('Issue', repoId, number),
    cachedHead: null,
    cachedTail: null,
    cachedHeadBytes: 0,
    cachedTailBytes: 0,
    cachedBody: null,
    cachedBodySec: -1,
  };
}

/** Every object reachable from `roots` (commit -> tree + parents, tree -> entries, tag -> target). */
export function collectReachable(roots: Iterable<string>, lookup: (oid: string) => GitObject | undefined, repo: Repo): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isSha40(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const meta = repo.commitMeta.get(oid);
      if (meta) {
        queue.push(meta.tree);
        for (const parent of meta.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of repo.treeMeta.get(oid) ?? parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/**
 * A commit's generation: 0 for a root, else max(parent generations) + 1.
 * `fresh` holds the commits stored by the current call — only those are
 * recomputed; a parent stored by an earlier call already carries a correct
 * generation and is trusted without descending into it, which keeps a
 * single-commit push O(1) instead of O(history). Memoized, cycle-guarded.
 */
function generationOf(repo: Repo, oid: string, fresh: Set<string>, memo: Map<string, number>, visiting: Set<string>): number {
  const cached = memo.get(oid);
  if (cached !== undefined) return cached;
  const meta = repo.commitMeta.get(oid);
  if (!meta) return 0;
  if (!fresh.has(oid)) return meta.generation;
  if (visiting.has(oid)) return 0;
  visiting.add(oid);
  let generation = 0;
  for (const parent of meta.parents) {
    const parentGen = generationOf(repo, parent, fresh, memo, visiting);
    if (parentGen + 1 > generation) generation = parentGen + 1;
  }
  visiting.delete(oid);
  memo.set(oid, generation);
  return generation;
}

/**
 * True when `ancestor` is reachable from `descendant` (or they are equal). The generation
 * numbers bound the walk: it descends only while a commit's generation is above the
 * ancestor's, so a linear fast-forward check is one parent step, not the whole history.
 */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const ancestorMeta = repo.commitMeta.get(ancestor);
  const ancestorGen = ancestorMeta?.generation ?? 0;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const meta = repo.commitMeta.get(oid);
    if (!meta) continue;
    if (meta.generation <= ancestorGen) continue;
    for (const parent of meta.parents) stack.push(parent);
  }
  return false;
}
