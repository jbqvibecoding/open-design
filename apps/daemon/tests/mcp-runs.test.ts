import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleMcpToolCall } from '../src/mcp.js';

const originalFetch = globalThis.fetch;

function firstText(result: { content: Array<{ text: string }> }): string {
  const item = result.content[0];
  if (!item) throw new Error('expected MCP text content');
  return item.text;
}

// These tools let a coding agent (Codex, Cursor, …) commission Open
// Design to generate a design and then poll for the result, instead of
// only reading/creating raw artifacts. The agent never runs a skill
// itself — it asks the daemon to, and the daemon spawns its own agent.
describe('public MCP discovery + generation tools', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
  });

  it('list_skills proxies GET /api/skills', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('http://127.0.0.1:17456/api/skills');
      return new Response(JSON.stringify({ skills: [{ id: 'deck', name: 'Deck' }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleMcpToolCall('http://127.0.0.1:17456', 'list_skills', {});
    expect(JSON.parse(firstText(result))).toEqual({ skills: [{ id: 'deck', name: 'Deck' }] });
  });

  it('start_run resolves a project name and POSTs /api/runs with the prompt + plugin + inputs', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/projects')) {
        return new Response(JSON.stringify({ projects: [{ id: 'project-1', name: 'Demo' }] }), { status: 200 });
      }
      expect(url).toBe('http://127.0.0.1:17456/api/runs');
      expect(init?.method).toBe('POST');
      return new Response(JSON.stringify({ runId: 'run-42', pluginId: 'pitch-deck' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleMcpToolCall('http://127.0.0.1:17456', 'start_run', {
      project: 'Demo',
      prompt: 'A 5-slide seed pitch deck',
      plugin: 'pitch-deck',
      inputs: { tone: 'bold' },
      agent: 'claude',
      model: 'claude-opus-4-7',
    });

    const postBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(postBody).toEqual({
      projectId: 'project-1',
      message: 'A 5-slide seed pitch deck',
      pluginId: 'pitch-deck',
      pluginInputs: { tone: 'bold' },
      agentId: 'claude',
      model: 'claude-opus-4-7',
    });
    expect(JSON.parse(firstText(result))).toMatchObject({ runId: 'run-42' });
  });

  it('start_run uses the active project when project is omitted', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith('/api/active')) {
        return new Response(JSON.stringify({ active: true, projectId: 'active-1', projectName: 'Active', fileName: null }), { status: 200 });
      }
      return new Response(JSON.stringify({ runId: 'run-7' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleMcpToolCall('http://127.0.0.1:17456', 'start_run', { prompt: 'iterate' });

    const postBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(postBody).toMatchObject({ projectId: 'active-1', message: 'iterate' });
    expect(JSON.parse(firstText(result))).toMatchObject({
      runId: 'run-7',
      usedActiveContext: { projectId: 'active-1' },
    });
  });

  it('start_run rejects non-object inputs before posting', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/projects')) {
        return new Response(JSON.stringify({ projects: [{ id: 'project-1', name: 'Demo' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ runId: 'unused' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleMcpToolCall('http://127.0.0.1:17456', 'start_run', {
      project: 'Demo',
      inputs: 'not-an-object',
    });

    expect(result).toMatchObject({ isError: true });
    expect(firstText(result)).toContain('inputs must be an object');
    expect(fetchMock.mock.calls.some((call) => String(call[0]).endsWith('/api/runs'))).toBe(false);
  });

  it('get_run returns status and, on success, a previewUrl built from the project entry file', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/runs/run-42')) {
        return new Response(JSON.stringify({ id: 'run-42', status: 'succeeded', projectId: 'project-1' }), { status: 200 });
      }
      if (url.endsWith('/api/projects/project-1')) {
        return new Response(JSON.stringify({ project: { id: 'project-1', metadata: { entryFile: 'index.html' } } }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleMcpToolCall('http://127.0.0.1:17456', 'get_run', { runId: 'run-42' });
    const parsed = JSON.parse(firstText(result));
    expect(parsed).toMatchObject({ id: 'run-42', status: 'succeeded' });
    expect(parsed.previewUrl).toBe('http://127.0.0.1:17456/api/projects/project-1/raw/index.html');
  });

  it('get_run does not add a previewUrl while the run is still running', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('http://127.0.0.1:17456/api/runs/run-99');
      return new Response(JSON.stringify({ id: 'run-99', status: 'running', projectId: 'project-1' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleMcpToolCall('http://127.0.0.1:17456', 'get_run', { runId: 'run-99' });
    const parsed = JSON.parse(firstText(result));
    expect(parsed.status).toBe('running');
    expect(parsed.previewUrl).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('get_run requires a runId', async () => {
    const result = await handleMcpToolCall('http://127.0.0.1:17456', 'get_run', {});
    expect(result).toMatchObject({ isError: true });
    expect(firstText(result)).toContain('runId is required');
  });

  it('cancel_run POSTs /api/runs/:id/cancel', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://127.0.0.1:17456/api/runs/run-42/cancel');
      expect(init?.method).toBe('POST');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleMcpToolCall('http://127.0.0.1:17456', 'cancel_run', { runId: 'run-42' });
    expect(JSON.parse(firstText(result))).toEqual({ ok: true });
  });

  it('create_project derives a slug id from the name and POSTs /api/projects', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://127.0.0.1:17456/api/projects');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ project: { id: body.id, name: body.name }, conversationId: 'c1' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleMcpToolCall('http://127.0.0.1:17456', 'create_project', {
      name: 'Demo Deck',
      designSystem: 'stripe',
    });

    const postBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(postBody.name).toBe('Demo Deck');
    expect(postBody.id).toMatch(/^demo-deck-[0-9a-f]{4}$/);
    expect(postBody.designSystemId).toBe('stripe');
    expect(JSON.parse(firstText(result))).toMatchObject({ project: { name: 'Demo Deck' }, conversationId: 'c1' });
  });

  it('create_project honors an explicit id', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ project: { id: body.id, name: body.name }, conversationId: 'c1' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await handleMcpToolCall('http://127.0.0.1:17456', 'create_project', { name: 'My Site', id: 'fixed-id' });
    const postBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(postBody.id).toBe('fixed-id');
  });

  it('create_project requires a name before posting', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleMcpToolCall('http://127.0.0.1:17456', 'create_project', {});
    expect(result).toMatchObject({ isError: true });
    expect(firstText(result)).toContain('name is required');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const PROJECT_UUID = '11111111-1111-1111-1111-111111111111';

  it('get_project includes a browser-openable previewUrl from metadata.entryFile', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(`http://127.0.0.1:17456/api/projects/${PROJECT_UUID}`);
      return new Response(
        JSON.stringify({ project: { id: PROJECT_UUID, name: 'P1', metadata: { entryFile: 'index.html', kind: 'landing' } } }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleMcpToolCall('http://127.0.0.1:17456', 'get_project', { project: PROJECT_UUID });
    const parsed = JSON.parse(firstText(result));
    expect(parsed.entryFile).toBe('index.html');
    expect(parsed.previewUrl).toBe(`http://127.0.0.1:17456/api/projects/${PROJECT_UUID}/raw/index.html`);
  });

  it('get_project omits previewUrl when the project has no entry file', async () => {
    // No metadata.entryFile AND no html file in /files — must omit.
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/projects/' + PROJECT_UUID + '/files')) {
        return new Response(JSON.stringify({ files: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ project: { id: PROJECT_UUID, name: 'P1', metadata: {} } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleMcpToolCall('http://127.0.0.1:17456', 'get_project', { project: PROJECT_UUID });
    const parsed = JSON.parse(firstText(result));
    expect(parsed.previewUrl).toBeUndefined();
  });

  // Real-world snag we hit: write_file (and a midstream-killed inner
  // agent) write files into the project but leave metadata.entryFile
  // null, so get_project.previewUrl came back undefined even though
  // /raw/index.html was perfectly viewable. Outer agent then guessed a
  // file:// path. Fix: when metadata is silent, peek the file list and
  // fall back to obvious entries (index.html first, then a single .html).
  it('get_project falls back to index.html when metadata.entryFile is missing but the file exists', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/projects/' + PROJECT_UUID + '/files')) {
        return new Response(JSON.stringify({
          files: [
            { name: 'index.html', path: 'index.html', kind: 'html' },
            { name: 'styles.css', path: 'styles.css', kind: 'css' },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ project: { id: PROJECT_UUID, name: 'P1', metadata: { skipDiscoveryBrief: true } } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleMcpToolCall('http://127.0.0.1:17456', 'get_project', { project: PROJECT_UUID });
    const parsed = JSON.parse(firstText(result));
    expect(parsed.previewUrl).toBe(`http://127.0.0.1:17456/api/projects/${PROJECT_UUID}/raw/index.html`);
  });

  it('get_project falls back to the only *.html when no index.html and no entryFile', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/projects/' + PROJECT_UUID + '/files')) {
        return new Response(JSON.stringify({
          files: [
            { name: 'deck.html', path: 'deck.html', kind: 'html' },
            { name: 'styles.css', path: 'styles.css', kind: 'css' },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ project: { id: PROJECT_UUID, metadata: {} } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleMcpToolCall('http://127.0.0.1:17456', 'get_project', { project: PROJECT_UUID });
    const parsed = JSON.parse(firstText(result));
    expect(parsed.previewUrl).toBe(`http://127.0.0.1:17456/api/projects/${PROJECT_UUID}/raw/deck.html`);
  });

  it('get_project does not guess when there are multiple HTML files and no entryFile', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/projects/' + PROJECT_UUID + '/files')) {
        return new Response(JSON.stringify({
          files: [
            { name: 'a.html', path: 'a.html', kind: 'html' },
            { name: 'b.html', path: 'b.html', kind: 'html' },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ project: { id: PROJECT_UUID, metadata: {} } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleMcpToolCall('http://127.0.0.1:17456', 'get_project', { project: PROJECT_UUID });
    const parsed = JSON.parse(firstText(result));
    expect(parsed.previewUrl).toBeUndefined();
  });

  // Discovery-stage / clarifying-question fallback: when Open Design's
  // inner agent does NOT write files (e.g. it asks back with a discovery
  // form), the run still terminates "succeeded" but the only output
  // lives in the SSE event stream as text_delta chunks. get_run must
  // pull those into an agentMessage field — otherwise the outer agent
  // sees a successful run with no artifacts and assumes failure.

  function sseEvents(entries: Array<{ event: string; data: unknown }>): string {
    return entries
      .map((e, i) => `id: ${i + 1}\nevent: ${e.event}\ndata: ${JSON.stringify(e.data)}\n`)
      .join('\n');
  }

  it('get_run surfaces the inner agent text on success when there are no files', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/runs/run-42')) {
        return new Response(JSON.stringify({ id: 'run-42', status: 'succeeded', projectId: 'project-1' }), { status: 200 });
      }
      if (url.endsWith('/api/projects/project-1')) {
        // No entry file → no previewUrl. Discovery scenario.
        return new Response(JSON.stringify({ project: { id: 'project-1', metadata: {} } }), { status: 200 });
      }
      if (url.endsWith('/api/runs/run-42/events')) {
        return new Response(
          sseEvents([
            { event: 'start', data: { runId: 'run-42' } },
            { event: 'agent', data: { type: 'text_delta', delta: '明白，先锁定几个细节。' } },
            { event: 'agent', data: { type: 'text_delta', delta: '<question-form>…</question-form>' } },
            { event: 'end', data: { code: 0, status: 'succeeded' } },
          ]),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleMcpToolCall('http://127.0.0.1:17456', 'get_run', { runId: 'run-42' });
    const parsed = JSON.parse(firstText(result));
    expect(parsed.status).toBe('succeeded');
    expect(parsed.agentMessage).toContain('明白');
    expect(parsed.agentMessage).toContain('<question-form>');
    expect(parsed.previewUrl).toBeUndefined();
  });

  it('get_run still includes agentMessage even when previewUrl is present', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/runs/run-42')) {
        return new Response(JSON.stringify({ id: 'run-42', status: 'succeeded', projectId: 'project-1' }), { status: 200 });
      }
      if (url.endsWith('/api/projects/project-1')) {
        return new Response(JSON.stringify({ project: { id: 'project-1', metadata: { entryFile: 'index.html' } } }), { status: 200 });
      }
      if (url.endsWith('/api/runs/run-42/events')) {
        return new Response(
          sseEvents([{ event: 'agent', data: { type: 'text_delta', delta: 'Done — see index.html.' } }]),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleMcpToolCall('http://127.0.0.1:17456', 'get_run', { runId: 'run-42' });
    const parsed = JSON.parse(firstText(result));
    expect(parsed.previewUrl).toBe('http://127.0.0.1:17456/api/projects/project-1/raw/index.html');
    expect(parsed.agentMessage).toBe('Done — see index.html.');
  });

  it('get_run tolerates a missing events endpoint (older daemons / unreachable)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/runs/run-42')) {
        return new Response(JSON.stringify({ id: 'run-42', status: 'succeeded', projectId: 'project-1' }), { status: 200 });
      }
      if (url.endsWith('/api/projects/project-1')) {
        return new Response(JSON.stringify({ project: { id: 'project-1', metadata: { entryFile: 'index.html' } } }), { status: 200 });
      }
      if (url.endsWith('/api/runs/run-42/events')) {
        return new Response('not found', { status: 404 });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleMcpToolCall('http://127.0.0.1:17456', 'get_run', { runId: 'run-42' });
    const parsed = JSON.parse(firstText(result));
    expect(parsed.status).toBe('succeeded');
    expect(parsed.previewUrl).toBe('http://127.0.0.1:17456/api/projects/project-1/raw/index.html');
    expect(parsed.agentMessage).toBeUndefined();
  });

  // #2: MCP-driven projects skip Open Design's interactive discovery
  // stage. The outer agent (Codex, Cursor, …) IS the user-facing surface;
  // having OD ask a discovery form back through MCP creates a confusing
  // nested-clarification loop where the form ends up dropped because no
  // file is produced. So create_project pre-sets skipDiscoveryBrief.

  it('create_project sets skipDiscoveryBrief:true by default', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ project: { id: body.id, name: body.name }, conversationId: 'c1' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await handleMcpToolCall('http://127.0.0.1:17456', 'create_project', { name: 'X' });
    const postBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(postBody.skipDiscoveryBrief).toBe(true);
  });

  // #4: list_plugins flattens the bulky daemon record (sourceKind,
  // fsPath, marketplaceTrust, installedAt, …) into the few fields an
  // external agent actually needs to pick a plugin — id, title,
  // description, kind, tags.

  it('list_plugins maps to a slim agent-friendly shape pulled from manifest', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({
        plugins: [
          {
            id: 'example-html-ppt-pitch-deck',
            title: 'Html Ppt Pitch Deck',
            sourceKind: 'bundled',
            fsPath: '/some/path',
            installedAt: 1234,
            manifest: {
              name: 'example-html-ppt-pitch-deck',
              title: 'HTML PPT Pitch Deck',
              description: 'Investor-ready 10-slide HTML pitch deck — gradient hero, big numbers, traction bar chart.',
              tags: ['deck', 'pitch'],
              od: { kind: 'scenario', taskKind: 'deck' },
            },
          },
        ],
      }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleMcpToolCall('http://127.0.0.1:17456', 'list_plugins', {});
    const parsed = JSON.parse(firstText(result));
    expect(parsed.plugins).toEqual([
      {
        id: 'example-html-ppt-pitch-deck',
        title: 'HTML PPT Pitch Deck',
        description: 'Investor-ready 10-slide HTML pitch deck — gradient hero, big numbers, traction bar chart.',
        kind: 'deck',
        tags: ['deck', 'pitch'],
      },
    ]);
    expect(parsed.plugins[0]).not.toHaveProperty('fsPath');
    expect(parsed.plugins[0]).not.toHaveProperty('sourceKind');
  });

  // list_agents lets the outer agent stop guessing 'claude' vs 'codex'
  // vs 'gemini' for start_run.agent. We slim /api/agents (15+ fields per
  // record) and default to filtering out unavailable ones so the agent
  // only sees runnable options.

  it('list_agents returns only available agents in a slim shape by default', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      agents: [
        {
          id: 'claude',
          name: 'Claude Code',
          bin: 'claude',
          version: '2.1.153',
          available: true,
          path: '/usr/local/bin/claude',
          installUrl: 'https://…',
          versionArgs: ['--version'],
          promptViaStdin: true,
          promptInputFormat: 'stream-json',
          streamFormat: 'claude-stream-json',
          models: [
            { id: 'default', label: 'Default' },
            { id: 'sonnet', label: 'Sonnet' },
            { id: 'opus', label: 'Opus' },
          ],
        },
        {
          id: 'devin',
          name: 'Devin for Terminal',
          bin: 'devin',
          version: null,
          available: false,
          path: null,
          installUrl: 'https://…',
          models: [{ id: 'default', label: 'Default' }],
        },
      ],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleMcpToolCall('http://127.0.0.1:17456', 'list_agents', {});
    const parsed = JSON.parse(firstText(result));
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.agents[0]).toEqual({
      id: 'claude',
      name: 'Claude Code',
      version: '2.1.153',
      models: [
        { id: 'default', label: 'Default' },
        { id: 'sonnet', label: 'Sonnet' },
        { id: 'opus', label: 'Opus' },
      ],
      modelsCount: 3,
    });
    // Protocol fields we don't want the agent reasoning about:
    expect(parsed.agents[0]).not.toHaveProperty('bin');
    expect(parsed.agents[0]).not.toHaveProperty('promptInputFormat');
    expect(parsed.agents[0]).not.toHaveProperty('streamFormat');
  });

  it('list_agents truncates very long model lists but reports the real count', async () => {
    const longModels = Array.from({ length: 165 }, (_, i) => ({ id: `m-${i}`, label: `M${i}` }));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      agents: [{ id: 'opencode', name: 'OpenCode', available: true, models: longModels }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleMcpToolCall('http://127.0.0.1:17456', 'list_agents', {});
    const parsed = JSON.parse(firstText(result));
    expect(parsed.agents[0].models).toHaveLength(10);
    expect(parsed.agents[0].modelsCount).toBe(165);
  });

  it('list_agents includeUnavailable:true returns unavailable agents with hints', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      agents: [
        { id: 'claude', name: 'Claude Code', available: true, models: [] },
        { id: 'devin', name: 'Devin', available: false, installUrl: 'https://cli.devin.ai', models: [] },
      ],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleMcpToolCall('http://127.0.0.1:17456', 'list_agents', { includeUnavailable: true });
    const parsed = JSON.parse(firstText(result));
    expect(parsed.agents).toHaveLength(2);
    const devin = parsed.agents.find((a: { id: string }) => a.id === 'devin');
    expect(devin).toMatchObject({ id: 'devin', available: false, installUrl: 'https://cli.devin.ai' });
  });
});
