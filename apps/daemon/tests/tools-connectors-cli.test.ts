import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { runConnectorsToolCli } from '../src/tools-connectors-cli.js';

const ORIGINAL_ENV = { ...process.env };

describe('connectors tool CLI', () => {
  let stdoutWrite: { mockRestore: () => void };
  let stderrWrite: { mockRestore: () => void };
  let stdoutOutput: string[];
  let stderrOutput: string[];
  let fetchMock: ReturnType<typeof vi.fn>;
  let tempDirs: string[];

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    stdoutOutput = [];
    stderrOutput = [];
    tempDirs = [];
    stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutOutput.push(String(chunk));
      return true;
    });
    stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrOutput.push(String(chunk));
      return true;
    });
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ connectors: [] }), { headers: { 'Content-Type': 'application/json' }, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
    process.env = ORIGINAL_ENV;
  });

  it('appends curated useCase query params for connector listing', async () => {
    process.env.OD_DAEMON_URL = 'http://127.0.0.1:7456/base/';
    process.env.OD_TOOL_TOKEN = 'agent-run-token';
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ connectors: [] }), { headers: { 'Content-Type': 'application/json' }, status: 200 }));

    const result = await runConnectorsToolCli(['list', '--use-case', 'personal_daily_digest']);

    expect(result.exitCode).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:7456/base/api/tools/connectors/list?useCase=personal_daily_digest',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer agent-run-token' }),
      }),
    );
  });

  it('includes curation in compact connector output', async () => {
    process.env.OD_DAEMON_URL = 'http://127.0.0.1:7456';
    process.env.OD_TOOL_TOKEN = 'agent-run-token';
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      connectors: [{
        id: 'slack',
        name: 'Slack',
        provider: 'composio',
        category: 'Communication',
        status: 'connected',
        tools: [{
          name: 'slack.slack_list_channels',
          description: 'List Slack channels',
          safety: { sideEffect: 'read', approval: 'auto', reason: 'read-only' },
          curation: { useCases: ['personal_daily_digest'], reason: 'Digest source' },
        }],
      }],
    }), { headers: { 'Content-Type': 'application/json' }, status: 200 }));

    const result = await runConnectorsToolCli(['list']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdoutOutput.join(''))).toEqual({
      ok: true,
      connectors: [{
        id: 'slack',
        name: 'Slack',
        provider: 'composio',
        category: 'Communication',
        status: 'connected',
        accountLabel: undefined,
        tools: [{
          name: 'slack.slack_list_channels',
          description: 'List Slack channels',
          safety: { sideEffect: 'read', approval: 'auto', reason: 'read-only' },
          curation: { useCases: ['personal_daily_digest'], reason: 'Digest source' },
          inputSchema: undefined,
        }],
      }],
    });
    expect(stderrOutput.join('')).toBe('');
  });

  it('writes GitHub design-system evidence through the connected connector', async () => {
    process.env.OD_DAEMON_URL = 'http://127.0.0.1:7456';
    process.env.OD_TOOL_TOKEN = 'agent-run-token';
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'od-github-design-context-'));
    tempDirs.push(tempDir);
    const outputPath = path.join(tempDir, 'context/github/nexu-io-open-design.md');
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(githubConnectorList()), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockImplementation(async () => new Response(JSON.stringify({
        ok: true,
        connectorId: 'github',
        toolName: 'github.github_search_repositories',
        output: { data: { name: 'open-design' } },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }));

    const result = await runConnectorsToolCli([
      'github-design-context',
      '--repo',
      'https://github.com/nexu-io/open-design',
      '--output',
      outputPath,
      '--require-connector',
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdoutOutput.join(''))).toMatchObject({
      ok: true,
      repo: 'https://github.com/nexu-io/open-design',
      successfulCalls: expect.any(Number),
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:7456/api/tools/connectors/execute',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"connectorId":"github"'),
      }),
    );
    await expect(readFile(outputPath, 'utf8')).resolves.toContain('GitHub Connector Evidence: nexu-io/open-design');
    await expect(readFile(path.join(tempDir, 'context/github/nexu-io-open-design/files/README.md.json'), 'utf8')).resolves.toContain('open-design');
  });

  it('keeps GitHub design-system intake running when one connector output is oversized', async () => {
    process.env.OD_DAEMON_URL = 'http://127.0.0.1:7456';
    process.env.OD_TOOL_TOKEN = 'agent-run-token';
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'od-github-design-context-'));
    tempDirs.push(tempDir);
    const outputPath = path.join(tempDir, 'context/github/tinyhumansai-openhuman.md');
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(githubConnectorList()), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        connectorId: 'github',
        toolName: 'github.github_search_repositories',
        output: { data: { name: 'openhuman' } },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockImplementation(async () => new Response(JSON.stringify({
        error: {
          code: 'CONNECTOR_OUTPUT_TOO_LARGE',
          message: 'connector output exceeds max serialized size',
        },
      }), { headers: { 'Content-Type': 'application/json' }, status: 502 }));

    const result = await runConnectorsToolCli([
      'github-design-context',
      '--repo',
      'tinyhumansai/openhuman',
      '--output',
      outputPath,
      '--require-connector',
    ]);

    expect(result.exitCode).toBe(0);
    const stdout = JSON.parse(stdoutOutput.join('')) as { warnings: Array<{ warning: string }> };
    expect(stdout.warnings.some((warning) => warning.warning.includes('too large'))).toBe(true);
    const note = await readFile(outputPath, 'utf8');
    expect(note).toContain('Connector output was too large');
    expect(note).toContain('Successful connector calls: 1');
    expect(stderrOutput.join('')).toBe('');
  });
});

function githubConnectorList() {
  return {
    connectors: [{
      id: 'github',
      name: 'GitHub',
      provider: 'composio',
      category: 'Developer',
      status: 'connected',
      accountLabel: 'octocat',
      tools: [
        {
          name: 'github.github_search_repositories',
          description: 'Search repositories',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
            additionalProperties: false,
          },
        },
        {
          name: 'github.github_get_file_content',
          description: 'Get file content',
          inputSchema: {
            type: 'object',
            properties: {
              owner: { type: 'string' },
              repo: { type: 'string' },
              path: { type: 'string' },
            },
            required: ['owner', 'repo', 'path'],
            additionalProperties: false,
          },
        },
      ],
    }],
  };
}
