import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  APP_KEYS,
  OPEN_DESIGN_SIDECAR_CONTRACT,
  SIDECAR_MODES,
  SIDECAR_SOURCES,
} from '@open-design/sidecar-proto';
import { createProcessStampArgs } from '@open-design/platform';
import { describe, expect, it, vi } from 'vitest';

import {
  createDesktopElectronEnv,
  resolveDesktopMainEntryPath,
  runDesktopDevLauncher,
} from '../sidecar/dev-launcher.js';

function createDesktopStampArgs(ipcPath: string): string[] {
  return createProcessStampArgs(
    {
      app: APP_KEYS.DESKTOP,
      ipc: ipcPath,
      mode: SIDECAR_MODES.DEV,
      namespace: 'desktop-dev-launcher-test',
      source: SIDECAR_SOURCES.TOOLS_DEV,
    },
    OPEN_DESIGN_SIDECAR_CONTRACT,
  );
}

describe('desktop dev launcher', () => {
  it('strips Electron-as-Node env before launching Electron', () => {
    expect(createDesktopElectronEnv({ ELECTRON_RUN_AS_NODE: '1', KEEP: 'yes' })).toEqual({ KEEP: 'yes' });
    expect(createDesktopElectronEnv({ Electron_Run_As_Node: '1', KEEP: 'yes' })).toEqual({ KEEP: 'yes' });
  });

  it('builds desktop and launches Electron with the same sidecar stamp args', async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), 'open-design-desktop-dev-launcher-'));
    const workspaceRoot = join(packageRoot, '..', '..');
    const stampArgs = createDesktopStampArgs(join(packageRoot, 'desktop.sock'));
    const runBuild = vi.fn(async () => undefined);
    const spawnElectron = vi.fn(async () => ({ code: 0, pid: 123, signal: null }));
    const log = vi.fn();

    try {
      const exit = await runDesktopDevLauncher({
        electronBinaryPath: '/electron',
        env: { ELECTRON_RUN_AS_NODE: '1', KEEP: 'yes' },
        log,
        packageRoot,
        runBuild,
        spawnElectron,
        stampArgs,
        workspaceRoot,
      });

      expect(exit.pid).toBe(123);
      expect(runBuild).toHaveBeenCalledWith({
        env: { ELECTRON_RUN_AS_NODE: '1', KEEP: 'yes' },
        workspaceRoot,
      });
      expect(spawnElectron).toHaveBeenCalledWith({
        args: [resolveDesktopMainEntryPath(packageRoot), ...stampArgs],
        command: '/electron',
        cwd: workspaceRoot,
        env: { KEEP: 'yes' },
      });
      expect(log).toHaveBeenCalledTimes(2);
    } finally {
      await rm(packageRoot, { force: true, recursive: true });
    }
  });

  it('rejects non-desktop sidecar stamps', async () => {
    const stampArgs = createProcessStampArgs(
      {
        app: APP_KEYS.WEB,
        ipc: '/tmp/web.sock',
        mode: SIDECAR_MODES.DEV,
        namespace: 'desktop-dev-launcher-test',
        source: SIDECAR_SOURCES.TOOLS_DEV,
      },
      OPEN_DESIGN_SIDECAR_CONTRACT,
    );

    await expect(runDesktopDevLauncher({ stampArgs })).rejects.toThrow(/requires desktop stamp/);
  });
});
