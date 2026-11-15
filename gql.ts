// GraphQL v4: a small tokenizer, parser and executor for the documents the suite
// sends (the ones gh and github-mcp-server send). No general GraphQL engine is
// needed — or wanted — here: the executor resolves exactly the schema the
// suite introspects, with the same field sets and error texts.
//
// v3: the issue's node id is read from the record (computed once at creation)
// instead of being base64-encoded on every field resolution, and the empty
// tree constant comes from the store instead of a literal.

import type { Ctx } from './ctx.ts';
import { requireAuth, sendError, sendJson } from './ctx.ts';
import {
  EMPTY_TREE_OID,
  asString,
  b64urlDecode,
  b64urlEncode,
  globalId,
  invalidateIssue,
  isRecord,
  newIssue,
  tsNow,
  type Forge,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

export interface GqlField {
  alias: string;
  name: string;
  args: Record<string, unknown>;
  children: GqlField[];
  fragmentType: string | null;
}

export interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  fields: GqlField[];
}

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: string };

function tokenizeGql(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():[]!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if ((ch >= '0' && ch <= '9') || ch === '-') {
      let num = '';
      while (i < source.length && ((source[i]! >= '0' && source[i]! <= '9') || source[i] === '.')) {
        num += source[i];
        i += 1;
      }
      tokens.push({ kind: 'int', value: Number(num) });
      continue;
    }
    if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_') {
      let name = '';
      while (i < source.length) {
        const c = source[i]!;
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_') {
          name += c;
          i += 1;
        } else break;
      }
      tokens.push({ kind: 'name', value: name });
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class GqlParser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected '${value}' in GraphQL document`);
  }

  private skipVariableDefinitions(): void {
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      let depth = 0;
      for (;;) {
        const token = this.next();
        if (token.kind === 'punct' && token.value === '(') depth += 1;
        if (token.kind === 'punct' && token.value === ')') {
          depth -= 1;
          if (depth === 0) return;
        }
      }
    }
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.next();
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const kind = token.value as 'query' | 'mutation';
        let name: string | null = null;
        const next = this.peek();
        if (next?.kind === 'name') {
          name = (this.next() as { value: string }).value;
        }
        this.skipVariableDefinitions();
        const fields = this.parseSelectionSet();
        operations.push({ kind, name, fields });
      } else if (token.kind === 'punct' && token.value === '{') {
        this.pos -= 1;
        operations.push({ kind: 'query', name: null, fields: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        // Named fragments are not used by the suite's documents; skip the definition.
        while (this.pos < this.tokens.length) {
          const t = this.next();
          if (t.kind === 'punct' && t.value === '{') {
            this.pos -= 1;
            this.parseSelectionSet();
            break;
          }
        }
      } else {
        throw new Error(`unexpected token ${JSON.stringify(token)} in GraphQL document`);
      }
    }
    return operations;
  }

  private parseSelectionSet(): GqlField[] {
    this.expectPunct('{');
    const fields: GqlField[] = [];
    for (;;) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '}') return fields;
      if (token.kind === 'spread') {
        const next = this.next();
        if (next.kind === 'name' && next.value === 'on') {
          const typeToken = this.next();
          const fragmentType = typeToken.kind === 'name' ? typeToken.value : '';
          const children = this.parseSelectionSet();
          for (const child of children) fields.push({ ...child, fragmentType });
        }
        // A named fragment spread: the suite never sends one; ignore.
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected a field name in GraphQL document');
      let alias = token.value;
      let name = token.value;
      const maybeColon = this.peek();
      if (maybeColon?.kind === 'punct' && (maybeColon as { value: string }).value === ':') {
        this.next();
        const nameToken = this.next();
        if (nameToken.kind !== 'name') throw new Error('expected a field name after an alias');
        name = nameToken.value;
      }
      const args = this.parseArguments();
      let children: GqlField[] = [];
      const maybeBrace = this.peek();
      if (maybeBrace?.kind === 'punct' && (maybeBrace as { value: string }).value === '{') {
        children = this.parseSelectionSet();
      }
      fields.push({ alias, name, args, children, fragmentType: null });
    }
  }

  private parseArguments(): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    const peek = this.peek();
    if (!(peek?.kind === 'punct' && (peek as { value: string }).value === '(')) return args;
    this.next();
    for (;;) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === ')') return args;
      if (token.kind !== 'name') throw new Error('expected an argument name');
      const name = token.value;
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
  }

  private parseValue(): unknown {
    const token = this.next();
    if (token.kind === 'string' || token.kind === 'int') return token.value;
    if (token.kind === 'punct' && token.value === '$') {
      const nameToken = this.next();
      return { __variable: (nameToken as { value: string }).value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: unknown[] = [];
      for (;;) {
        const peek = this.peek();
        if (peek?.kind === 'punct' && (peek as { value: string }).value === ']') {
          this.next();
          return items;
        }
        items.push(this.parseValue());
      }
    }
    if (token.kind === 'punct' && token.value === '{') {
      const object: Record<string, unknown> = {};
      for (;;) {
        const peek = this.next();
        if (peek.kind === 'punct' && peek.value === '}') return object;
        if (peek.kind !== 'name') throw new Error('expected an input object field');
        this.expectPunct(':');
        object[peek.value] = this.parseValue();
      }
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { __enum: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

// -------------------------------------------------------------------------------------------
// schema surface + executor
// -------------------------------------------------------------------------------------------

function resolveVariables(value: unknown, variables: Record<string, unknown>): unknown {
  if (isRecord(value) && '__variable' in value) return variables[value.__variable as string];
  if (isRecord(value) && '__enum' in value) return value.__enum;
  if (Array.isArray(value)) return value.map((v) => resolveVariables(v, variables));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveVariables(v, variables);
    return out;
  }
  return value;
}

function resolveArgs(field: GqlField, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(field.args)) out[k] = resolveVariables(v, variables);
  return out;
}

// The schema surface the suite introspects: field names per type, enum values per enum.
const GQL_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  User: ['login', 'id'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFile: ['path'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  Ref: ['name'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};
const GQL_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'DISCUSSION', 'COMMIT', 'WIKI'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

interface GqlExec {
  forge: Forge;
  errors: Array<{ message: string }>;
}

function gqlFieldError(exec: GqlExec, typeName: string, field: string): void {
  exec.errors.push({ message: `Cannot query field "${field}" on type "${typeName}".` });
}

function executeFields(exec: GqlExec, typeName: string, value: unknown, fields: GqlField[], variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.fragmentType !== null && field.fragmentType !== typeName) continue;
    const resolved = resolveField(exec, typeName, value, field, variables);
    if (resolved !== undefined) out[field.alias] = resolved;
  }
  return out;
}

function resolveField(exec: GqlExec, typeName: string, value: unknown, field: GqlField, variables: Record<string, unknown>): unknown {
  const allowed = GQL_FIELDS[typeName];
  if (allowed && !allowed.includes(field.name)) {
    gqlFieldError(exec, typeName, field.name);
    return undefined;
  }
  const args = resolveArgs(field, variables);
  const forge = exec.forge;
  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') {
        return executeFields(exec, 'User', null, field.children, variables);
      }
      if (field.name === 'repository') {
        const owner = asString(args.owner);
        const repoName = asString(args.name);
        const repo = forge.repo(owner, repoName);
        if (!repo) return null;
        return executeFields(exec, 'Repository', repo, field.children, variables);
      }
      if (field.name === 'node') {
        const id = asString(args.id);
        const decoded = b64urlDecode(id);
        if (decoded === null) return null;
        const match = /^Repository:(\d+)$/.exec(decoded);
        if (!match) return null;
        const repo = [...forge.repos.values()].find((r) => r.id === Number(match[1]));
        if (!repo) return null;
        return executeFields(exec, 'Repository', repo, field.children, variables);
      }
      if (field.name === '__type') {
        const name = asString(args.name);
        return executeFields(exec, '__Type', name, field.children, variables);
      }
      return null;
    }
    case 'User': {
      if (field.name === 'login') return forge.viewer();
      if (field.name === 'id') return globalId('User', forge.viewer());
      return null;
    }
    case 'Repository': {
      const repo = value as Repo;
      switch (field.name) {
        case 'id': return globalId('Repository', repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner ?? forge.viewer()}/${repo.name}`;
        case 'owner': return executeFields(exec, 'User', repo, field.children, variables);
        case 'defaultBranchRef': return executeFields(exec, 'Ref', { name: repo.defaultBranch }, field.children, variables);
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          if (!issue) return null;
          return executeFields(exec, 'Issue', { repo, issue }, field.children, variables);
        }
        case 'issues': return issuesConnection(exec, repo, args, field, variables);
        case 'pullRequests': {
          const first = args.first === undefined ? undefined : Number(args.first);
          let list = [...repo.pulls.values()].sort((a, b) => b.seq - a.seq);
          if (first !== undefined) list = list.slice(0, first);
          return executeFields(exec, 'PullRequestConnection', list.map((p) => ({ repo, pull: p })), field.children, variables);
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          if (!pull) return null;
          return executeFields(exec, 'PullRequest', { repo, pull }, field.children, variables);
        }
        default: return null;
      }
    }
    case 'Issue': {
      const { repo, issue } = value as { repo: Repo; issue: Issue };
      void repo;
      switch (field.name) {
        case 'id': return issue.nodeId;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issue.state.toUpperCase();
        case 'body': return issue.body;
        case 'labels': return issue.labels.map((l) => ({ name: l.name }));
        case 'comments': return issue.comments.map((c) => ({ body: c.body }));
        default: return null;
      }
    }
    case 'PullRequest': {
      const { repo, pull } = value as { repo: Repo; pull: Pull };
      switch (field.name) {
        case 'id': return globalId('PullRequest', repo.id, pull.number);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'headRefName': return pull.head;
        case 'baseRefName': return pull.base;
        case 'mergeable': return forge.mergeable(repo, pull);
        case 'files': {
          const headTip = forge.branchTip(repo, pull.head);
          const baseTip = forge.branchTip(repo, pull.base);
          if (headTip === null || baseTip === null) return executeFields(exec, 'PullRequestChangedFileConnection', [], field.children, variables);
          const headTree = forge.commitMetaOf(repo, headTip)?.tree ?? EMPTY_TREE_OID;
          const baseTree = forge.commitMetaOf(repo, baseTip)?.tree ?? EMPTY_TREE_OID;
          const files = forge.diffTrees(repo, baseTree, headTree);
          const first = args.first === undefined ? undefined : Number(args.first);
          const nodes = (first === undefined ? files : files.slice(0, first)).map((f) => ({ path: f.filename }));
          return executeFields(exec, 'PullRequestChangedFileConnection', nodes, field.children, variables);
        }
        default: return null;
      }
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      const nodes = value as unknown[];
      if (field.name === 'nodes') {
        const itemType = typeName === 'IssueConnection' ? 'Issue' : typeName === 'PullRequestConnection' ? 'PullRequest' : 'PullRequestChangedFile';
        return nodes.map((node) => executeFields(exec, itemType, node, field.children, variables));
      }
      if (field.name === 'pageInfo') return executeFields(exec, 'PageInfo', value, field.children, variables);
      if (field.name === 'totalCount') return nodes.length;
      return null;
    }
    case 'PullRequestChangedFile': {
      const node = value as { path: string };
      if (field.name === 'path') return node.path;
      return null;
    }
    case 'PageInfo': {
      const page = value as { hasNextPage?: boolean; endCursor?: string | null };
      if (field.name === 'hasNextPage') return page.hasNextPage ?? false;
      if (field.name === 'endCursor') return page.endCursor ?? null;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'startCursor') return null;
      return null;
    }
    case 'Ref': {
      const ref = value as { name: string };
      if (field.name === 'name') return ref.name;
      return null;
    }
    case 'Mutation': {
      return executeMutation(exec, field, variables);
    }
    case '__Type': {
      const name = value as string;
      if (field.name === 'name') return name;
      if (field.name === 'kind') return GQL_ENUMS[name] ? 'ENUM' : 'OBJECT';
      if (field.name === 'fields') {
        const names = GQL_FIELDS[name] ?? [];
        return names.map((n) => executeFields(exec, '__Field', n, field.children, variables));
      }
      if (field.name === 'enumValues') {
        const names = GQL_ENUMS[name] ?? [];
        return names.map((n) => executeFields(exec, '__EnumValue', n, field.children, variables));
      }
      return null;
    }
    case '__Field':
    case '__EnumValue': {
      if (field.name === 'name') return value as string;
      return null;
    }
    default:
      return null;
  }
}

function issuesConnection(exec: GqlExec, repo: Repo, args: Record<string, unknown>, field: GqlField, variables: Record<string, unknown>): Record<string, unknown> {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  const first = args.first === undefined ? undefined : Number(args.first);
  const after = args.after === undefined || args.after === null ? null : asString(args.after);
  let list = [...repo.issues.values()];
  if (states !== null) {
    const wanted = new Set(states.map((s) => s.toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  const direction = orderBy && asString(orderBy.direction) === 'ASC' ? 1 : -1;
  list.sort((a, b) => direction * (a.seq - b.seq));
  let startIndex = 0;
  if (after !== null) {
    const decoded = b64urlDecode(after);
    const match = decoded === null ? null : /^cursor:(\d+)$/.exec(decoded);
    if (match) {
      const afterNumber = Number(match[1]);
      const index = list.findIndex((i) => i.number === afterNumber);
      if (index >= 0) startIndex = index + 1;
    }
  }
  const sliced = first === undefined ? list.slice(startIndex) : list.slice(startIndex, startIndex + first);
  const hasNextPage = startIndex + sliced.length < list.length;
  const endCursor = sliced.length === 0 ? null : b64urlEncode(`cursor:${sliced[sliced.length - 1]!.number}`);
  const connection = { nodes: sliced.map((i) => ({ repo, issue: i })), hasNextPage, endCursor };
  const out: Record<string, unknown> = {};
  for (const child of field.children) {
    if (child.name === 'nodes') {
      out[child.alias] = connection.nodes.map((node) => executeFields(exec, 'Issue', node, child.children, variables));
    } else if (child.name === 'pageInfo') {
      out[child.alias] = executeFields(exec, 'PageInfo', connection, child.children, variables);
    } else if (child.name === 'totalCount') {
      out[child.alias] = list.length;
    }
  }
  return out;
}

function findRepoByGlobalId(forge: Forge, id: string): Repo | null {
  const decoded = b64urlDecode(id);
  if (decoded === null) return null;
  const match = /^Repository:(\d+)$/.exec(decoded);
  if (!match) return null;
  return [...forge.repos.values()].find((r) => r.id === Number(match[1])) ?? null;
}

function findIssueByGlobalId(forge: Forge, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = b64urlDecode(id);
  if (decoded === null) return null;
  const match = /^Issue:(\d+):(\d+)$/.exec(decoded);
  if (!match) return null;
  const repo = [...forge.repos.values()].find((r) => r.id === Number(match[1]));
  if (!repo) return null;
  const issue = repo.issues.get(Number(match[2]));
  return issue ? { repo, issue } : null;
}

function findPullByGlobalId(forge: Forge, id: string): { repo: Repo; pull: Pull } | null {
  const decoded = b64urlDecode(id);
  if (decoded === null) return null;
  const match = /^PullRequest:(\d+):(\d+)$/.exec(decoded);
  if (!match) return null;
  const repo = [...forge.repos.values()].find((r) => r.id === Number(match[1]));
  if (!repo) return null;
  const pull = repo.pulls.get(Number(match[2]));
  return pull ? { repo, pull } : null;
}

// -------------------------------------------------------------------------------------------
// mutations + entry point
// -------------------------------------------------------------------------------------------

function executeMutation(exec: GqlExec, field: GqlField, variables: Record<string, unknown>): unknown {
  const forge = exec.forge;
  const args = resolveArgs(field, variables);
  const input = isRecord(args.input) ? args.input : {};
  switch (field.name) {
    case 'createIssue': {
      const repo = findRepoByGlobalId(forge, asString(input.repositoryId));
      if (!repo) {
        exec.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
        return null;
      }
      const number = repo.nextNumber++;
      const issue = newIssue(forge.nextObjectId++, number, asString(input.title), asString(input.body), [], ++forge.seq, repo.id);
      repo.issues.set(number, issue);
      const out: Record<string, unknown> = {};
      for (const child of field.children) {
        if (child.name === 'issue') out[child.alias] = executeFields(exec, 'Issue', { repo, issue }, child.children, variables);
      }
      return out;
    }
    case 'closeIssue': {
      const found = findIssueByGlobalId(forge, asString(input.issueId));
      if (!found) {
        exec.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
        return null;
      }
      found.issue.state = 'closed';
      invalidateIssue(found.issue);
      const out: Record<string, unknown> = {};
      for (const child of field.children) {
        if (child.name === 'issue') out[child.alias] = executeFields(exec, 'Issue', found, child.children, variables);
      }
      return out;
    }
    case 'createPullRequest': {
      const repo = findRepoByGlobalId(forge, asString(input.repositoryId));
      if (!repo) {
        exec.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
        return null;
      }
      const head = asString(input.headRefName);
      const base = asString(input.baseRefName);
      const headSha = forge.branchTip(repo, head);
      const baseSha = forge.branchTip(repo, base);
      if (headSha === null || baseSha === null) {
        exec.errors.push({ message: 'Head or base branch does not exist.' });
        return null;
      }
      const number = repo.nextNumber++;
      const pull: Pull = {
        id: forge.nextObjectId++,
        number,
        title: asString(input.title),
        body: '',
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
      const out: Record<string, unknown> = {};
      for (const child of field.children) {
        if (child.name === 'pullRequest') out[child.alias] = executeFields(exec, 'PullRequest', { repo, pull }, child.children, variables);
      }
      return out;
    }
    case 'mergePullRequest': {
      const found = findPullByGlobalId(forge, asString(input.pullRequestId));
      if (!found) {
        exec.errors.push({ message: 'Could not resolve to a PullRequest with the global id.' });
        return null;
      }
      const { repo, pull } = found;
      const headTip = forge.branchTip(repo, pull.head);
      const baseTip = forge.branchTip(repo, pull.base);
      if (headTip === null || baseTip === null) {
        exec.errors.push({ message: 'Head or base branch does not exist.' });
        return null;
      }
      if (pull.merged || pull.state !== 'open' || forge.wouldConflict(repo, baseTip, headTip)) {
        exec.errors.push({ message: 'Pull request cannot be merged.' });
        return null;
      }
      const headTree = forge.commitMetaOf(repo, headTip)?.tree ?? EMPTY_TREE_OID;
      const mergeSha = forge.makeCommit(repo, headTree, [baseTip], `Merge pull request #${pull.number} from ${pull.head}`);
      repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
      forge.touch(repo);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = tsNow();
      pull.mergeCommitSha = mergeSha;
      pull.baseSha = mergeSha;
      const out: Record<string, unknown> = {};
      for (const child of field.children) {
        if (child.name === 'pullRequest') out[child.alias] = executeFields(exec, 'PullRequest', { repo, pull }, child.children, variables);
      }
      return out;
    }
    case 'addComment': {
      const found = findIssueByGlobalId(forge, asString(input.subjectId));
      if (!found) {
        exec.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
        return null;
      }
      const comment = { id: found.repo.nextCommentId++, body: asString(input.body), seq: ++forge.seq };
      found.issue.comments.push(comment);
      const out: Record<string, unknown> = {};
      for (const child of field.children) {
        if (child.name === 'commentEdge') {
          const node: Record<string, unknown> = {};
          for (const edgeChild of child.children) {
            if (edgeChild.name === 'node') {
              const nodeOut: Record<string, unknown> = {};
              for (const nodeChild of edgeChild.children) {
                if (nodeChild.name === 'id') nodeOut[nodeChild.alias] = globalId('Comment', found.repo.id, found.issue.number, comment.id);
                else if (nodeChild.name === 'body') nodeOut[nodeChild.alias] = comment.body;
              }
              node[edgeChild.alias] = nodeOut;
            }
          }
          out[child.alias] = node;
        }
      }
      return out;
    }
    default:
      exec.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
      return null;
  }
}

function executeGraphQLOperation(forge: Forge, operation: unknown): Record<string, unknown> {
  const exec: GqlExec = { forge, errors: [] };
  if (!isRecord(operation) || typeof operation.query !== 'string') {
    return { data: null, errors: [{ message: 'A query document is required.' }] };
  }
  const variables = isRecord(operation.variables) ? (operation.variables as Record<string, unknown>) : {};
  let parsed: GqlOperation[];
  try {
    parsed = new GqlParser(tokenizeGql(operation.query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Failed to parse the query document.' }] };
  }
  let chosen = parsed[0];
  if (typeof operation.operationName === 'string' && operation.operationName !== '') {
    const named = parsed.find((op) => op.name === operation.operationName);
    if (named) chosen = named;
  }
  if (!chosen) return { data: null, errors: [{ message: 'No operation found in the document.' }] };
  const typeName = chosen.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeFields(exec, typeName, null, chosen.fields, variables);
  if (exec.errors.length > 0) return { data, errors: exec.errors };
  return { data };
}

export function handleGraphQL(ctx: Ctx): boolean {
  const forge = ctx.forge;
  if (!requireAuth(ctx)) return true;
  let body: unknown;
  try {
    body = JSON.parse(ctx.body.toString('utf8')) as unknown;
  } catch {
    sendError(ctx, 400, 'Problems parsing JSON');
    return true;
  }
  const operations = Array.isArray(body) ? body : [body];
  const answers: unknown[] = [];
  for (const operation of operations) {
    answers.push(executeGraphQLOperation(forge, operation));
  }
  sendJson(ctx, 200, Array.isArray(body) ? answers : answers[0]);
  return true;
}
