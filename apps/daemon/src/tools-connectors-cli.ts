import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
  outputPath?: string;
  requireConnector: boolean;
  useCase?: 'personal_daily_digest';
  format: 'compact' | 'json';
  help: boolean;
}

const CONNECTORS_USAGE = `Usage:
  od tools connectors list [--use-case personal_daily_digest] [--format compact]
  od tools connectors execute --connector <id> --tool <name> --input input.json
  od tools connectors github-design-context --repo <github-url-or-owner/repo> --output context/github/owner-repo.md [--require-connector]

Environment:
  OD_NODE_BIN     Node-compatible runtime for agent wrapper invocations
  OD_BIN          Open Design CLI script for agent wrapper invocations
  OD_DAEMON_URL   Daemon base URL injected into agent runs
  OD_TOOL_TOKEN   Bearer token injected into agent runs

Agent runtime invocation:
  "$OD_NODE_BIN" "$OD_BIN" tools connectors list --use-case personal_daily_digest --format compact
`;

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
    requireConnector: false,
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
      if (!value) return { error: '--repo requires a GitHub repository URL or owner/repo' };
      options.repo = value;
    } else if (arg === '--output') {
      const value = rest[++index];
      if (!value) return { error: '--output requires a file path' };
      options.outputPath = value;
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

interface GithubRepoRef {
  owner: string;
  repo: string;
  url: string;
  slug: string;
}

interface GithubEvidenceTool {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  inputSchema?: unknown;
}

interface GithubEvidenceCall {
  label: string;
  toolName: string;
  input: JsonObject;
  snapshotPath?: string;
  output?: unknown;
  warning?: string;
}

const GITHUB_DESIGN_CONTEXT_PATHS = [
  'README.md',
  'package.json',
  'src/index.css',
  'src/App.tsx',
  'app/globals.css',
  'tailwind.config.ts',
  'components.json',
  'design-system.css',
  'tokens.css',
];

function parseGithubRepoRef(raw: string): GithubRepoRef | { error: string } {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/?#].*)?$/iu.exec(raw)
    ?? /^([^/\s]+)\/([^/\s#?]+?)(?:\.git)?$/u.exec(raw);
  const owner = match?.[1]?.trim();
  const repo = match?.[2]?.trim();
  if (!owner || !repo) return { error: '--repo must be a GitHub URL or owner/repo' };
  const cleanRepo = repo.replace(/\.git$/iu, '');
  return {
    owner,
    repo: cleanRepo,
    url: `https://github.com/${owner}/${cleanRepo}`,
    slug: `${sanitizeEvidenceSegment(owner)}-${sanitizeEvidenceSegment(cleanRepo)}`,
  };
}

function sanitizeEvidenceSegment(value: string): string {
  return value.trim().replace(/[^a-z0-9._-]+/giu, '-').replace(/^-+|-+$/gu, '') || 'repo';
}

function connectorById(body: unknown, connectorId: string): JsonObject | null {
  if (!body || typeof body !== 'object') return null;
  const connectors = (body as JsonObject).connectors;
  if (!Array.isArray(connectors)) return null;
  return connectors.find((connector): connector is JsonObject =>
    Boolean(connector && typeof connector === 'object' && (connector as JsonObject).id === connectorId),
  ) ?? null;
}

function connectorTools(connector: JsonObject | null): GithubEvidenceTool[] {
  const tools = connector?.tools;
  return Array.isArray(tools)
    ? tools.filter((tool): tool is GithubEvidenceTool => Boolean(tool && typeof tool === 'object'))
    : [];
}

function toolText(tool: GithubEvidenceTool): string {
  return [tool.name, tool.title, tool.description]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
}

function findGithubTool(tools: GithubEvidenceTool[], pattern: RegExp): GithubEvidenceTool | null {
  return tools.find((tool) => typeof tool.name === 'string' && pattern.test(toolText(tool))) ?? null;
}

function schemaProperties(tool: GithubEvidenceTool): JsonObject {
  const schema = tool.inputSchema;
  if (!schema || typeof schema !== 'object') return {};
  const properties = (schema as JsonObject).properties;
  return properties && typeof properties === 'object' && !Array.isArray(properties) ? properties as JsonObject : {};
}

function schemaRequired(tool: GithubEvidenceTool): string[] {
  const schema = tool.inputSchema;
  if (!schema || typeof schema !== 'object') return [];
  const required = (schema as JsonObject).required;
  return Array.isArray(required) ? required.filter((value): value is string => typeof value === 'string') : [];
}

function buildGithubToolInput(tool: GithubEvidenceTool, repo: GithubRepoRef, filePath?: string): JsonObject | null {
  const properties = schemaProperties(tool);
  const propertyNames = Object.keys(properties);
  const required = schemaRequired(tool);
  const input: JsonObject = {};
  const assign = (names: string[], value: unknown) => {
    for (const name of names) {
      if (propertyNames.includes(name)) input[name] = value;
    }
  };
  assign(['owner', 'repo_owner', 'repository_owner'], repo.owner);
  assign(['repo', 'repository', 'repo_name', 'repository_name'], repo.repo);
  assign(['full_name', 'repo_full_name', 'repository_full_name'], `${repo.owner}/${repo.repo}`);
  assign(['url', 'repo_url', 'repository_url'], repo.url);
  assign(['query', 'q', 'search'], `repo:${repo.owner}/${repo.repo}`);
  assign(['ref', 'branch', 'sha'], 'HEAD');
  if (filePath) assign(['path', 'file_path', 'filepath', 'file', 'filename'], filePath);
  for (const name of required) {
    if (input[name] === undefined) return null;
  }
  if (Object.keys(input).length === 0) return null;
  return input;
}

async function executeConnector(
  baseUrl: URL,
  token: string,
  toolName: string,
  input: JsonObject,
): Promise<{ ok: true; body: unknown } | { ok: false; error: CliError; status: number }> {
  const response = await requestJson(baseUrl, token, '/api/tools/connectors/execute', {
    method: 'POST',
    body: JSON.stringify({ connectorId: 'github', toolName, input }),
  });
  if (response.status >= 200 && response.status < 300) return { ok: true, body: response.body };
  return { ok: false, status: response.status, error: normalizeCliError(response.body) };
}

function shortJson(value: unknown, maxChars = 12_000): string {
  const text = JSON.stringify(value, null, 2) ?? '';
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n... [truncated]` : text;
}

function outputFromExecution(body: unknown): unknown {
  return body && typeof body === 'object' && 'output' in body ? (body as JsonObject).output : body;
}

function buildGithubEvidenceMarkdown(repo: GithubRepoRef, calls: GithubEvidenceCall[]): string {
  const successes = calls.filter((call) => call.output !== undefined);
  const warnings = calls.filter((call) => call.warning);
  return [
    `# GitHub Connector Evidence: ${repo.owner}/${repo.repo}`,
    '',
    `Repository: ${repo.url}`,
    '',
    'This note was generated through the connected GitHub connector. Use it as source evidence before drafting design-system rules.',
    '',
    '## Connector Calls',
    '',
    ...calls.flatMap((call) => [
      `### ${call.label}`,
      '',
      `Tool: \`${call.toolName}\``,
      '',
      `Input: \`${JSON.stringify(call.input)}\``,
      '',
      call.warning ? `Warning: ${call.warning}` : '',
      call.output === undefined ? '' : `\`\`\`json\n${shortJson(outputFromExecution(call.output))}\n\`\`\``,
      '',
    ]),
    '## Summary',
    '',
    `Successful connector calls: ${successes.length}`,
    `Warnings: ${warnings.length}`,
    '',
    warnings.length
      ? warnings.map((call) => `- ${call.label}: ${call.warning}`).join('\n')
      : '- None.',
    '',
  ].filter((line) => line !== undefined).join('\n');
}

async function runGithubDesignContext(baseUrl: URL, token: string, options: ParsedOptions): Promise<ToolCliResult> {
  if (!options.repo) return fail('github-design-context requires --repo <github-url-or-owner/repo>');
  if (!options.outputPath) return fail('github-design-context requires --output <path>');
  const repo = parseGithubRepoRef(options.repo);
  if ('error' in repo) return fail(repo.error);
  const list = await requestJson(baseUrl, token, '/api/tools/connectors/list', { method: 'GET' });
  if (list.status < 200 || list.status >= 300) return printApiResult(list, compactList);
  const github = connectorById(list.body, 'github');
  if (!github || github.status !== 'connected') {
    const message = 'connected GitHub connector is required for github-design-context';
    return options.requireConnector ? fail(message, { connectorId: 'github', status: github?.status ?? 'missing' }) : { exitCode: 0 };
  }
  const tools = connectorTools(github);
  const calls: GithubEvidenceCall[] = [];
  const searchTool = findGithubTool(tools, /search.*repositor|repositor.*search/u);
  const fileTool = findGithubTool(tools, /(?:file|content|blob|raw)/u);
  const enqueue = async (label: string, tool: GithubEvidenceTool | null, filePath?: string) => {
    if (!tool || typeof tool.name !== 'string') {
      calls.push({ label, toolName: 'unavailable', input: {}, ...(filePath ? { snapshotPath: filePath } : {}), warning: 'No compatible GitHub connector tool was available.' });
      return;
    }
    const input = buildGithubToolInput(tool, repo, filePath);
    if (!input) {
      calls.push({ label, toolName: tool.name, input: {}, ...(filePath ? { snapshotPath: filePath } : {}), warning: 'Tool input schema was not compatible with this intake command.' });
      return;
    }
    const result = await executeConnector(baseUrl, token, tool.name, input);
    if (result.ok) {
      calls.push({ label, toolName: tool.name, input, ...(filePath ? { snapshotPath: filePath } : {}), output: result.body });
    } else {
      const oversized = result.error.code === 'CONNECTOR_OUTPUT_TOO_LARGE';
      calls.push({
        label,
        toolName: tool.name,
        input,
        ...(filePath ? { snapshotPath: filePath } : {}),
        warning: oversized
          ? 'Connector output was too large; this intake kept going with the remaining bounded calls.'
          : `${result.error.code ? `${result.error.code}: ` : ''}${result.error.message}`,
      });
    }
  };
  await enqueue('Repository search', searchTool);
  for (const filePath of GITHUB_DESIGN_CONTEXT_PATHS) {
    await enqueue(`File snapshot: ${filePath}`, fileTool, filePath);
  }
  const successCount = calls.filter((call) => call.output !== undefined).length;
  if (successCount === 0) {
    return fail('GitHub connector intake could not read repository evidence', { repo: repo.url, calls });
  }
  const outputPath = path.resolve(options.outputPath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, buildGithubEvidenceMarkdown(repo, calls), 'utf8');
  const snapshotsRoot = path.join(
    path.dirname(outputPath),
    path.basename(outputPath, path.extname(outputPath)),
    'files',
  );
  const snapshotCalls = calls.filter((call) => call.snapshotPath && call.output !== undefined);
  for (const call of snapshotCalls) {
    const snapshotPath = path.join(snapshotsRoot, `${call.snapshotPath}.json`);
    await mkdir(path.dirname(snapshotPath), { recursive: true });
    await writeFile(snapshotPath, `${shortJson(outputFromExecution(call.output), 80_000)}\n`, 'utf8');
  }
  writeJson({
    ok: true,
    repo: repo.url,
    output: options.outputPath,
    snapshots: snapshotCalls.length,
    successfulCalls: successCount,
    warnings: calls.filter((call) => call.warning).map((call) => ({ label: call.label, warning: call.warning })),
  });
  return { exitCode: 0 };
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

    if (options.command === 'github-design-context') {
      return await runGithubDesignContext(baseUrl, token, options);
    }

    return fail(`unknown connectors command: ${options.command}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message);
  }
}
