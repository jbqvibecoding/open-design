// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorDetail } from '@open-design/contracts';

import { DesignSystemCreationFlow } from '../../src/components/DesignSystemFlow';
import type { AppConfig, DesignSystemDetail, Project } from '../../src/types';

const mocks = vi.hoisted(() => ({
  connectConnector: vi.fn(),
  createDesignSystemDraft: vi.fn(),
  disconnectConnector: vi.fn(),
  ensureDesignSystemWorkspace: vi.fn(),
  fetchConnectorDetail: vi.fn(),
  openFolderDialog: vi.fn(),
  patchProject: vi.fn(),
  uploadProjectFile: vi.fn(),
  writeProjectTextFile: vi.fn(),
}));

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    connectConnector: mocks.connectConnector,
    createDesignSystemDraft: mocks.createDesignSystemDraft,
    disconnectConnector: mocks.disconnectConnector,
    ensureDesignSystemWorkspace: mocks.ensureDesignSystemWorkspace,
    fetchConnectorDetail: mocks.fetchConnectorDetail,
    openFolderDialog: mocks.openFolderDialog,
    uploadProjectFile: mocks.uploadProjectFile,
    writeProjectTextFile: mocks.writeProjectTextFile,
  };
});

vi.mock('../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/projects')>(
    '../../src/state/projects',
  );
  return {
    ...actual,
    patchProject: mocks.patchProject,
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.sessionStorage.clear();
});

beforeEach(() => {
  mocks.connectConnector.mockResolvedValue({ connector: null });
  mocks.disconnectConnector.mockResolvedValue(null);
  mocks.fetchConnectorDetail.mockResolvedValue(null);
  mocks.openFolderDialog.mockResolvedValue(null);
  mocks.uploadProjectFile.mockImplementation(async (_projectId: string, file: File, desiredName?: string) => ({
    name: desiredName ?? file.name,
    size: file.size,
    mtime: 1,
    kind: 'code',
    mime: file.type || 'text/plain',
  }));
  mocks.writeProjectTextFile.mockImplementation(async (_projectId: string, name: string) => ({
    name,
    size: 1,
    mtime: 1,
    kind: 'document',
    mime: 'text/markdown',
  }));
});

describe('DesignSystemCreationFlow', () => {
  it('creates a project-backed design system and hands the first task to the normal project chat', async () => {
    const system: DesignSystemDetail = {
      id: 'user:acme-design-system',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Acme product workspace.',
      swatches: [],
      surface: 'web',
      body: '# Acme Design System\n',
      source: 'user',
      status: 'draft',
      isEditable: true,
      projectId: 'ds-acme-design-system',
    };
    const project: Project = {
      id: 'ds-acme-design-system',
      name: 'Acme Design System',
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        kind: 'other',
        importedFrom: 'design-system',
        entryFile: 'DESIGN.md',
        sourceFileName: system.id,
      },
    };
    mocks.createDesignSystemDraft.mockResolvedValue(system);
    mocks.ensureDesignSystemWorkspace.mockResolvedValue({ project, files: [] });
    mocks.patchProject.mockResolvedValue({ ...project, pendingPrompt: 'Create this project as a design system.' });

    const onCreated = vi.fn();
    const onSystemsRefresh = vi.fn();

    render(
      <DesignSystemCreationFlow
        onBack={() => {}}
        onCreated={onCreated}
        onSystemsRefresh={onSystemsRefresh}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/Mission Impastabowl/i), {
      target: {
        value: 'Acme: analytics workspace for operations teams',
      },
    });
    fireEvent.click(screen.getByText('Continue to generation'));
    fireEvent.click(screen.getByText('Generate'));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(system.id));

    expect(mocks.createDesignSystemDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Acme Design System',
        status: 'draft',
        surface: 'web',
        artifactMode: 'agent-managed',
      }),
    );
    expect(mocks.ensureDesignSystemWorkspace).toHaveBeenCalledWith(system.id);
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('## Review Contract'),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('Create this project as a complete Open Design design system workspace.'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('Read `context/source-context.md` before drafting'),
      }),
    );
    expect(window.sessionStorage.getItem(`od:auto-send-first:${project.id}`)).toBe('1');
    expect(onCreated).toHaveBeenCalledWith(system.id);
    expect(onSystemsRefresh).toHaveBeenCalled();
  });

  it('links a local code folder into the design-system project so the agent can read it', async () => {
    const system: DesignSystemDetail = {
      id: 'user:folder-design-system',
      title: 'Folder Design System',
      category: 'Custom',
      summary: 'Folder product workspace.',
      swatches: [],
      surface: 'web',
      body: '# Folder Design System\n',
      source: 'user',
      status: 'draft',
      isEditable: true,
      projectId: 'ds-folder-design-system',
    };
    const project: Project = {
      id: 'ds-folder-design-system',
      name: 'Folder Design System',
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        kind: 'other',
        importedFrom: 'design-system',
        entryFile: 'DESIGN.md',
        sourceFileName: system.id,
      },
    };
    mocks.createDesignSystemDraft.mockResolvedValue(system);
    mocks.ensureDesignSystemWorkspace.mockResolvedValue({ project, files: [] });
    mocks.patchProject.mockResolvedValue({ ...project, pendingPrompt: 'Create this project as a design system.' });
    mocks.openFolderDialog.mockResolvedValue('/Users/qingyu/work/comfyui');

    render(
      <DesignSystemCreationFlow
        onBack={() => {}}
        onCreated={() => {}}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/Mission Impastabowl/i), {
      target: { value: 'ComfyUI: node-based image workflow editor' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Browse folder' }));

    await waitFor(() => expect(screen.getByText('/Users/qingyu/work/comfyui')).toBeTruthy());

    fireEvent.click(screen.getByText('Continue to generation'));
    fireEvent.click(screen.getByText('Generate'));

    await waitFor(() => expect(mocks.patchProject).toHaveBeenCalled());
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        metadata: expect.objectContaining({
          linkedDirs: ['/Users/qingyu/work/comfyui'],
        }),
        pendingPrompt: expect.stringContaining('Read the linked local code folders'),
      }),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('/Users/qingyu/work/comfyui'),
    );
  });

  it('copies browser-selected local code folder files into the design-system project context', async () => {
    const system: DesignSystemDetail = {
      id: 'user:snapshot-design-system',
      title: 'Snapshot Design System',
      category: 'Custom',
      summary: 'Snapshot product workspace.',
      swatches: [],
      surface: 'web',
      body: '# Snapshot Design System\n',
      source: 'user',
      status: 'draft',
      isEditable: true,
      projectId: 'ds-snapshot-design-system',
    };
    const project: Project = {
      id: 'ds-snapshot-design-system',
      name: 'Snapshot Design System',
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        kind: 'other',
        importedFrom: 'design-system',
        entryFile: 'DESIGN.md',
        sourceFileName: system.id,
      },
    };
    mocks.createDesignSystemDraft.mockResolvedValue(system);
    mocks.ensureDesignSystemWorkspace.mockResolvedValue({ project, files: [] });
    mocks.patchProject.mockResolvedValue({ ...project, pendingPrompt: 'Create this project as a design system.' });

    const { container } = render(
      <DesignSystemCreationFlow
        onBack={() => {}}
        onCreated={() => {}}
      />,
    );
    const localCodeInput = container.querySelector('input[webkitdirectory]') as HTMLInputElement | null;
    const tokenFile = new File([':root { --brand: #d86a4a; }'], 'tokens.css', { type: 'text/css' });
    Object.defineProperty(tokenFile, 'webkitRelativePath', { value: 'comfyui/src/tokens.css' });

    fireEvent.change(screen.getByPlaceholderText(/Mission Impastabowl/i), {
      target: { value: 'Snapshot: product UI with tokens' },
    });
    fireEvent.change(localCodeInput!, { target: { files: [tokenFile] } });
    expect(screen.getByText('1 local code files selected')).toBeTruthy();

    fireEvent.click(screen.getByText('Continue to generation'));
    fireEvent.click(screen.getByText('Generate'));

    await waitFor(() => expect(mocks.uploadProjectFile).toHaveBeenCalled());
    expect(mocks.uploadProjectFile).toHaveBeenCalledWith(
      project.id,
      tokenFile,
      'context/local-code/comfyui/src/tokens.css',
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('context/local-code/comfyui/src/tokens.css'),
      }),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('context/local-code/comfyui/src/tokens.css'),
    );
  });

  it('recursively reads a dragged local code folder into the design-system project context', async () => {
    const system: DesignSystemDetail = {
      id: 'user:dragged-folder-design-system',
      title: 'Dragged Folder Design System',
      category: 'Custom',
      summary: 'Dragged folder workspace.',
      swatches: [],
      surface: 'web',
      body: '# Dragged Folder Design System\n',
      source: 'user',
      status: 'draft',
      isEditable: true,
      projectId: 'ds-dragged-folder-design-system',
    };
    const project: Project = {
      id: 'ds-dragged-folder-design-system',
      name: 'Dragged Folder Design System',
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        kind: 'other',
        importedFrom: 'design-system',
        entryFile: 'DESIGN.md',
        sourceFileName: system.id,
      },
    };
    mocks.createDesignSystemDraft.mockResolvedValue(system);
    mocks.ensureDesignSystemWorkspace.mockResolvedValue({ project, files: [] });
    mocks.patchProject.mockResolvedValue({ ...project, pendingPrompt: 'Create this project as a design system.' });

    const { container } = render(
      <DesignSystemCreationFlow
        onBack={() => {}}
        onCreated={() => {}}
      />,
    );
    const dropZone = container.querySelector('input[webkitdirectory]')?.closest('.ds-drop-zone') as HTMLElement | null;
    const tokenFile = new File([':root { --brand: #d86a4a; }'], 'tokens.css', { type: 'text/css' });
    const buttonFile = new File(['export function Button() {}'], 'Button.tsx', { type: 'text/typescript' });
    const srcEntries = [
      { isFile: true, isDirectory: false, name: 'tokens.css', file: (done: (file: File) => void) => done(tokenFile) },
      { isFile: true, isDirectory: false, name: 'Button.tsx', file: (done: (file: File) => void) => done(buttonFile) },
    ];
    const srcDirectory = {
      isFile: false,
      isDirectory: true,
      name: 'src',
      createReader: () => {
        let read = false;
        return {
          readEntries: (done: (entries: typeof srcEntries) => void) => {
            const entries = read ? [] : srcEntries;
            read = true;
            done(entries);
          },
        };
      },
    };
    const rootDirectory = {
      isFile: false,
      isDirectory: true,
      name: 'comfyui',
      createReader: () => {
        let read = false;
        return {
          readEntries: (done: (entries: [typeof srcDirectory] | []) => void) => {
            const entries: [typeof srcDirectory] | [] = read ? [] : [srcDirectory];
            read = true;
            done(entries);
          },
        };
      },
    };

    fireEvent.change(screen.getByPlaceholderText(/Mission Impastabowl/i), {
      target: { value: 'Dragged: product UI with tokens and components' },
    });
    fireEvent.drop(dropZone!, {
      dataTransfer: {
        files: [],
        items: [
          {
            webkitGetAsEntry: () => rootDirectory,
          },
        ],
      },
    });

    await waitFor(() => expect(screen.getByText('2 local code files selected')).toBeTruthy());

    fireEvent.click(screen.getByText('Continue to generation'));
    fireEvent.click(screen.getByText('Generate'));

    await waitFor(() => expect(mocks.uploadProjectFile).toHaveBeenCalledTimes(2));
    expect(mocks.uploadProjectFile).toHaveBeenCalledWith(
      project.id,
      tokenFile,
      'context/local-code/comfyui/src/tokens.css',
    );
    expect(mocks.uploadProjectFile).toHaveBeenCalledWith(
      project.id,
      buttonFile,
      'context/local-code/comfyui/src/Button.tsx',
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('context/local-code/comfyui/src/Button.tsx'),
    );
  });

  it('parses .fig files locally into project context summaries without uploading the source file', async () => {
    const system: DesignSystemDetail = {
      id: 'user:figma-design-system',
      title: 'Figma Design System',
      category: 'Custom',
      summary: 'Figma-backed workspace.',
      swatches: [],
      surface: 'web',
      body: '# Figma Design System\n',
      source: 'user',
      status: 'draft',
      isEditable: true,
      projectId: 'ds-figma-design-system',
    };
    const project: Project = {
      id: 'ds-figma-design-system',
      name: 'Figma Design System',
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        kind: 'other',
        importedFrom: 'design-system',
        entryFile: 'DESIGN.md',
        sourceFileName: system.id,
      },
    };
    mocks.createDesignSystemDraft.mockResolvedValue(system);
    mocks.ensureDesignSystemWorkspace.mockResolvedValue({ project, files: [] });
    mocks.patchProject.mockResolvedValue({ ...project, pendingPrompt: 'Create this project as a design system.' });

    render(
      <DesignSystemCreationFlow
        onBack={() => {}}
        onCreated={() => {}}
      />,
    );
    const figInput = screen
      .getByText('Drop .fig here or browse')
      .closest('label')
      ?.querySelector('input') as HTMLInputElement | null;
    const figFile = new File([
      '{"name":"Primary Button","fontFamily":"Inter","name":"Dashboard Card","fill":"#FF6A3D"}',
    ], 'product-design.fig', { type: 'application/octet-stream' });

    fireEvent.change(screen.getByPlaceholderText(/Mission Impastabowl/i), {
      target: { value: 'Figma: product UI with button and dashboard components' },
    });
    fireEvent.change(figInput!, { target: { files: [figFile] } });
    expect(screen.getByText('product-design.fig')).toBeTruthy();

    fireEvent.click(screen.getByText('Continue to generation'));
    fireEvent.click(screen.getByText('Generate'));

    await waitFor(() => expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/figma/product-design.md',
      expect.stringContaining('Primary Button'),
    ));
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/figma/product-design.md',
      expect.stringContaining('#FF6A3D'),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('context/figma/product-design.md'),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('Use the locally parsed Figma summaries'),
      }),
    );
    expect(mocks.uploadProjectFile).not.toHaveBeenCalled();
  });

  it('uploads brand assets into the design-system project context', async () => {
    const system: DesignSystemDetail = {
      id: 'user:asset-design-system',
      title: 'Asset Design System',
      category: 'Custom',
      summary: 'Asset-backed workspace.',
      swatches: [],
      surface: 'web',
      body: '# Asset Design System\n',
      source: 'user',
      status: 'draft',
      isEditable: true,
      projectId: 'ds-asset-design-system',
    };
    const project: Project = {
      id: 'ds-asset-design-system',
      name: 'Asset Design System',
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        kind: 'other',
        importedFrom: 'design-system',
        entryFile: 'DESIGN.md',
        sourceFileName: system.id,
      },
    };
    mocks.createDesignSystemDraft.mockResolvedValue(system);
    mocks.ensureDesignSystemWorkspace.mockResolvedValue({ project, files: [] });
    mocks.patchProject.mockResolvedValue({ ...project, pendingPrompt: 'Create this project as a design system.' });

    render(
      <DesignSystemCreationFlow
        onBack={() => {}}
        onCreated={() => {}}
      />,
    );
    const assetInput = screen
      .getByText('Drag files here or browse')
      .closest('label')
      ?.querySelector('input') as HTMLInputElement | null;
    const logoFile = new File(['<svg />'], 'logo.svg', { type: 'image/svg+xml' });
    const fontFile = new File(['font-data'], 'brand.woff2', { type: 'font/woff2' });

    fireEvent.change(screen.getByPlaceholderText(/Mission Impastabowl/i), {
      target: { value: 'Assets: product brand with custom logo and font' },
    });
    fireEvent.change(assetInput!, { target: { files: [logoFile, fontFile] } });
    expect(screen.getByText('logo.svg, brand.woff2')).toBeTruthy();

    fireEvent.click(screen.getByText('Continue to generation'));
    fireEvent.click(screen.getByText('Generate'));

    await waitFor(() => expect(mocks.uploadProjectFile).toHaveBeenCalledTimes(2));
    expect(mocks.uploadProjectFile).toHaveBeenCalledWith(project.id, logoFile, 'assets/logo.svg');
    expect(mocks.uploadProjectFile).toHaveBeenCalledWith(project.id, fontFile, 'assets/brand.woff2');
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('assets/logo.svg'),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('Use uploaded brand assets in `assets/`'),
      }),
    );
  });

  it('guides users to configure Composio before GitHub repo links can be added', () => {
    const onOpenConnectorsTab = vi.fn();
    const config = {
      composio: { apiKeyConfigured: false },
    } as AppConfig;

    render(
      <DesignSystemCreationFlow
        onBack={() => {}}
        onCreated={() => {}}
        config={config}
        onOpenConnectorsTab={onOpenConnectorsTab}
      />,
    );

    expect((screen.getByPlaceholderText('https://github.com/owner/repo') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('Composio API key required')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Configure Composio key' }));

    expect(onOpenConnectorsTab).toHaveBeenCalledTimes(1);
    expect(mocks.fetchConnectorDetail).not.toHaveBeenCalled();
  });

  it('unlocks GitHub repo links after the GitHub connector is connected', async () => {
    const availableConnector: ConnectorDetail = {
      id: 'github',
      name: 'GitHub',
      provider: 'Composio',
      category: 'Code',
      status: 'available',
      tools: [],
    };
    const connectedConnector: ConnectorDetail = {
      ...availableConnector,
      status: 'connected',
      accountLabel: 'qiongyu1999',
    };
    mocks.fetchConnectorDetail.mockResolvedValue(availableConnector);
    mocks.connectConnector.mockResolvedValue({
      connector: connectedConnector,
      auth: { kind: 'connected' },
    });
    const config = {
      composio: { apiKeyConfigured: true, apiKeyTail: 'uQEg' },
    } as AppConfig;

    render(
      <DesignSystemCreationFlow
        onBack={() => {}}
        onCreated={() => {}}
        config={config}
      />,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeTruthy());
    expect((screen.getByPlaceholderText('https://github.com/owner/repo') as HTMLInputElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));

    await waitFor(() => expect(mocks.connectConnector).toHaveBeenCalledWith('github'));
    await waitFor(() => expect(screen.getByText('Connected as qiongyu1999')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Configure' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy();
    const input = screen.getByPlaceholderText('https://github.com/owner/repo') as HTMLInputElement;
    expect(input.disabled).toBe(false);

    fireEvent.change(input, { target: { value: 'https://github.com/nexu-io/open-design/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(screen.getByText('nexu-io/open-design')).toBeTruthy();
    expect(input.value).toBe('');
  });

  it('hides Composio connection ids in the connected GitHub label', async () => {
    const connectedConnector: ConnectorDetail = {
      id: 'github',
      name: 'GitHub',
      provider: 'Composio',
      category: 'Code',
      status: 'connected',
      accountLabel: 'ca_6U6mv_8IzMVR',
      tools: [],
    };
    mocks.fetchConnectorDetail.mockResolvedValue(connectedConnector);
    const config = {
      composio: { apiKeyConfigured: true, apiKeyTail: 'uQEg' },
    } as AppConfig;

    render(
      <DesignSystemCreationFlow
        onBack={() => {}}
        onCreated={() => {}}
        config={config}
      />,
    );

    await waitFor(() => expect(screen.getByText('GitHub connected')).toBeTruthy());
    expect(screen.queryByText(/ca_6U6mv_8IzMVR/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Configure' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy();
  });

  it('keeps a manual GitHub authorization action when the automatic popup is blocked', async () => {
    const availableConnector: ConnectorDetail = {
      id: 'github',
      name: 'GitHub',
      provider: 'Composio',
      category: 'Code',
      status: 'available',
      tools: [],
    };
    mocks.fetchConnectorDetail.mockResolvedValue(availableConnector);
    mocks.connectConnector.mockResolvedValue({
      connector: availableConnector,
      auth: {
        kind: 'redirect_required',
        redirectUrl: 'https://example.com/oauth',
        expiresAt: '2099-05-08T10:00:00.000Z',
      },
      error: 'Popup blocked. Allow popups for Open Design and try again.',
    });
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => ({ closed: false } as Window));
    const config = {
      composio: { apiKeyConfigured: true, apiKeyTail: 'uQEg' },
    } as AppConfig;

    try {
      render(
        <DesignSystemCreationFlow
          onBack={() => {}}
          onCreated={() => {}}
          config={config}
        />,
      );

      await waitFor(() => expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));

      await waitFor(() => expect(screen.getByText('GitHub authorization pending')).toBeTruthy());
      expect(screen.getByText('Popup blocked. Allow popups for Open Design and try again.')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Open authorization page' }));

      expect(openSpy).toHaveBeenCalledWith('https://example.com/oauth', '_blank');
    } finally {
      openSpy.mockRestore();
    }
  });

  it('records connected GitHub repository sources in the project source manifest', async () => {
    const availableConnector: ConnectorDetail = {
      id: 'github',
      name: 'GitHub',
      provider: 'Composio',
      category: 'Code',
      status: 'connected',
      accountLabel: 'qiongyu1999',
      tools: [],
    };
    const system: DesignSystemDetail = {
      id: 'user:github-design-system',
      title: 'Github Design System',
      category: 'Custom',
      summary: 'GitHub-backed workspace.',
      swatches: [],
      surface: 'web',
      body: '# Github Design System\n',
      source: 'user',
      status: 'draft',
      isEditable: true,
      projectId: 'ds-github-design-system',
    };
    const project: Project = {
      id: 'ds-github-design-system',
      name: 'Github Design System',
      skillId: null,
      designSystemId: system.id,
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        kind: 'other',
        importedFrom: 'design-system',
        entryFile: 'DESIGN.md',
        sourceFileName: system.id,
      },
    };
    mocks.fetchConnectorDetail.mockResolvedValue(availableConnector);
    mocks.createDesignSystemDraft.mockResolvedValue(system);
    mocks.ensureDesignSystemWorkspace.mockResolvedValue({ project, files: [] });
    mocks.patchProject.mockResolvedValue({ ...project, pendingPrompt: 'Create this project as a design system.' });
    const config = {
      composio: { apiKeyConfigured: true, apiKeyTail: 'uQEg' },
    } as AppConfig;

    render(
      <DesignSystemCreationFlow
        onBack={() => {}}
        onCreated={() => {}}
        config={config}
      />,
    );

    await waitFor(() => expect(screen.getByText('Connected as qiongyu1999')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText(/Mission Impastabowl/i), {
      target: { value: 'GitHub: product workspace' },
    });
    const input = screen.getByPlaceholderText('https://github.com/owner/repo') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://github.com/nexu-io/open-design' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByText('Continue to generation'));
    fireEvent.click(screen.getByText('Generate'));

    await waitFor(() => expect(mocks.writeProjectTextFile).toHaveBeenCalled());
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('Connector status: connected as qiongyu1999.'),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('https://github.com/nexu-io/open-design'),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('GitHub Connector Intake Runbook'),
    );
    expect(mocks.writeProjectTextFile).toHaveBeenCalledWith(
      project.id,
      'context/source-context.md',
      expect.stringContaining('"$OD_NODE_BIN" "$OD_BIN" tools connectors github-design-context --repo \'https://github.com/nexu-io/open-design\' --output context/github/nexu-io-open-design.md --require-connector'),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('GitHub connector intake is required before drafting the design system'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('The intake command uses GitHub connector tools for repository metadata, README, full tree, and raw file contents.'),
      }),
    );
    expect(mocks.patchProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('Do not substitute public GitHub fallback, web browsing, memory, or URL-only inference.'),
      }),
    );
  });
});
