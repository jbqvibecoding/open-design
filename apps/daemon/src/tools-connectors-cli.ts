import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type JsonObject = Record<string, unknown>;

interface CliError {
  code?: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
  requestId?: string;
}

interface ToolCliResult {
  exitCode: number;
}

interface ParsedOptions {
  command: string | undefined;
  connectorId?: string;
  toolName?: string;
  inputPath?: string;
  repo?: string;
  ref?: string;
  outputPath?: string;
  maxFiles?: number;
  requireConnector?: boolean;
  useCase?: 'personal_daily_digest';
  format: 'compact' | 'json';
  help: boolean;
}

const CONNECTORS_USAGE = `Usage:
  od tools connectors list [--use-case personal_daily_digest] [--format compact]
  od tools connectors execute --connector <id> --tool <name> --input input.json
  od tools connectors github-design-context --repo owner/repo [--ref main] [--output context/github/owner-repo.md] [--max-files 24] [--require-connector]

Environment:
  OD_NODE_BIN     Node-compatible runtime for agent wrapper invocations
  OD_BIN          Open Design CLI script for agent wrapper invocations
  OD_DAEMON_URL   Daemon base URL injected into agent runs
  OD_TOOL_TOKEN   Bearer token injected into agent runs

Agent runtime invocation:
  "$OD_NODE_BIN" "$OD_BIN" tools connectors list --use-case personal_daily_digest --format compact
`;

const GITHUB_CONNECTOR_ID = 'github';
const GITHUB_GET_REPOSITORY_TOOL = 'github.github_get_a_repository';
const GITHUB_GET_TREE_TOOL = 'github.github_get_a_tree';
const GITHUB_GET_README_TOOL = 'github.github_get_a_repository_readme';
const GITHUB_GET_RAW_CONTENT_TOOL = 'github.github_get_raw_repository_content';
const GITHUB_GET_REPOSITORY_CONTENT_TOOL = 'github.github_get_repository_content';

const DEFAULT_GITHUB_CONTEXT_MAX_FILES = 24;
const MAX_GITHUB_CONTEXT_FILES = 80;
const MAX_CONTEXT_FILE_BYTES = 120_000;
const MAX_MARKDOWN_EXCERPT_CHARS = 2_400;
const MAX_CONNECTOR_DIRECTORY_SCAN_DIRS = 48;

interface ParsedGitHubRepo {
  owner: string;
  repo: string;
  source: string;
}

interface GithubSnapshotFile {
  repoPath: string;
  outputPath?: string;
  content: string;
  bytes: number;
  source: 'connector' | 'git-clone';
}

interface GithubDesignEvidence {
  repo: ParsedGitHubRepo;
  ref?: string;
  resolvedRef?: string;
  method: 'connector' | 'git-clone-fallback';
  repositoryMetadata?: JsonObject;
  readme?: { path: string; content: string };
  treePaths: string[];
  files: GithubSnapshotFile[];
  warnings: string[];
}

function writeJson(value: unknown, stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function fail(message: string, details?: unknown): ToolCliResult {
  writeJson({ ok: false, error: { message, ...(details === undefined ? {} : { details }) } }, process.stderr);
  return { exitCode: 1 };
}

function parseOptions(args: string[]): ParsedOptions | { error: string } {
  const [command, ...rest] = args;
  const options: ParsedOptions = {
    command: command === '-h' || command === '--help' ? undefined : command,
    format: 'compact',
    help: command === '-h' || command === '--help',
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--connector') {
      const value = rest[++index];
      if (!value) return { error: '--connector requires a connector id' };
      options.connectorId = value;
    } else if (arg === '--tool') {
      const value = rest[++index];
      if (!value) return { error: '--tool requires a tool name' };
      options.toolName = value;
    } else if (arg === '--input') {
      const value = rest[++index];
      if (!value) return { error: '--input requires a file path' };
      options.inputPath = value;
    } else if (arg === '--repo') {
      const value = rest[++index];
      if (!value) return { error: '--repo requires owner/repo or a GitHub repository URL' };
      options.repo = value;
    } else if (arg === '--ref') {
      const value = rest[++index];
      if (!value) return { error: '--ref requires a branch, tag, or commit' };
      options.ref = value;
    } else if (arg === '--output') {
      const value = rest[++index];
      if (!value) return { error: '--output requires a file path' };
      options.outputPath = value;
    } else if (arg === '--max-files') {
      const value = rest[++index];
      const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 1) return { error: '--max-files must be a positive integer' };
      options.maxFiles = Math.min(parsed, MAX_GITHUB_CONTEXT_FILES);
    } else if (arg === '--require-connector') {
      options.requireConnector = true;
    } else if (arg === '--format') {
      const value = rest[++index];
      if (value !== 'compact' && value !== 'json') return { error: '--format must be compact or json' };
      options.format = value;
    } else if (arg === '--use-case') {
      const value = rest[++index];
      if (value !== 'personal_daily_digest') return { error: '--use-case must be personal_daily_digest' };
      options.useCase = value;
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else {
      return { error: `unknown option: ${arg}` };
    }
  }

  return options;
}

function daemonUrl(): URL | { error: string } {
  const rawUrl = process.env.OD_DAEMON_URL;
  if (!rawUrl) return { error: 'OD_DAEMON_URL is required' };
  try {
    const url = new URL(rawUrl);
    url.pathname = url.pathname.replace(/\/+$/u, '');
    url.search = '';
    url.hash = '';
    return url;
  } catch {
    return { error: 'OD_DAEMON_URL must be a valid URL' };
  }
}

function toolToken(): string | { error: string } {
  const token = process.env.OD_TOOL_TOKEN;
  if (!token) return { error: 'OD_TOOL_TOKEN is required' };
  return token;
}

function endpoint(baseUrl: URL, pathname: string): string {
  const url = new URL(baseUrl.toString());
  const [pathPart, searchPart] = pathname.split('?');
  url.pathname = `${url.pathname}${pathPart ?? ''}`.replace(/\/+/gu, '/');
  url.search = searchPart === undefined ? '' : `?${searchPart}`;
  return url.toString();
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const resolved = path.resolve(filePath);
  const text = await readFile(resolved, 'utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON in ${resolved}: ${message}`);
  }
}

async function readJsonObject(filePath: string): Promise<JsonObject> {
  const value = await readJsonFile(filePath);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path.resolve(filePath)} must contain a JSON object`);
  }
  return value as JsonObject;
}

function parseGithubRepo(input: string): ParsedGitHubRepo {
  const raw = input.trim();
  const sshMatch = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/iu.exec(raw);
  if (sshMatch?.[1] && sshMatch[2]) {
    return { owner: sshMatch[1], repo: stripGitSuffix(sshMatch[2]), source: raw };
  }

  if (/^https?:\/\//iu.test(raw)) {
    const url = new URL(raw);
    if (url.hostname.toLowerCase() !== 'github.com') {
      throw new Error('--repo must point to github.com');
    }
    const [owner, repo] = url.pathname.replace(/^\/+|\/+$/gu, '').split('/');
    if (!owner || !repo) throw new Error('--repo URL must include owner and repository');
    return { owner, repo: stripGitSuffix(repo), source: raw };
  }

  const [owner, repo] = raw.replace(/^\/+|\/+$/gu, '').split('/');
  if (!owner || !repo) {
    throw new Error('--repo must be owner/repo or a GitHub repository URL');
  }
  return { owner, repo: stripGitSuffix(repo), source: raw };
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/iu, '');
}

function repoSlug(repo: ParsedGitHubRepo): string {
  return `${safePathSegment(repo.owner)}-${safePathSegment(repo.repo)}`;
}

function safePathSegment(value: string): string {
  const normalized = value.trim().replace(/[^a-z0-9._-]+/giu, '-').replace(/^-+|-+$/gu, '');
  return normalized || 'repo';
}

function safeRepoRelativePath(repoPath: string): string {
  return repoPath
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .map(safePathSegment)
    .join('/');
}

function defaultGithubContextOutputPath(repo: ParsedGitHubRepo): string {
  return path.join('context', 'github', `${repoSlug(repo)}.md`);
}

function githubSnapshotRoot(outputPath: string, repo: ParsedGitHubRepo): string {
  const dir = path.dirname(outputPath);
  return path.join(dir, repoSlug(repo), 'files');
}

async function ensureParentDirectory(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
}

async function requestJsonOrThrow(baseUrl: URL, token: string, pathname: string, init: RequestInit = {}): Promise<unknown> {
  const response = await requestJson(baseUrl, token, pathname, init);
  if (response.status >= 200 && response.status < 300) return response.body;
  const error = normalizeCliError(response.body);
  throw new Error(`${error.code ? `${error.code}: ` : ''}${error.message}`);
}

async function executeConnectorReadTool(
  baseUrl: URL,
  token: string,
  toolName: string,
  input: JsonObject,
): Promise<unknown> {
  const body = await requestJsonOrThrow(baseUrl, token, '/api/tools/connectors/execute', {
    method: 'POST',
    body: JSON.stringify({ connectorId: GITHUB_CONNECTOR_ID, toolName, input }),
  });
  if (!body || typeof body !== 'object') return body;
  const output = (body as JsonObject).output;
  if (output && typeof output === 'object' && !Array.isArray(output) && 'data' in output) {
    return (output as JsonObject).data;
  }
  return output;
}

async function assertGithubConnectorIsListable(baseUrl: URL, token: string): Promise<void> {
  const body = await requestJsonOrThrow(baseUrl, token, '/api/tools/connectors/list', { method: 'GET' });
  const connectors = body && typeof body === 'object' && Array.isArray((body as JsonObject).connectors)
    ? (body as { connectors: JsonObject[] }).connectors
    : [];
  const github = connectors.find((connector) => connector.id === GITHUB_CONNECTOR_ID);
  if (!github) throw new Error('GitHub connector is not connected or has no auto-approved read tools');
  const status = typeof github.status === 'string' ? github.status.toLowerCase() : '';
  if (status && status !== 'connected') {
    throw new Error(`GitHub connector status is ${status}; connect GitHub before repository intake`);
  }
}

function getStringAtKeys(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as JsonObject;
  for (const key of keys) {
    const direct = record[key];
    if (typeof direct === 'string' && direct.trim()) return direct;
  }
  for (const child of Object.values(record)) {
    const found = getStringAtKeys(child, keys);
    if (found) return found;
  }
  return undefined;
}

function getDefaultBranch(metadata: unknown): string | undefined {
  return getStringAtKeys(metadata, ['default_branch', 'defaultBranch']);
}

function decodeContentPayload(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  const record = value as JsonObject;
  const content = typeof record.content === 'string'
    ? record.content
    : typeof record.data === 'string'
      ? record.data
      : undefined;
  if (content !== undefined) {
    const encoding = typeof record.encoding === 'string' ? record.encoding.toLowerCase() : '';
    if (encoding === 'base64') return decodeBase64Content(content);
    return content;
  }
  for (const [key, child] of Object.entries(record)) {
    if (key === 'mimetype' || key === 'name' || key === 's3url') continue;
    const decoded = decodeContentPayload(child);
    if (decoded !== undefined) return decoded;
  }
  return undefined;
}

function decodeBase64Content(value: string): string {
  return Buffer.from(value.replace(/\s+/gu, ''), 'base64').toString('utf8');
}

function findConnectorSignedContentUrl(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findConnectorSignedContentUrl(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as JsonObject;
  if (typeof record.s3url === 'string' && /^https:\/\//iu.test(record.s3url)) return record.s3url;
  for (const child of Object.values(record)) {
    const found = findConnectorSignedContentUrl(child);
    if (found) return found;
  }
  return undefined;
}

async function readConnectorTextContent(value: unknown): Promise<string | undefined> {
  const decoded = decodeContentPayload(value);
  if (decoded !== undefined) return decoded;
  const signedUrl = findConnectorSignedContentUrl(value);
  if (!signedUrl) return undefined;
  const response = await fetch(signedUrl);
  if (!response.ok) {
    throw new Error(`connector content download failed with HTTP ${response.status}`);
  }
  const text = await response.text();
  return text.slice(0, MAX_CONTEXT_FILE_BYTES);
}

function extractTreePaths(value: unknown): string[] {
  const paths = new Set<string>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as JsonObject;
    const rawPath = typeof record.path === 'string' ? record.path : undefined;
    const rawType = typeof record.type === 'string' ? record.type.toLowerCase() : '';
    if (rawPath && rawType !== 'tree' && rawType !== 'dir') {
      paths.add(rawPath);
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return [...paths].sort((left, right) => left.localeCompare(right));
}

interface GithubDirectoryEntry {
  path: string;
  type: 'file' | 'dir';
}

function extractDirectoryEntries(value: unknown): GithubDirectoryEntry[] {
  const entries = new Map<string, GithubDirectoryEntry>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as JsonObject;
    const rawPath = typeof record.path === 'string' ? record.path : undefined;
    const rawType = typeof record.type === 'string' ? record.type.toLowerCase() : '';
    if (rawPath && (rawType === 'file' || rawType === 'dir')) {
      entries.set(rawPath, { path: rawPath, type: rawType });
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return [...entries.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function scoreDesignFile(repoPath: string): number {
  const normalized = repoPath.toLowerCase();
  if (shouldSkipRepoPath(normalized)) return -1;
  let score = 0;
  if (/(^|\/)readme\.(md|mdx|txt|rst)$/u.test(normalized)) score += 100;
  if (/(^|\/)package\.json$/u.test(normalized)) score += 95;
  if (/(^|\/)(tailwind|theme|tokens?|colors?|typography|design-system|design)\.(config\.)?(ts|tsx|js|jsx|json|css|scss|less|md)$/u.test(normalized)) score += 90;
  if (/(^|\/)(globals?|index|style|styles|app)\.(css|scss|less)$/u.test(normalized)) score += 82;
  if (/\/(components?|ui|design-system|primitives?)\//u.test(normalized)) score += 65;
  if (/(button|card|dialog|modal|input|form|nav|sidebar|table|badge|avatar|toast|menu|tabs|layout|shell)\.(tsx|ts|jsx|js|css|scss)$/u.test(normalized)) score += 55;
  if (/(^|\/)(app|pages|src)\/(layout|page|app|index|main)\.(tsx|ts|jsx|js|css)$/u.test(normalized)) score += 45;
  if (/(^|\/)(logo|brand|icon)[^/]*\.svg$/u.test(normalized)) score += 40;
  if (/\.(css|scss|less|tsx|ts|jsx|js|md|mdx|json|svg)$/u.test(normalized)) score += 10;
  return score;
}

function scoreDesignDirectory(repoPath: string): number {
  const normalized = repoPath.toLowerCase();
  if (shouldSkipRepoPath(`${normalized}/`)) return -1;
  const segments = normalized.split('/');
  const basename = segments.at(-1) ?? normalized;
  let score = 0;
  if (/^(apps?|packages?|src|source|frontend|web|client|ui|components?|design-system|styles?|theme|themes|tokens?|assets?|public)$/u.test(basename)) {
    score += 80;
  }
  if (/(^|\/)(apps?|packages?)\//u.test(normalized)) score += 35;
  if (/(^|\/)(components?|ui|design-system|primitives?|styles?|theme|tokens?|assets?)$/u.test(normalized)) score += 45;
  if (segments.length <= 2) score += 10;
  if (segments.length > 5) score -= 20;
  return score;
}

function shouldSkipRepoPath(normalizedPath: string): boolean {
  return /(^|\/)(node_modules|vendor|dist|build|coverage|\.next|\.nuxt|\.git|out|target|storybook-static)\//u.test(normalizedPath)
    || /(^|\/)(package-lock\.json|pnpm-lock\.ya?ml|yarn\.lock|bun\.lockb)$/u.test(normalizedPath)
    || /\.(png|jpe?g|gif|webp|avif|mp4|mov|zip|tar|gz|woff2?|ttf|otf|pdf)$/u.test(normalizedPath);
}

function selectDesignFiles(paths: string[], maxFiles: number): string[] {
  return paths
    .map((repoPath) => ({ repoPath, score: scoreDesignFile(repoPath) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.repoPath.localeCompare(right.repoPath))
    .slice(0, maxFiles)
    .map((entry) => entry.repoPath);
}

async function collectGithubTreePathsWithConnector(
  baseUrl: URL,
  token: string,
  repo: ParsedGitHubRepo,
  resolvedRef: string,
  warnings: string[],
): Promise<string[]> {
  try {
    const treePayload = await executeConnectorReadTool(baseUrl, token, GITHUB_GET_TREE_TOOL, {
      owner: repo.owner,
      repo: repo.repo,
      tree_sha: resolvedRef,
      recursive: true,
    });
    return extractTreePaths(treePayload);
  } catch (error) {
    warnings.push(
      `Recursive tree connector read failed; falling back to bounded directory browsing: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return collectGithubTreePathsFromDirectoryListings(baseUrl, token, repo, resolvedRef, warnings);
  }
}

async function collectGithubTreePathsFromDirectoryListings(
  baseUrl: URL,
  token: string,
  repo: ParsedGitHubRepo,
  resolvedRef: string,
  warnings: string[],
): Promise<string[]> {
  const filePaths = new Set<string>();
  const seenDirs = new Set<string>();
  const queue: string[] = [''];

  while (queue.length > 0 && seenDirs.size < MAX_CONNECTOR_DIRECTORY_SCAN_DIRS) {
    const currentDir = queue.shift() ?? '';
    if (seenDirs.has(currentDir)) continue;
    seenDirs.add(currentDir);

    let entries: GithubDirectoryEntry[] = [];
    try {
      const payload = await executeConnectorReadTool(baseUrl, token, GITHUB_GET_REPOSITORY_CONTENT_TOOL, {
        owner: repo.owner,
        repo: repo.repo,
        ref: resolvedRef,
        path: currentDir,
      });
      entries = extractDirectoryEntries(payload);
    } catch (error) {
      if (currentDir) {
        warnings.push(`Skipped directory ${currentDir}: ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }

    for (const entry of entries) {
      if (entry.type === 'file') {
        if (!shouldSkipRepoPath(entry.path.toLowerCase())) filePaths.add(entry.path);
        continue;
      }
      if (entry.type === 'dir' && !seenDirs.has(entry.path) && scoreDesignDirectory(entry.path) > 0) {
        queue.push(entry.path);
      }
    }

    queue.sort((left, right) => scoreDesignDirectory(right) - scoreDesignDirectory(left) || left.localeCompare(right));
  }

  if (queue.length > 0) {
    warnings.push(`Directory browsing stopped after ${MAX_CONNECTOR_DIRECTORY_SCAN_DIRS} directories; evidence is a bounded connector snapshot.`);
  }
  return [...filePaths].sort((left, right) => left.localeCompare(right));
}

async function collectGithubEvidenceWithConnector(
  baseUrl: URL,
  token: string,
  repo: ParsedGitHubRepo,
  options: { ref?: string; maxFiles: number },
): Promise<GithubDesignEvidence> {
  await assertGithubConnectorIsListable(baseUrl, token);
  const warnings: string[] = [];
  const metadata = await executeConnectorReadTool(baseUrl, token, GITHUB_GET_REPOSITORY_TOOL, {
    owner: repo.owner,
    repo: repo.repo,
  });
  const resolvedRef = options.ref ?? getDefaultBranch(metadata) ?? 'main';

  let readme: GithubDesignEvidence['readme'];
  try {
    const readmePayload = await executeConnectorReadTool(baseUrl, token, GITHUB_GET_README_TOOL, {
      owner: repo.owner,
      repo: repo.repo,
      ref: resolvedRef,
    });
    const content = await readConnectorTextContent(readmePayload);
    if (content) {
      readme = {
        path: getStringAtKeys(readmePayload, ['path', 'name']) ?? 'README.md',
        content,
      };
    }
  } catch (error) {
    warnings.push(`README connector read failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const treePaths = await collectGithubTreePathsWithConnector(baseUrl, token, repo, resolvedRef, warnings);
  const selectedPaths = selectDesignFiles(treePaths, options.maxFiles);
  const files: GithubSnapshotFile[] = [];
  for (const repoPath of selectedPaths) {
    if (readme?.path === repoPath) continue;
    try {
      const contentPayload = await executeConnectorReadTool(baseUrl, token, GITHUB_GET_RAW_CONTENT_TOOL, {
        owner: repo.owner,
        repo: repo.repo,
        ref: resolvedRef,
        path: repoPath,
      });
      const content = await readConnectorTextContent(contentPayload);
      if (content === undefined) {
        warnings.push(`Skipped ${repoPath}: connector returned no readable text content`);
        continue;
      }
      files.push({
        repoPath,
        content: content.slice(0, MAX_CONTEXT_FILE_BYTES),
        bytes: Buffer.byteLength(content, 'utf8'),
        source: 'connector',
      });
    } catch (error) {
      warnings.push(`Skipped ${repoPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const metadataObject = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as JsonObject
    : undefined;
  return {
    repo,
    ...(options.ref === undefined ? {} : { ref: options.ref }),
    resolvedRef,
    method: 'connector',
    ...(metadataObject === undefined ? {} : { repositoryMetadata: metadataObject }),
    ...(readme === undefined ? {} : { readme }),
    treePaths,
    files,
    warnings,
  };
}

async function collectGithubEvidenceWithGitClone(
  repo: ParsedGitHubRepo,
  options: { ref?: string; maxFiles: number; reason: string },
): Promise<GithubDesignEvidence> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'od-github-context-'));
  const cloneDir = path.join(tmpDir, 'repo');
  const repoUrl = /^https?:\/\//iu.test(repo.source) || repo.source.startsWith('git@')
    ? repo.source
    : `https://github.com/${repo.owner}/${repo.repo}.git`;
  try {
    const args = ['clone', '--depth=1', '--single-branch'];
    if (options.ref) args.push('--branch', options.ref);
    args.push(repoUrl, cloneDir);
    await execGit(args);
    const paths = await listLocalRepoFiles(cloneDir);
    const selectedPaths = selectDesignFiles(paths, options.maxFiles);
    const files: GithubSnapshotFile[] = [];
    let readme: GithubDesignEvidence['readme'];
    for (const repoPath of selectedPaths) {
      const absolutePath = path.join(cloneDir, repoPath);
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile() || fileStat.size > MAX_CONTEXT_FILE_BYTES) continue;
      const content = await readFile(absolutePath, 'utf8');
      if (!readme && /(^|\/)readme\.(md|mdx|txt|rst)$/iu.test(repoPath)) {
        readme = { path: repoPath, content };
        continue;
      }
      files.push({
        repoPath,
        content,
        bytes: Buffer.byteLength(content, 'utf8'),
        source: 'git-clone',
      });
    }
    return {
      repo,
      ...(options.ref === undefined ? {} : { ref: options.ref }),
      ...(options.ref === undefined ? {} : { resolvedRef: options.ref }),
      method: 'git-clone-fallback',
      ...(readme === undefined ? {} : { readme }),
      treePaths: paths,
      files,
      warnings: [`Connector intake failed; used shallow git clone fallback. Reason: ${options.reason}`],
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function execGit(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `git exited with code ${code}`));
      }
    });
  });
}

async function listLocalRepoFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
      const normalized = relativePath.toLowerCase();
      if (entry.isDirectory()) {
        if (shouldSkipRepoPath(`${normalized}/`)) continue;
        await walk(absolutePath);
        continue;
      }
      if (entry.isFile() && !shouldSkipRepoPath(normalized)) files.push(relativePath);
    }
  };
  await walk(root);
  return files.sort((left, right) => left.localeCompare(right));
}

async function writeGithubDesignEvidence(outputPath: string, evidence: GithubDesignEvidence): Promise<GithubDesignEvidence> {
  const resolvedOutputPath = path.resolve(outputPath);
  const snapshotRoot = githubSnapshotRoot(resolvedOutputPath, evidence.repo);
  const writtenFiles: GithubSnapshotFile[] = [];
  for (const file of evidence.files) {
    const safeRelativePath = safeRepoRelativePath(file.repoPath);
    if (!safeRelativePath) continue;
    const fileOutputPath = path.join(snapshotRoot, safeRelativePath);
    await ensureParentDirectory(fileOutputPath);
    await writeFile(fileOutputPath, file.content, 'utf8');
    writtenFiles.push({ ...file, outputPath: path.relative(process.cwd(), fileOutputPath).split(path.sep).join('/') });
  }
  const nextEvidence = { ...evidence, files: writtenFiles };
  await ensureParentDirectory(resolvedOutputPath);
  await writeFile(resolvedOutputPath, renderGithubDesignEvidenceMarkdown(nextEvidence), 'utf8');
  return nextEvidence;
}

function renderGithubDesignEvidenceMarkdown(evidence: GithubDesignEvidence): string {
  const lines = [
    `# GitHub Design Evidence: ${evidence.repo.owner}/${evidence.repo.repo}`,
    '',
    `Source: ${evidence.repo.source}`,
    `Read method: ${evidence.method}`,
    `Ref: ${evidence.resolvedRef ?? evidence.ref ?? 'default branch'}`,
    `Repository paths discovered: ${evidence.treePaths.length}`,
    `Snapshot files written: ${evidence.files.length}`,
    '',
    '## Intake Status',
    '',
    evidence.method === 'connector'
      ? '- GitHub connector was used through `od tools connectors`.'
      : '- Connector intake could not complete; a shallow local git clone fallback was used.',
  ];
  if (evidence.warnings.length > 0) {
    lines.push('', '## Warnings', '', ...evidence.warnings.map((warning) => `- ${warning}`));
  }
  if (evidence.readme) {
    lines.push('', `## README (${evidence.readme.path})`, '', '```md', excerpt(evidence.readme.content), '```');
  }
  if (evidence.files.length > 0) {
    lines.push('', '## Files Inspected', '');
    for (const file of evidence.files) {
      lines.push(`- ${file.repoPath}${file.outputPath ? ` -> \`${file.outputPath}\`` : ''} (${file.bytes} bytes, ${file.source})`);
    }
    lines.push('', '## Design-Relevant Excerpts', '');
    for (const file of evidence.files.slice(0, 12)) {
      lines.push(`### ${file.repoPath}`, '', fencedExcerpt(file.repoPath, file.content), '');
    }
  }
  lines.push(
    '',
    '## Next Design-System Work',
    '',
    '- Use these source paths and snapshots as evidence before writing `DESIGN.md`.',
    '- Extract concrete colors, typography, spacing, radius, component behavior, assets, and product tone only when supported by inspected files.',
    '- If evidence is missing or ambiguous, mark that uncertainty instead of inventing tokens.',
    '',
  );
  return lines.join('\n');
}

function excerpt(content: string): string {
  return content.length > MAX_MARKDOWN_EXCERPT_CHARS
    ? `${content.slice(0, MAX_MARKDOWN_EXCERPT_CHARS)}\n...`
    : content;
}

function fencedExcerpt(repoPath: string, content: string): string {
  const ext = path.extname(repoPath).replace('.', '').toLowerCase();
  const info = ext === 'tsx' || ext === 'ts' || ext === 'jsx' || ext === 'js' ? ext : ext === 'json' ? 'json' : ext === 'css' || ext === 'scss' || ext === 'less' ? ext : '';
  return `\`\`\`${info}\n${excerpt(content)}\n\`\`\``;
}

async function runGithubDesignContext(options: ParsedOptions): Promise<ToolCliResult> {
  if (!options.repo) return fail('github-design-context requires --repo owner/repo');
  const repo = parseGithubRepo(options.repo);
  const maxFiles = options.maxFiles ?? DEFAULT_GITHUB_CONTEXT_MAX_FILES;
  const outputPath = options.outputPath ?? defaultGithubContextOutputPath(repo);
  const baseUrl = daemonUrl();
  const token = toolToken();
  let evidence: GithubDesignEvidence;

  if (!('error' in baseUrl) && typeof token === 'string') {
    try {
      evidence = await collectGithubEvidenceWithConnector(baseUrl, token, repo, {
        ...(options.ref === undefined ? {} : { ref: options.ref }),
        maxFiles,
      });
    } catch (error) {
      if (options.requireConnector) {
        return fail('GitHub connector intake is required and could not read the repository', {
          repo: `${repo.owner}/${repo.repo}`,
          reason: error instanceof Error ? error.message : String(error),
          nextStep: 'Connect GitHub, grant access to this repository, then rerun the github-design-context command. Do not draft design-system files from URL text alone.',
        });
      }
      evidence = await collectGithubEvidenceWithGitClone(repo, {
        ...(options.ref === undefined ? {} : { ref: options.ref }),
        maxFiles,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    const reason = 'error' in baseUrl
      ? baseUrl.error
      : typeof token === 'string'
        ? 'OD_TOOL_TOKEN is not available'
        : token.error;
    if (options.requireConnector) {
      return fail('GitHub connector intake is required but the agent connector environment is missing', {
        repo: `${repo.owner}/${repo.repo}`,
        reason,
        nextStep: 'Run this command from an Open Design agent run with OD_DAEMON_URL and OD_TOOL_TOKEN injected.',
      });
    }
    evidence = await collectGithubEvidenceWithGitClone(repo, {
      ...(options.ref === undefined ? {} : { ref: options.ref }),
      maxFiles,
      reason,
    });
  }

  const written = await writeGithubDesignEvidence(outputPath, evidence);
  writeJson({
    ok: true,
    repo: `${repo.owner}/${repo.repo}`,
    method: written.method,
    outputPath: path.relative(process.cwd(), path.resolve(outputPath)).split(path.sep).join('/'),
    snapshotFiles: written.files.map((file) => file.outputPath).filter(Boolean),
    warnings: written.warnings,
  });
  return { exitCode: 0 };
}

async function requestJson(baseUrl: URL, token: string, pathname: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(endpoint(baseUrl, pathname), {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  });
  const text = await response.text();
  let body: unknown = text;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = { message: text };
    }
  }
  return { status: response.status, body };
}

function compactTool(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const tool = value as JsonObject;
  return {
    name: tool.name,
    description: tool.description,
    safety: tool.safety,
    curation: tool.curation,
    inputSchema: tool.inputSchemaJson ?? tool.inputSchema,
  };
}

function compactConnector(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const connector = value as JsonObject;
  const tools = Array.isArray(connector.tools) ? connector.tools : [];
  return {
    id: connector.id,
    name: connector.name,
    provider: connector.provider,
    category: connector.category,
    status: connector.status,
    accountLabel: connector.accountLabel,
    tools: tools.map(compactTool),
  };
}

function compactList(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const response = value as JsonObject;
  const connectors = Array.isArray(response.connectors) ? response.connectors : [];
  return { connectors: connectors.map(compactConnector) };
}

function compactExecution(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const response = value as JsonObject;
  return {
    connectorId: response.connectorId,
    accountLabel: response.accountLabel,
    toolName: response.toolName,
    safety: response.safety,
    outputSummary: response.outputSummary,
    output: response.output,
    metadata: response.metadata,
  };
}

function compactValidationDetails(details: unknown): unknown {
  if (!details || typeof details !== 'object') return details;
  const record = details as JsonObject;
  if (record.kind !== 'validation' || !Array.isArray(record.issues)) return details;
  return {
    kind: 'validation',
    issues: record.issues.map((issue) => {
      if (!issue || typeof issue !== 'object') return { message: String(issue) };
      const issueRecord = issue as JsonObject;
      return {
        ...(typeof issueRecord.path === 'string' ? { path: issueRecord.path } : {}),
        message: typeof issueRecord.message === 'string' ? issueRecord.message : String(issueRecord.message ?? 'validation failed'),
        ...(typeof issueRecord.code === 'string' ? { code: issueRecord.code } : {}),
      };
    }),
  };
}

function normalizeCliError(body: unknown): CliError {
  const rawError = body && typeof body === 'object' && 'error' in body ? (body as JsonObject).error : body;

  if (typeof rawError === 'string') return { message: rawError };
  if (!rawError || typeof rawError !== 'object') return { message: String(rawError ?? 'request failed') };

  const error = rawError as JsonObject;
  return {
    ...(typeof error.code === 'string' ? { code: error.code } : {}),
    message: typeof error.message === 'string' ? error.message : String(error.error ?? 'request failed'),
    ...(error.details === undefined ? {} : { details: compactValidationDetails(error.details) }),
    ...(typeof error.retryable === 'boolean' ? { retryable: error.retryable } : {}),
    ...(typeof error.requestId === 'string' ? { requestId: error.requestId } : {}),
  };
}

async function printApiResult(response: { status: number; body: unknown }, compact: (body: unknown) => unknown): Promise<ToolCliResult> {
  if (response.status < 200 || response.status >= 300) {
    writeJson({ ok: false, status: response.status, error: normalizeCliError(response.body) }, process.stderr);
    return { exitCode: 1 };
  }
  const body = compact(response.body);
  writeJson(body && typeof body === 'object' && !Array.isArray(body) ? { ok: true, ...(body as JsonObject) } : { ok: true, result: body });
  return { exitCode: 0 };
}

export async function runConnectorsToolCli(args: string[]): Promise<ToolCliResult> {
  const options = parseOptions(args);
  if ('error' in options) return fail(options.error);
  if (options.help || !options.command) {
    process.stdout.write(CONNECTORS_USAGE);
    return { exitCode: options.command ? 0 : 1 };
  }

  if (options.command === 'github-design-context') {
    try {
      return await runGithubDesignContext(options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(message);
    }
  }

  const baseUrl = daemonUrl();
  if ('error' in baseUrl) return fail(baseUrl.error);
  const token = toolToken();
  if (typeof token !== 'string') return fail(token.error);

  try {
    if (options.command === 'list') {
      const listPath = options.useCase ? `/api/tools/connectors/list?useCase=${encodeURIComponent(options.useCase)}` : '/api/tools/connectors/list';
      return await printApiResult(
        await requestJson(baseUrl, token, listPath, { method: 'GET' }),
        options.format === 'compact' ? compactList : (body) => body,
      );
    }

    if (options.command === 'execute') {
      if (!options.connectorId) return fail('execute requires --connector <id>');
      if (!options.toolName) return fail('execute requires --tool <name>');
      if (!options.inputPath) return fail('execute requires --input input.json');
      const input = await readJsonObject(options.inputPath);
      return await printApiResult(
        await requestJson(baseUrl, token, '/api/tools/connectors/execute', {
          method: 'POST',
          body: JSON.stringify({ connectorId: options.connectorId, toolName: options.toolName, input }),
        }),
        options.format === 'compact' ? compactExecution : (body) => body,
      );
    }

    return fail(`unknown connectors command: ${options.command}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message);
  }
}
