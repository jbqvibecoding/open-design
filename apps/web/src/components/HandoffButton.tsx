// Hand-off menu in the ChatPane header. The left split button opens the
// current design project folder in a local editor, while the dropdown also
// exposes copy-to-CLI prompts for handing the same local folder to code agents.

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentInfo,
  HostEditor,
  HostEditorId,
  HostEditorsResponse,
} from '@open-design/contracts';
import { fetchHostEditors, openProjectInEditor } from '../providers/registry';
import { useI18n } from '../i18n';
import { copyToClipboard } from '../lib/copy-to-clipboard';
import { Icon } from './Icon';
import { EditorIcon } from './EditorIcon';
import { AgentIcon } from './AgentIcon';

const PREFERRED_EDITOR_KEY = 'open-design:preferred-editor';
const PREFERRED_FRAMEWORK_KEY = 'open-design:handoff-framework';

interface FrameworkTarget {
  id: string;
  label: string;
  promptLabel: string;
}

const FRAMEWORKS: FrameworkTarget[] = [
  { id: 'react', label: 'React', promptLabel: 'React' },
  { id: 'vue', label: 'Vue.js', promptLabel: 'Vue.js' },
  { id: 'svelte', label: 'Svelte', promptLabel: 'Svelte' },
  { id: 'solid', label: 'SolidJS', promptLabel: 'SolidJS' },
  { id: 'next', label: 'Next.js', promptLabel: 'Next.js / React' },
  { id: 'vanilla', label: 'JS', promptLabel: 'vanilla JavaScript, HTML, and CSS' },
];

const DEFAULT_FRAMEWORK: FrameworkTarget = FRAMEWORKS[0] ?? {
  id: 'react',
  label: 'React',
  promptLabel: 'React',
};

interface CliTarget {
  id: string;
  name: string;
  bin: string;
  available: boolean;
  version?: string | null;
}

const CLI_ORDER = [
  'claude',
  'codex',
  'opencode',
  'cursor-agent',
  'gemini',
  'qwen',
  'qoder',
  'copilot',
  'grok-build',
  'deepseek',
  'kimi',
  'hermes',
  'devin',
  'kiro',
  'kilo',
  'vibe',
  'antigravity',
  'aider',
  'amr',
  'trae-cli',
  'pi',
  'reasonix',
];

const FALLBACK_CLI_TARGETS: CliTarget[] = [
  { id: 'claude', name: 'Claude Code', bin: 'claude', available: false },
  { id: 'codex', name: 'Codex CLI', bin: 'codex', available: false },
  { id: 'opencode', name: 'OpenCode', bin: 'opencode-cli', available: false },
  { id: 'cursor-agent', name: 'Cursor Agent', bin: 'cursor-agent', available: false },
  { id: 'gemini', name: 'Gemini CLI', bin: 'gemini', available: false },
  { id: 'qwen', name: 'Qwen Code', bin: 'qwen', available: false },
  { id: 'qoder', name: 'Qoder CLI', bin: 'qodercli', available: false },
  { id: 'copilot', name: 'GitHub Copilot CLI', bin: 'copilot', available: false },
  { id: 'grok-build', name: 'Grok Build', bin: 'grok', available: false },
  { id: 'deepseek', name: 'DeepSeek TUI', bin: 'deepseek', available: false },
  { id: 'kimi', name: 'Kimi CLI', bin: 'kimi', available: false },
  { id: 'hermes', name: 'Hermes', bin: 'hermes', available: false },
  { id: 'devin', name: 'Devin for Terminal', bin: 'devin', available: false },
  { id: 'kiro', name: 'Kiro CLI', bin: 'kiro-cli', available: false },
  { id: 'kilo', name: 'Kilo', bin: 'kilo', available: false },
  { id: 'vibe', name: 'Mistral Vibe CLI', bin: 'vibe-acp', available: false },
  { id: 'antigravity', name: 'Antigravity', bin: 'agy', available: false },
  { id: 'aider', name: 'Aider', bin: 'aider', available: false },
  { id: 'amr', name: 'Open Design AMR', bin: 'vela', available: false },
  { id: 'trae-cli', name: 'Trae CLI', bin: 'traecli', available: false },
  { id: 'pi', name: 'Pi', bin: 'pi', available: false },
  { id: 'reasonix', name: 'DeepSeek Reasonix', bin: 'reasonix', available: false },
];

interface Props {
  projectId: string;
  projectName?: string;
  projectDir?: string | null;
  agents?: AgentInfo[];
  // Optional fallback "always open in OS file manager" — falls back to the
  // existing shell.openPath bridge in case the daemon catalogue is empty
  // (highly unlikely on macOS / Win / Linux but harmless to support).
  onRequestRevealInFinder?: () => void;
}

function readPreferred(): HostEditorId | null {
  try {
    const v = window.localStorage.getItem(PREFERRED_EDITOR_KEY);
    return (v as HostEditorId) || null;
  } catch {
    return null;
  }
}

function writePreferred(id: HostEditorId): void {
  try {
    window.localStorage.setItem(PREFERRED_EDITOR_KEY, id);
  } catch {
    // ignore — quota or sandboxed
  }
}

function readPreferredFramework(): string {
  if (typeof window === 'undefined') return DEFAULT_FRAMEWORK.id;
  try {
    const stored = window.localStorage.getItem(PREFERRED_FRAMEWORK_KEY);
    if (stored && FRAMEWORKS.some((f) => f.id === stored)) return stored;
  } catch {
    // ignore
  }
  return DEFAULT_FRAMEWORK.id;
}

function writePreferredFramework(id: string): void {
  try {
    window.localStorage.setItem(PREFERRED_FRAMEWORK_KEY, id);
  } catch {
    // ignore — quota or sandboxed
  }
}

function cliDisplayName(agent: Pick<CliTarget, 'id' | 'name'>): string {
  return agent.id === 'amr' ? 'Open Design AMR' : agent.name;
}

function mergeCliTargets(agents: AgentInfo[] | undefined): CliTarget[] {
  const byId = new Map<string, CliTarget>();
  for (const target of FALLBACK_CLI_TARGETS) {
    byId.set(target.id, target);
  }
  for (const agent of agents ?? []) {
    byId.set(agent.id, {
      id: agent.id,
      name: cliDisplayName(agent),
      bin: agent.bin,
      available: agent.available,
      version: agent.version,
    });
  }
  return [...byId.values()].sort((a, b) => {
    const ai = CLI_ORDER.indexOf(a.id);
    const bi = CLI_ORDER.indexOf(b.id);
    const ao = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
    const bo = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
    if (ao !== bo) return ao - bo;
    return cliDisplayName(a).localeCompare(cliDisplayName(b));
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function uiCopy(locale: string) {
  if (locale === 'zh-TW') {
    return {
      editorSection: '透過編輯器開啟',
      cliSection: '複製給 CLI',
      framework: '目標框架',
      copyPrompt: '複製提示詞',
      copied: '已複製',
      notInstalled: '未安裝',
      unavailablePath: '尚未取得專案本機路徑，請稍後再試。',
      copyFailed: '瀏覽器拒絕寫入剪貼簿，請稍後再試。',
      promptIntro: '請基於這個 Open Design 專案的本機資料夾繼續實作：',
      target: '目標',
      stepsLead: '你現在是在 {cli} 中接手，請：',
      readFiles: '先進入或讀取這個目錄，優先閱讀 DESIGN.md、README、現有 HTML/CSS/JS、素材和 package.json（如果存在）。',
      keepDesign: '保持目前的視覺、佈局、互動和素材，不要只描述方案。',
      produceCode: '產出或修改真實可執行的 {framework} 程式碼；如果專案已有更明確的工程棧，先說明衝突並優先保持可執行。',
      verify: '完成後告訴我執行、預覽和驗證命令。',
      commandHint: '如果要先切到專案目錄，可以用：',
      project: '專案',
    };
  }
  if (locale.startsWith('zh')) {
    return {
      editorSection: '通过编辑器打开',
      cliSection: '复制给 CLI',
      framework: '目标框架',
      copyPrompt: '复制提示词',
      copied: '已复制',
      notInstalled: '未安装',
      unavailablePath: '还没有拿到项目本地路径，请稍后再试。',
      copyFailed: '浏览器拒绝写入剪贴板，请稍后再试。',
      promptIntro: '请基于这个 Open Design 项目的本地文件夹继续实现：',
      target: '目标',
      stepsLead: '你现在是在 {cli} 中接手，请：',
      readFiles: '先进入或读取这个目录，优先阅读 DESIGN.md、README、现有 HTML/CSS/JS、素材和 package.json（如果存在）。',
      keepDesign: '保持现有视觉、布局、交互和素材，不要只描述方案。',
      produceCode: '生成或修改真实可运行的 {framework} 代码；如果项目已有更明确的工程栈，先说明冲突并优先保持可运行。',
      verify: '完成后告诉我运行、预览和验证命令。',
      commandHint: '如果要先切到项目目录，可以用：',
      project: '项目',
    };
  }
  return {
    editorSection: 'Open with editor',
    cliSection: 'Copy for CLI',
    framework: 'Target stack',
    copyPrompt: 'Copy prompt',
    copied: 'Copied',
    notInstalled: 'Not installed',
    unavailablePath: 'Project path is still loading. Try again in a moment.',
    copyFailed: 'Clipboard write was blocked. Try again in a moment.',
    promptIntro: 'Continue from this local Open Design project folder:',
    target: 'Target',
    stepsLead: 'You are taking over in {cli}. Please:',
    readFiles: 'Enter or read this directory first. Prioritize DESIGN.md, README, existing HTML/CSS/JS, assets, and package.json if present.',
    keepDesign: 'Preserve the current visual design, layout, interactions, and assets. Do not stop at a plan.',
    produceCode: 'Generate or modify real runnable {framework} code. If the project already has a clearer stack, call out the conflict and keep the result runnable.',
    verify: 'Finish by telling me the run, preview, and verification commands.',
    commandHint: 'To start from the project directory, use:',
    project: 'Project',
  };
}

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`);
}

function buildCliHandoffPrompt({
  cli,
  framework,
  labels,
  projectDir,
  projectId,
  projectName,
}: {
  cli: CliTarget;
  framework: FrameworkTarget;
  labels: ReturnType<typeof uiCopy>;
  projectDir: string;
  projectId: string;
  projectName?: string;
}): string {
  const name = projectName?.trim() || projectId;
  return `${labels.promptIntro}

\`\`\`
${projectDir}
\`\`\`

${labels.target}: ${framework.promptLabel}
CLI: ${cliDisplayName(cli)}${cli.bin ? ` (${cli.bin})` : ''}

${interpolate(labels.stepsLead, { cli: cliDisplayName(cli) })}
1. ${labels.readFiles}
2. ${labels.keepDesign}
3. ${interpolate(labels.produceCode, { framework: framework.promptLabel })}
4. ${labels.verify}

${labels.commandHint}

\`\`\`bash
cd ${shellQuote(projectDir)}
\`\`\`

${labels.project}: ${name}
Project ID: ${projectId}
`;
}

export function HandoffButton({
  projectId,
  projectName,
  projectDir,
  agents,
  onRequestRevealInFinder,
}: Props) {
  const { locale, t } = useI18n();
  const labels = uiCopy(locale);
  const [editors, setEditors] = useState<HostEditor[]>([]);
  const [platform, setPlatform] = useState<HostEditorsResponse['platform']>('unknown');
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<HostEditorId | null>(null);
  const [copyBusy, setCopyBusy] = useState<string | null>(null);
  const [copiedCliId, setCopiedCliId] = useState<string | null>(null);
  const [frameworkId, setFrameworkId] = useState(readPreferredFramework);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const copiedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchHostEditors()
      .then((resp) => {
        if (cancelled) return;
        setEditors(resp.editors);
        setPlatform(resp.platform);
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setEditors([]);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
    };
  }, []);

  const available = editors.filter((e) => e.available);
  const unavailable = editors.filter((e) => !e.available);
  const preferred = readPreferred();
  const primary =
    available.find((e) => e.id === preferred) ?? available[0] ?? null;
  const primaryTitle = primary
    ? t('handoff.openInTarget', { target: primary.label })
    : t('handoff.action');
  const editorTargets = [...available, ...unavailable];
  const cliTargets = useMemo(() => mergeCliTargets(agents), [agents]);
  const selectedFramework =
    FRAMEWORKS.find((framework) => framework.id === frameworkId) ?? DEFAULT_FRAMEWORK;

  async function launch(editor: HostEditor) {
    if (!editor.available) {
      // Still try — the user might have an unprobed path (e.g. macOS
      // bundle in /Applications). The daemon will return 409 if it
      // genuinely can't find it.
    }
    setError(null);
    setBusy(editor.id);
    setOpen(false);
    writePreferred(editor.id);
    try {
      await openProjectInEditor(projectId, editor.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      // Fallback: if Finder is the user's pick and the daemon spawn
      // failed, try the renderer-side reveal-in-finder bridge.
      if (editor.id === 'finder' && onRequestRevealInFinder) {
        try {
          onRequestRevealInFinder();
        } catch {
          // ignore
        }
      }
    } finally {
      setBusy(null);
    }
  }

  async function copyCliPrompt(cli: CliTarget) {
    if (!projectDir) {
      setError(labels.unavailablePath);
      return;
    }
    setError(null);
    setCopyBusy(cli.id);
    const prompt = buildCliHandoffPrompt({
      cli,
      framework: selectedFramework,
      labels,
      projectDir,
      projectId,
      projectName,
    });
    try {
      const copied = await copyToClipboard(prompt);
      if (!copied) {
        setError(labels.copyFailed);
        return;
      }
      setCopiedCliId(cli.id);
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = window.setTimeout(() => {
        setCopiedCliId(null);
        copiedTimerRef.current = null;
      }, 1800);
    } finally {
      setCopyBusy(null);
    }
  }

  if (!loaded) {
    return null;
  }

  // No available editors — render a Finder/Explorer/File-Manager single-button
  // fallback so the surface is never blank, including the true zero-editor
  // response where the daemon reports `editors: []`.
  if (available.length === 0) {
    const fallbackLabel = platform === 'win32' ? 'Explorer' : platform === 'linux' ? 'File Manager' : 'Finder';
    const fallbackId: HostEditorId =
      platform === 'win32' ? 'explorer' : platform === 'linux' ? 'file-manager' : 'finder';
    // Wrap the solo button so a daemon spawn failure can surface an
    // inline error next to it — without this, ProjectView's
    // `<HandoffButton projectId={…} />` (no reveal callback) turns a
    // rejected `openProjectInEditor` into a silent no-op.
    return (
      <div className="handoff-wrap handoff-wrap--solo" data-testid="handoff-wrap">
        <button
          type="button"
          className="handoff-trigger handoff-trigger--solo"
          title={t('handoff.fallbackTitle', { target: fallbackLabel })}
          disabled={busy === fallbackId}
          onClick={() => {
            // The fallback opens the project folder in the OS file manager.
            // finder / explorer / file-manager are real entries in the daemon's
            // open-in catalogue (open / explorer / xdg-open), so this performs a
            // genuine reveal rather than a no-op; the renderer reveal bridge is a
            // secondary fallback if the daemon spawn fails.
            setError(null);
            setBusy(fallbackId);
            void openProjectInEditor(projectId, fallbackId)
              .catch((err) => {
                setError(err instanceof Error ? err.message : String(err));
                onRequestRevealInFinder?.();
              })
              .finally(() => setBusy(null));
          }}
        >
          <EditorIcon editorId={fallbackId} size={20} />
          <span className="handoff-trigger-label">{fallbackLabel}</span>
        </button>
        {error ? (
          <div className="handoff-menu-error" role="alert" data-testid="handoff-fallback-error">
            {error}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={`handoff-wrap${open ? ' open' : ''}`}
      ref={wrapRef}
      data-testid="handoff-wrap"
    >
      {/* Split control: the labeled left side launches the preferred
          editor, the right caret opens the picker. Sibling buttons
          (instead of a nested caret) so the caret has its own real
          tap target and so we don't render an invalid button-in-button. */}
      <div className="handoff-split">
        <button
          type="button"
          className="handoff-trigger"
          data-testid="handoff-trigger"
          title={primaryTitle}
          aria-label={primaryTitle}
          onClick={() => {
            if (primary && busy !== primary.id) {
              void launch(primary);
            } else {
              setOpen((v) => !v);
            }
          }}
          disabled={busy !== null}
        >
          {primary ? (
            <>
              <EditorIcon editorId={primary.id} size={20} />
              <span className="handoff-trigger-label sr-only">
                {primaryTitle}
              </span>
            </>
          ) : (
            <>
              <EditorIcon editorId="finder" size={20} />
              <span className="handoff-trigger-label sr-only">{primaryTitle}</span>
            </>
          )}
        </button>
        <button
          type="button"
          className="handoff-caret"
          aria-label={t('handoff.chooseTargetAria')}
          data-testid="handoff-caret"
          onClick={() => setOpen((v) => !v)}
          disabled={busy !== null}
        >
          <Icon name="chevron-down" size={14} />
        </button>
      </div>
      {open ? (
        <div className="handoff-menu" role="menu" data-testid="handoff-menu">
          <section className="handoff-menu-block">
            <div className="handoff-menu-title">{labels.editorSection}</div>
            <div className="handoff-target-rail handoff-editor-rail">
              {editorTargets.map((editor) => (
                <button
                  key={editor.id}
                  type="button"
                  className={[
                    'handoff-menu-item',
                    'handoff-target-card',
                    editor.id === preferred ? 'active' : '',
                    editor.available ? '' : 'dim',
                  ].filter(Boolean).join(' ')}
                  role="menuitem"
                  data-testid={`handoff-menu-item-${editor.id}`}
                  onClick={() => void launch(editor)}
                  disabled={busy === editor.id}
                  title={
                    editor.available
                      ? t('handoff.openInTarget', { target: editor.label })
                      : t('handoff.notDetectedTitle', { target: editor.label })
                  }
                >
                  <EditorIcon editorId={editor.id} size={24} />
                  <span className="handoff-target-label">{editor.label}</span>
                  {!editor.available ? (
                    <span className="handoff-target-meta">{t('handoff.notInstalled')}</span>
                  ) : null}
                  {editor.id === preferred ? (
                    <Icon name="check" size={12} />
                  ) : null}
                </button>
              ))}
            </div>
          </section>
          <section className="handoff-menu-block">
            <div className="handoff-menu-title">{labels.cliSection}</div>
            <div className="handoff-framework-row" role="group" aria-label={labels.framework}>
              <span className="handoff-framework-label">{labels.framework}</span>
              {FRAMEWORKS.map((framework) => (
                <button
                  key={framework.id}
                  type="button"
                  className={`handoff-framework-chip${framework.id === selectedFramework.id ? ' active' : ''}`}
                  aria-pressed={framework.id === selectedFramework.id}
                  onClick={() => {
                    setFrameworkId(framework.id);
                    writePreferredFramework(framework.id);
                  }}
                >
                  {framework.label}
                </button>
              ))}
            </div>
            <div className="handoff-target-rail handoff-cli-rail">
              {cliTargets.map((cli) => {
                const copied = copiedCliId === cli.id;
                return (
                  <button
                    key={cli.id}
                    type="button"
                    className={[
                      'handoff-menu-item',
                      'handoff-target-card',
                      'handoff-cli-card',
                      cli.available ? '' : 'dim',
                      copied ? 'copied' : '',
                    ].filter(Boolean).join(' ')}
                    role="menuitem"
                    data-testid={`handoff-cli-item-${cli.id}`}
                    onClick={() => void copyCliPrompt(cli)}
                    disabled={copyBusy === cli.id}
                    title={`${labels.copyPrompt}: ${cliDisplayName(cli)}`}
                  >
                    <AgentIcon id={cli.id} size={24} />
                    <span className="handoff-target-label">{cliDisplayName(cli)}</span>
                    <span className="handoff-target-meta">
                      {copied ? labels.copied : cli.available ? labels.copyPrompt : labels.notInstalled}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
          {error ? (
            <>
              <div className="handoff-menu-divider" />
              <div className="handoff-menu-error">{error}</div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
