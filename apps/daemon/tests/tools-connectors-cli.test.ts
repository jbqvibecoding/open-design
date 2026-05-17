import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runConnectorsToolCli } from '../src/tools-connectors-cli.js';

const ORIGINAL_ENV = { ...process.env };

describe('connectors tool CLI', () => {
  let stdoutWrite: { mockRestore: () => void };
  let stderrWrite: { mockRestore: () => void };
  let stdoutOutput: string[];
  let stderrOutput: string[];
  let fetchMock: ReturnType<typeof vi.fn>;
  let cwd: string;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    cwd = process.cwd();
    stdoutOutput = [];
    stderrOutput = [];
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

  afterEach(() => {
    vi.unstubAllGlobals();
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
    process.env = ORIGINAL_ENV;
    process.chdir(cwd);
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

  it('writes GitHub design evidence through connected connector tools', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'od-connectors-cli-'));
    process.chdir(tmpDir);
    process.env.OD_DAEMON_URL = 'http://127.0.0.1:7456';
    process.env.OD_TOOL_TOKEN = 'agent-run-token';

    const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64');
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        connectors: [{
          id: 'github',
          name: 'GitHub',
          provider: 'composio',
          category: 'Developer',
          status: 'connected',
          tools: [{ name: 'github.github_get_repository_content' }],
        }],
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: { default_branch: 'main', html_url: 'https://github.com/acme/ui' } },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: { path: 'README.md', encoding: 'base64', content: encode('# Acme UI') } },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: { tree: [
          { path: 'package.json', type: 'blob' },
          { path: 'src/components/Button.tsx', type: 'blob' },
          { path: 'src/styles.css', type: 'blob' },
        ] } },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: { content: { mimetype: 'text/plain', name: 'Button.tsx', s3url: 'https://signed.example/Button.tsx' } } },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response('export function Button(){ return <button className="rounded-md" /> }', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: '{"dependencies":{"@radix-ui/react-slot":"latest"}}' },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: ':root { --color-brand: #ff5500; --radius-md: 8px; }' },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }));

    const result = await runConnectorsToolCli(['github-design-context', '--repo', 'acme/ui', '--max-files', '3']);

    expect(result.exitCode).toBe(0);
    const stdout = JSON.parse(stdoutOutput.join(''));
    expect(stdout).toEqual(expect.objectContaining({
      ok: true,
      repo: 'acme/ui',
      method: 'connector',
      outputPath: 'context/github/acme-ui.md',
    }));
    await expect(readFile(path.join(tmpDir, 'context/github/acme-ui.md'), 'utf8')).resolves.toContain('GitHub connector was used');
    await expect(readFile(path.join(tmpDir, 'context/github/acme-ui/files/src/components/Button.tsx'), 'utf8')).resolves.toContain('rounded-md');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:7456/api/tools/connectors/execute',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('github.github_get_raw_repository_content'),
      }),
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('falls back to bounded connector directory browsing when the repository tree is too large', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'od-connectors-cli-'));
    process.chdir(tmpDir);
    process.env.OD_DAEMON_URL = 'http://127.0.0.1:7456';
    process.env.OD_TOOL_TOKEN = 'agent-run-token';

    const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64');
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        connectors: [{
          id: 'github',
          name: 'GitHub',
          provider: 'composio',
          category: 'Developer',
          status: 'connected',
          tools: [{ name: 'github.github_get_repository_content' }],
        }],
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: { default_branch: 'main', html_url: 'https://github.com/acme/ui' } },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: { path: 'README.md', encoding: 'base64', content: encode('# Acme UI') } },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: 'CONNECTOR_OUTPUT_TOO_LARGE', message: 'connector output exceeds max serialized size' },
      }), { headers: { 'Content-Type': 'application/json' }, status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: { content: [
          { path: 'package.json', type: 'file' },
          { path: 'src', type: 'dir' },
          { path: 'docs', type: 'dir' },
        ] } },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: { content: [
          { path: 'src/styles.css', type: 'file' },
          { path: 'src/components', type: 'dir' },
        ] } },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: { content: [{ path: 'src/components/Button.tsx', type: 'file' }] } },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: '{"dependencies":{"@radix-ui/react-slot":"latest"}}' },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: ':root { --color-brand: #ff5500; }' },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: 'export function Button(){ return <button /> }' },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }));

    const result = await runConnectorsToolCli(['github-design-context', '--repo', 'acme/ui', '--max-files', '3', '--require-connector']);

    expect(result.exitCode).toBe(0);
    const stdout = JSON.parse(stdoutOutput.join(''));
    expect(stdout).toEqual(expect.objectContaining({
      ok: true,
      method: 'connector',
      warnings: expect.arrayContaining([
        expect.stringContaining('Recursive tree connector read failed'),
      ]),
    }));
    await expect(readFile(path.join(tmpDir, 'context/github/acme-ui.md'), 'utf8')).resolves.toContain('bounded directory browsing');
    await expect(readFile(path.join(tmpDir, 'context/github/acme-ui.md'), 'utf8')).resolves.toContain('src/components/Button.tsx');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:7456/api/tools/connectors/execute',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('github.github_get_repository_content'),
      }),
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('fails instead of using public fallback when GitHub connector intake is required', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'od-connectors-cli-'));
    process.chdir(tmpDir);
    process.env.OD_DAEMON_URL = 'http://127.0.0.1:7456';
    process.env.OD_TOOL_TOKEN = 'agent-run-token';

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        connectors: [{
          id: 'github',
          name: 'GitHub',
          provider: 'composio',
          category: 'Developer',
          status: 'connected',
        }],
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'repository access denied' },
      }), { headers: { 'Content-Type': 'application/json' }, status: 403 }));

    const result = await runConnectorsToolCli(['github-design-context', '--repo', 'acme/private-ui', '--require-connector']);

    expect(result.exitCode).toBe(1);
    expect(stderrOutput.join('')).toContain('GitHub connector intake is required and could not read the repository');
    expect(stderrOutput.join('')).toContain('repository access denied');
    await expect(readFile(path.join(tmpDir, 'context/github/acme-private-ui.md'), 'utf8')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await rm(tmpDir, { recursive: true, force: true });
  });
});
