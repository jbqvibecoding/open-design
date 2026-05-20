import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPackageManagerInvocation, readProcessStamp } from "@open-design/platform";
import {
  APP_KEYS,
  OPEN_DESIGN_SIDECAR_CONTRACT,
} from "@open-design/sidecar-proto";

export type DesktopBuildRequest = {
  env?: NodeJS.ProcessEnv;
  workspaceRoot: string;
};

export type DesktopElectronLaunchRequest = {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export type DesktopElectronExit = {
  code: number | null;
  pid: number;
  signal: NodeJS.Signals | null;
};

export function resolveDesktopPackageRoot(moduleUrl = import.meta.url): string {
  let current = dirname(fileURLToPath(moduleUrl));

  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const packageJson = JSON.parse(readFileSync(join(current, "package.json"), "utf8")) as { name?: unknown };
      if (packageJson.name === "@open-design/desktop") return current;
    } catch {
      // Keep walking until the package root is found. This must work from
      // source under tsx and from dist if the launcher is built directly.
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error("failed to resolve @open-design/desktop package root");
}

export function resolveDesktopWorkspaceRoot(packageRoot: string): string {
  return dirname(dirname(packageRoot));
}

export function resolveDesktopMainEntryPath(packageRoot: string): string {
  return join(packageRoot, "dist", "main", "index.js");
}

export function resolveElectronBinaryPath(packageRoot: string): string {
  const require = createRequire(join(packageRoot, "package.json"));
  const electron = require("electron") as unknown;
  if (typeof electron === "string" && electron.length > 0) return electron;
  return require.resolve("electron/cli.js");
}

export function createDesktopElectronEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const nextEnv = { ...env };
  for (const key of Object.keys(nextEnv)) {
    if (key.toUpperCase() === "ELECTRON_RUN_AS_NODE") {
      delete nextEnv[key];
    }
  }
  return nextEnv;
}

export async function runDesktopBuild(request: DesktopBuildRequest): Promise<void> {
  const invocation = createPackageManagerInvocation(
    ["--filter", "@open-design/desktop", "build"],
    request.env ?? process.env,
  );
  const child = spawn(invocation.command, invocation.args, {
    cwd: request.workspaceRoot,
    env: request.env ?? process.env,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: process.platform === "win32",
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });

  await new Promise<void>((resolveRun, rejectRun) => {
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(`command failed: ${invocation.command} ${invocation.args.join(" ")} (${signal ?? code})`));
    });
  });
}

export async function spawnDesktopElectron(request: DesktopElectronLaunchRequest): Promise<DesktopElectronExit> {
  const child = spawn(request.command, request.args, {
    cwd: request.cwd,
    env: request.env,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: process.platform === "win32",
  });

  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once("error", rejectSpawn);
    child.once("spawn", resolveSpawn);
  });

  const forwardSignal = (signal: NodeJS.Signals) => {
    if (child.exitCode != null || child.signalCode != null) return;
    child.kill(signal);
  };
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => forwardSignal(signal);
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  try {
    return await new Promise<DesktopElectronExit>((resolveExit) => {
      child.once("exit", (code, signal) => {
        resolveExit({ code, pid: child.pid ?? 0, signal });
      });
    });
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = signalHandlers.get(signal);
      if (handler != null) process.off(signal, handler);
    }
  }
}

export async function runDesktopDevLauncher(options: {
  electronBinaryPath?: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  packageRoot?: string;
  runBuild?: (request: DesktopBuildRequest) => Promise<void>;
  spawnElectron?: (request: DesktopElectronLaunchRequest) => Promise<DesktopElectronExit>;
  stampArgs?: string[];
  workspaceRoot?: string;
} = {}): Promise<DesktopElectronExit> {
  const stampArgs = options.stampArgs ?? process.argv.slice(2);
  const stamp = readProcessStamp(stampArgs, OPEN_DESIGN_SIDECAR_CONTRACT);
  if (stamp == null) throw new Error("sidecar stamp is required");
  if (stamp.app !== APP_KEYS.DESKTOP) {
    throw new Error(`desktop dev launcher requires desktop stamp, received ${stamp.app}`);
  }

  const packageRoot = options.packageRoot ?? resolveDesktopPackageRoot();
  const workspaceRoot = options.workspaceRoot ?? resolveDesktopWorkspaceRoot(packageRoot);
  const env = options.env ?? process.env;
  const log = options.log ?? console.log;

  log(`[open-design desktop] building @open-design/desktop at ${new Date().toISOString()}`);
  await (options.runBuild ?? runDesktopBuild)({
    workspaceRoot,
    ...(options.env == null ? {} : { env: options.env }),
  });

  const request: DesktopElectronLaunchRequest = {
    args: [resolveDesktopMainEntryPath(packageRoot), ...stampArgs],
    command: options.electronBinaryPath ?? resolveElectronBinaryPath(packageRoot),
    cwd: workspaceRoot,
    env: createDesktopElectronEnv(env),
  };
  log(`[open-design desktop] launching Electron desktop at ${new Date().toISOString()}`);
  const exit = await (options.spawnElectron ?? spawnDesktopElectron)(request);
  if (exit.code != null && exit.code !== 0) {
    throw new Error(`desktop Electron exited with code ${exit.code}`);
  }
  return exit;
}

function isDirectEntry(): boolean {
  const entryPath = process.argv[1];
  if (entryPath == null || entryPath.length === 0 || entryPath.startsWith("--")) return false;

  try {
    return realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  void runDesktopDevLauncher().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
