// Design-system registry. Scans <projectRoot>/design-systems/* for DESIGN.md
// files. Title comes from the first H1. Category comes from a
// `> Category: <name>` blockquote line beneath the H1. Summary is the first
// paragraph between the H1 and the next heading (Category line stripped).

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type DesignSystemSurface = 'web' | 'image' | 'video' | 'audio';
export type DesignSystemSource = 'built-in' | 'installed' | 'user';
export type DesignSystemStatus = 'draft' | 'published';
export type DesignSystemRevisionStatus = 'pending' | 'accepted' | 'rejected';
export type DesignSystemArtifactMode = 'generated' | 'agent-managed';

export type DesignSystemSummary = {
  id: string;
  title: string;
  category: string;
  summary: string;
  swatches: string[];
  surface: DesignSystemSurface;
  body: string;
  source: DesignSystemSource;
  status: DesignSystemStatus;
  isEditable: boolean;
  createdAt?: string;
  updatedAt?: string;
  provenance?: DesignSystemProvenance;
  projectId?: string;
};

export type DesignSystemFileKind =
  | 'folder'
  | 'page'
  | 'stylesheet'
  | 'document'
  | 'image'
  | 'data'
  | 'asset';

export type DesignSystemFileSummary = {
  path: string;
  name: string;
  kind: DesignSystemFileKind;
  size?: number;
  updatedAt?: string;
};

export type DesignSystemFileDetail = DesignSystemFileSummary & {
  content: string;
};

export type DesignSystemRevision = {
  id: string;
  designSystemId: string;
  status: DesignSystemRevisionStatus;
  feedback: string;
  baseBody: string;
  proposedBody: string;
  createdAt: string;
  updatedAt: string;
  sectionTitle?: string;
  jobId?: string;
};

type ColorToken = { name: string; value: string };

export type DesignSystemProvenance = {
  companyBlurb?: string;
  githubUrls?: string[];
  localCodeFiles?: string[];
  figFiles?: string[];
  assetFiles?: string[];
  notes?: string;
  sourceNotes?: string;
};

type UserDesignSystemMetadata = {
  title?: string;
  category?: string;
  surface?: DesignSystemSurface;
  status?: DesignSystemStatus;
  artifactMode?: DesignSystemArtifactMode;
  createdAt?: string;
  updatedAt?: string;
  provenance?: DesignSystemProvenance;
  projectId?: string;
};

export type UserDesignSystemInput = {
  title?: string;
  summary?: string;
  category?: string;
  surface?: DesignSystemSurface;
  status?: DesignSystemStatus;
  artifactMode?: DesignSystemArtifactMode;
  body?: string;
  sourceNotes?: string;
  provenance?: DesignSystemProvenance;
};

export type UserDesignSystemRevisionInput = {
  feedback: string;
  baseBody: string;
  proposedBody: string;
  sectionTitle?: string;
  jobId?: string;
};

export type DesignSystemListOptions = {
  idPrefix?: string;
  source?: DesignSystemSource;
  isEditable?: boolean;
  defaultStatus?: DesignSystemStatus;
};

export async function listDesignSystems(
  root: string,
  options: DesignSystemListOptions = {},
): Promise<DesignSystemSummary[]> {
  const out: DesignSystemSummary[] = [];
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const designPath = path.join(root, entry.name, 'DESIGN.md');
    try {
      const stats = await stat(designPath);
      if (!stats.isFile()) continue;
      const raw = await readFile(designPath, 'utf8');
      const metadata = await readUserMetadata(root, entry.name);
      const titleMatch = /^#\s+(.+?)\s*$/m.exec(raw);
      const title = cleanTitle(metadata.title ?? titleMatch?.[1] ?? entry.name);
      out.push({
        id: `${options.idPrefix ?? ''}${entry.name}`,
        title,
        category: metadata.category ?? extractCategory(raw) ?? 'Uncategorized',
        summary: summarize(raw),
        swatches: extractSwatches(raw),
        surface: metadata.surface ?? extractSurface(raw),
        body: raw,
        source: options.source ?? 'built-in',
        status: metadata.status ?? options.defaultStatus ?? 'published',
        isEditable: options.isEditable ?? false,
        ...(metadata.createdAt ? { createdAt: metadata.createdAt } : {}),
        ...(metadata.updatedAt ? { updatedAt: metadata.updatedAt } : {}),
        ...(metadata.provenance ? { provenance: metadata.provenance } : {}),
        ...(metadata.projectId ? { projectId: metadata.projectId } : {}),
      });
    } catch {
      // Skip.
    }
  }
  return out;
}

export async function readDesignSystem(
  root: string,
  id: string,
  options: { idPrefix?: string } = {},
): Promise<string | null> {
  const dirId = stripPrefixAndValidateId(id, options.idPrefix);
  if (!dirId) return null;
  const file = path.join(root, dirId, 'DESIGN.md');
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Structured (compiled) form of a brand's design system. Optional sibling
 * files alongside DESIGN.md that, when present, give agents a
 * machine-readable token contract and a worked fixture instead of having
 * to re-derive both from prose.
 */
export type DesignSystemAssets = {
  tokensCss?: string | undefined;
  fixtureHtml?: string | undefined;
};

export async function readDesignSystemAssets(
  root: string,
  id: string,
): Promise<DesignSystemAssets> {
  const dirId = stripPrefixAndValidateId(id, id.startsWith('user:') ? 'user:' : '');
  if (!dirId) return {};
  const [tokensCss, fixtureHtml] = await Promise.all([
    readFileOptional(path.join(root, dirId, 'tokens.css')),
    readFileOptional(path.join(root, dirId, 'components.html')),
  ]);
  return { tokensCss, fixtureHtml };
}

export function isDesignTokenChannelEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.OD_DESIGN_TOKEN_CHANNEL !== '0';
}

export async function resolveDesignSystemAssets(
  designSystemId: string,
  builtInRoot: string,
  userInstalledRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DesignSystemAssets> {
  if (!isDesignTokenChannelEnabled(env)) {
    return { tokensCss: undefined, fixtureHtml: undefined };
  }

  const builtIn = await readDesignSystemAssets(builtInRoot, designSystemId);
  if (builtIn.tokensCss !== undefined && builtIn.fixtureHtml !== undefined) {
    return builtIn;
  }

  const userInstalled = await readDesignSystemAssets(userInstalledRoot, designSystemId);
  return {
    tokensCss: builtIn.tokensCss ?? userInstalled.tokensCss,
    fixtureHtml: builtIn.fixtureHtml ?? userInstalled.fixtureHtml,
  };
}

export async function createUserDesignSystem(
  root: string,
  input: UserDesignSystemInput,
): Promise<DesignSystemSummary> {
  const title = normalizeTitle(input.title);
  const dirId = await uniqueSlug(root, slugify(title));
  const now = new Date().toISOString();
  const provenance = normalizeProvenance(input.provenance, {
    ...(input.summary ? { companyBlurb: input.summary } : {}),
    ...(input.sourceNotes ? { sourceNotes: input.sourceNotes } : {}),
  });
  const sourceNotes = provenanceToNotes(provenance) || cleanMultiline(input.sourceNotes);
  const body = normalizeBody(input.body) ?? buildDraftDesignSystemBody({
    ...input,
    title,
    sourceNotes,
  });
  await mkdir(path.join(root, dirId), { recursive: true });
  await writeFile(path.join(root, dirId, 'DESIGN.md'), body, 'utf8');
  const artifactMode = normalizeArtifactMode(input.artifactMode);
  await writeUserMetadata(root, dirId, {
    title,
    category: cleanText(input.category) || extractCategory(body) || 'Custom',
    surface: input.surface ?? extractSurface(body),
    status: input.status ?? 'draft',
    ...(artifactMode ? { artifactMode } : {}),
    createdAt: now,
    updatedAt: now,
    ...(provenance ? { provenance } : {}),
  });
  if (artifactMode !== 'agent-managed') {
    await writeGeneratedDesignSystemFiles(root, dirId, {
      title,
      category: cleanText(input.category) || extractCategory(body) || 'Custom',
      surface: input.surface ?? extractSurface(body),
      summary: summarize(body),
      ...(provenance ? { provenance } : {}),
      ...(sourceNotes ? { sourceNotes } : {}),
      body,
    });
  }
  const listed = await listDesignSystems(root, {
    idPrefix: 'user:',
    source: 'user',
    isEditable: true,
    defaultStatus: 'draft',
  });
  return listed.find((s) => s.id === `user:${dirId}`)!;
}

export async function updateUserDesignSystem(
  root: string,
  id: string,
  input: UserDesignSystemInput,
): Promise<DesignSystemSummary | null> {
  const dirId = stripPrefixAndValidateId(id, 'user:');
  if (!dirId) return null;
  const dir = path.join(root, dirId);
  const designPath = path.join(dir, 'DESIGN.md');
  let existingBody: string;
  try {
    existingBody = await readFile(designPath, 'utf8');
  } catch {
    return null;
  }
  const existingMeta = await readUserMetadata(root, dirId);
  const now = new Date().toISOString();
  const title = normalizeTitle(input.title ?? existingMeta.title ?? firstHeading(existingBody) ?? dirId);
  const category = cleanText(input.category) || existingMeta.category || extractCategory(existingBody) || 'Custom';
  const surface = input.surface ?? existingMeta.surface ?? extractSurface(existingBody);
  const nextProvenance = normalizeProvenance(input.provenance, {
    ...(input.sourceNotes ? { sourceNotes: input.sourceNotes } : {}),
  });
  const provenance = nextProvenance ?? existingMeta.provenance;
  const artifactMode = normalizeArtifactMode(input.artifactMode) ?? existingMeta.artifactMode;
  const body =
    normalizeBody(input.body)
    ?? withDesignSystemHeader(existingBody, { title, category, surface });
  await writeFile(designPath, body, 'utf8');
  await writeUserMetadata(root, dirId, {
    ...existingMeta,
    title,
    category,
    surface,
    status: input.status ?? existingMeta.status ?? 'draft',
    ...(artifactMode ? { artifactMode } : {}),
    createdAt: existingMeta.createdAt ?? now,
    updatedAt: now,
    ...(provenance ? { provenance } : {}),
  });
  const sourceNotes = provenanceToNotes(provenance) || cleanMultiline(input.sourceNotes);
  if (artifactMode !== 'agent-managed') {
    await writeGeneratedDesignSystemFiles(root, dirId, {
      title,
      category,
      surface,
      summary: summarize(body),
      ...(provenance ? { provenance } : {}),
      ...(sourceNotes ? { sourceNotes } : {}),
      body,
    });
  }
  const listed = await listDesignSystems(root, {
    idPrefix: 'user:',
    source: 'user',
    isEditable: true,
    defaultStatus: 'draft',
  });
  return listed.find((s) => s.id === `user:${dirId}`) ?? null;
}

export async function linkUserDesignSystemProject(
  root: string,
  id: string,
  projectId: string,
): Promise<DesignSystemSummary | null> {
  const dirId = stripPrefixAndValidateId(id, 'user:');
  const cleanProjectId = cleanProjectIdForMetadata(projectId);
  if (!dirId || !cleanProjectId) return null;
  try {
    const stats = await stat(path.join(root, dirId, 'DESIGN.md'));
    if (!stats.isFile()) return null;
  } catch {
    return null;
  }
  const existingMeta = await readUserMetadata(root, dirId);
  await writeUserMetadata(root, dirId, {
    ...existingMeta,
    projectId: cleanProjectId,
  });
  const listed = await listDesignSystems(root, {
    idPrefix: 'user:',
    source: 'user',
    isEditable: true,
    defaultStatus: 'draft',
  });
  return listed.find((s) => s.id === `user:${dirId}`) ?? null;
}

export async function createUserDesignSystemRevision(
  root: string,
  id: string,
  input: UserDesignSystemRevisionInput,
): Promise<DesignSystemRevision | null> {
  const dirId = stripPrefixAndValidateId(id, 'user:');
  if (!dirId) return null;
  const dir = path.join(root, dirId);
  try {
    const stats = await stat(path.join(dir, 'DESIGN.md'));
    if (!stats.isFile()) return null;
  } catch {
    return null;
  }
  const feedback = cleanMultiline(input.feedback);
  const baseBody = normalizeBody(input.baseBody);
  const proposedBody = normalizeBody(input.proposedBody);
  if (!feedback || !baseBody || !proposedBody) return null;
  const now = new Date().toISOString();
  const revision: DesignSystemRevision = {
    id: randomUUID(),
    designSystemId: `user:${dirId}`,
    status: 'pending',
    feedback,
    baseBody,
    proposedBody,
    createdAt: now,
    updatedAt: now,
    ...(cleanText(input.sectionTitle) ? { sectionTitle: cleanText(input.sectionTitle) } : {}),
    ...(input.jobId ? { jobId: input.jobId } : {}),
  };
  await writeUserDesignSystemRevision(root, dirId, revision);
  return revision;
}

export async function listUserDesignSystemRevisions(
  root: string,
  id: string,
): Promise<DesignSystemRevision[] | null> {
  const dirId = stripPrefixAndValidateId(id, 'user:');
  if (!dirId) return null;
  try {
    const stats = await stat(path.join(root, dirId, 'DESIGN.md'));
    if (!stats.isFile()) return null;
  } catch {
    return null;
  }
  let entries = [];
  try {
    entries = await readdir(path.join(root, dirId, 'revisions'), { withFileTypes: true });
  } catch {
    return [];
  }
  const revisions: DesignSystemRevision[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const revisionId = entry.name.slice(0, -'.json'.length);
    const revision = await readUserDesignSystemRevision(root, id, revisionId);
    if (revision) revisions.push(revision);
  }
  return revisions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function readUserDesignSystemRevision(
  root: string,
  id: string,
  revisionId: string,
): Promise<DesignSystemRevision | null> {
  const dirId = stripPrefixAndValidateId(id, 'user:');
  const cleanRevisionId = sanitizeRevisionId(revisionId);
  if (!dirId || !cleanRevisionId) return null;
  try {
    const raw = await readFile(
      path.join(root, dirId, 'revisions', `${cleanRevisionId}.json`),
      'utf8',
    );
    return parseDesignSystemRevision(JSON.parse(raw), `user:${dirId}`);
  } catch {
    return null;
  }
}

export async function updateUserDesignSystemRevisionStatus(
  root: string,
  id: string,
  revisionId: string,
  status: Extract<DesignSystemRevisionStatus, 'accepted' | 'rejected'>,
): Promise<DesignSystemRevision | null> {
  const dirId = stripPrefixAndValidateId(id, 'user:');
  if (!dirId) return null;
  const revision = await readUserDesignSystemRevision(root, id, revisionId);
  if (!revision) return null;
  if (status === 'accepted') {
    const updated = await updateUserDesignSystem(root, id, {
      body: revision.proposedBody,
    });
    if (!updated) return null;
  }
  const next: DesignSystemRevision = {
    ...revision,
    status,
    updatedAt: new Date().toISOString(),
  };
  await writeUserDesignSystemRevision(root, dirId, next);
  return next;
}

export async function deleteUserDesignSystem(root: string, id: string): Promise<boolean> {
  const dirId = stripPrefixAndValidateId(id, 'user:');
  if (!dirId) return false;
  try {
    await rm(path.join(root, dirId), { recursive: true, force: false });
    return true;
  } catch {
    return false;
  }
}

export async function listUserDesignSystemFiles(
  root: string,
  id: string,
): Promise<DesignSystemFileSummary[] | null> {
  const dirId = stripPrefixAndValidateId(id, 'user:');
  if (!dirId) return null;
  const base = path.join(root, dirId);
  try {
    const baseStats = await stat(base);
    if (!baseStats.isDirectory()) return null;
  } catch {
    return null;
  }
  await ensureGeneratedDesignSystemFiles(root, dirId);
  const files: DesignSystemFileSummary[] = [];
  await collectDesignSystemFiles(base, '', files);
  return files.sort((a, b) => {
    if (a.kind === 'folder' && b.kind !== 'folder') return -1;
    if (a.kind !== 'folder' && b.kind === 'folder') return 1;
    return a.path.localeCompare(b.path);
  });
}

export async function readUserDesignSystemFile(
  root: string,
  id: string,
  relativePath: string,
): Promise<DesignSystemFileDetail | null> {
  const dirId = stripPrefixAndValidateId(id, 'user:');
  const cleanPath = sanitizeRelativeFilePath(relativePath);
  if (!dirId || !cleanPath) return null;
  const base = path.join(root, dirId);
  const resolvedBase = path.resolve(base);
  const filePath = path.resolve(base, cleanPath);
  if (filePath !== resolvedBase && !filePath.startsWith(`${resolvedBase}${path.sep}`))
    return null;
  await ensureGeneratedDesignSystemFiles(root, dirId);
  try {
    const stats = await stat(filePath);
    if (!stats.isFile()) return null;
    const content = await readFile(filePath, 'utf8');
    return {
      path: cleanPath,
      name: path.basename(cleanPath),
      kind: classifyDesignSystemFile(cleanPath, false),
      size: stats.size,
      updatedAt: stats.mtime.toISOString(),
      content,
    };
  } catch {
    return null;
  }
}

async function ensureGeneratedDesignSystemFiles(root: string, id: string): Promise<void> {
  try {
    const existing = await stat(path.join(root, id, 'README.md'));
    if (existing.isFile()) return;
  } catch {
    // Generate the derived review files below.
  }
  try {
    const body = await readFile(path.join(root, id, 'DESIGN.md'), 'utf8');
    const metadata = await readUserMetadata(root, id);
    const title = normalizeTitle(metadata.title ?? firstHeading(body) ?? id);
    const category = metadata.category ?? extractCategory(body) ?? 'Custom';
    const surface = metadata.surface ?? extractSurface(body);
    await writeGeneratedDesignSystemFiles(root, id, {
      title,
      category,
      surface,
      summary: summarize(body),
      ...(metadata.provenance ? { provenance: metadata.provenance } : {}),
      ...(metadata.provenance ? { sourceNotes: provenanceToNotes(metadata.provenance) } : {}),
      body,
    });
  } catch {
    // Listing/reading still returns whatever exists.
  }
}

async function collectDesignSystemFiles(
  base: string,
  relativeDir: string,
  files: DesignSystemFileSummary[],
): Promise<void> {
  const dir = path.join(base, relativeDir);
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (!relativeDir && (entry.name === 'metadata.json' || entry.name === 'revisions')) continue;
    const relativePath = relativeDir
      ? path.posix.join(relativeDir.replaceAll(path.sep, '/'), entry.name)
      : entry.name;
    const fullPath = path.join(base, relativePath);
    const stats = await stat(fullPath);
    files.push({
      path: relativePath,
      name: entry.name,
      kind: classifyDesignSystemFile(relativePath, entry.isDirectory()),
      ...(entry.isDirectory() ? {} : { size: stats.size }),
      updatedAt: stats.mtime.toISOString(),
    });
    if (entry.isDirectory()) {
      await collectDesignSystemFiles(base, relativePath, files);
    }
  }
}

function sanitizeRelativeFilePath(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\\/g, '/');
  if (!trimmed || trimmed.includes('\0') || path.posix.isAbsolute(trimmed))
    return null;
  const normalized = path.posix.normalize(trimmed);
  if (
    normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
    || normalized.includes('/../')
  ) {
    return null;
  }
  return normalized;
}

function classifyDesignSystemFile(
  relativePath: string,
  isDirectory: boolean,
): DesignSystemFileKind {
  if (isDirectory) return 'folder';
  const ext = path.extname(relativePath).toLowerCase();
  if (ext === '.html') return 'page';
  if (ext === '.css') return 'stylesheet';
  if (ext === '.md') return 'document';
  if (ext === '.json') return 'data';
  if (['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) return 'image';
  return 'asset';
}

async function writeGeneratedDesignSystemFiles(
  root: string,
  id: string,
  input: {
    title: string;
    category: string;
    surface: DesignSystemSurface;
    summary: string;
    sourceNotes?: string;
    provenance?: DesignSystemProvenance;
    body: string;
  },
): Promise<void> {
  const dir = path.join(root, id);
  await Promise.all([
    mkdir(path.join(dir, 'assets'), { recursive: true }),
    mkdir(path.join(dir, 'context'), { recursive: true }),
    mkdir(path.join(dir, 'preview'), { recursive: true }),
    mkdir(path.join(dir, 'src', 'assets'), { recursive: true }),
    mkdir(path.join(dir, 'src', 'components'), { recursive: true }),
    mkdir(path.join(dir, 'ui_kits', 'generated_interface'), { recursive: true }),
  ]);

  const palette = normalizeSwatches(input.body);
  const summary = input.summary || 'A user-created Open Design design system.';
  const sections = extractMarkdownSections(input.body);
  const provenance = input.provenance ?? normalizeProvenance(undefined, {
    ...(input.sourceNotes ? { sourceNotes: input.sourceNotes } : {}),
  });
  await Promise.all([
    writeFile(
      path.join(dir, 'README.md'),
      renderReadme({ ...input, summary, palette, sections }),
      'utf8',
    ),
    writeFile(
      path.join(dir, 'SKILL.md'),
      renderSkill({ ...input, summary, palette }),
      'utf8',
    ),
    writeFile(
      path.join(dir, 'context', 'provenance.json'),
      `${JSON.stringify(provenance ?? {}, null, 2)}\n`,
      'utf8',
    ),
    writeFile(
      path.join(dir, 'context', 'provenance.md'),
      renderProvenanceMarkdown(provenance, input.title),
      'utf8',
    ),
    writeFile(
      path.join(dir, 'colors_and_type.css'),
      renderCssTokens({ title: input.title, palette }),
      'utf8',
    ),
    writeFile(
      path.join(dir, 'package.json'),
      `${JSON.stringify(
        {
          name: slugify(input.title),
          private: true,
          type: 'module',
          scripts: {
            preview: 'open index.html',
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    ),
    writeFile(path.join(dir, 'assets', 'logo.svg'), renderLogoSvg(input.title, palette), 'utf8'),
    writeFile(
      path.join(dir, 'src', 'components', 'design-system-reference.tsx'),
      renderReferenceComponent(input.title),
      'utf8',
    ),
    writeFile(
      path.join(dir, 'src', 'assets', 'README.md'),
      '# Assets\n\nPlace product screenshots, icons, logos, fonts, and brand references here.\n',
      'utf8',
    ),
    writeFile(path.join(dir, 'index.html'), renderOverviewHtml(input.title, summary, palette, sections), 'utf8'),
    writeFile(
      path.join(dir, 'preview', 'colors-node-types.html'),
      renderColorPreviewHtml('Node Type Colors', palette),
      'utf8',
    ),
    writeFile(
      path.join(dir, 'preview', 'colors-ui-palette.html'),
      renderColorPreviewHtml('UI Color Palette', palette),
      'utf8',
    ),
    writeFile(
      path.join(dir, 'preview', 'typography-scale.html'),
      renderTypographyPreviewHtml(input.title),
      'utf8',
    ),
    writeFile(
      path.join(dir, 'preview', 'spacing-system.html'),
      renderSpacingPreviewHtml(),
      'utf8',
    ),
    writeFile(
      path.join(dir, 'preview', 'logo-variants.html'),
      renderLogoPreviewHtml(input.title, palette),
      'utf8',
    ),
    writeFile(
      path.join(dir, 'ui_kits', 'generated_interface', 'index.html'),
      renderComponentPreviewHtml(input.title, summary, palette),
      'utf8',
    ),
  ]);
}

function stripPrefixAndValidateId(id: string, prefix = ''): string | null {
  if (typeof id !== 'string') return null;
  if (prefix && !id.startsWith(prefix)) return null;
  const dirId = prefix ? id.slice(prefix.length) : id;
  if (!/^[a-zA-Z0-9._-]+$/.test(dirId)) return null;
  if (dirId === '.' || dirId === '..') return null;
  return dirId;
}

async function readUserMetadata(root: string, id: string): Promise<UserDesignSystemMetadata> {
  try {
    const raw = await readFile(path.join(root, id, 'metadata.json'), 'utf8');
    const parsed = JSON.parse(raw) as UserDesignSystemMetadata;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const provenance = parseProvenance((parsed as { provenance?: unknown }).provenance);
    const projectId = cleanProjectIdForMetadata(parsed.projectId);
    return {
      ...(typeof parsed.title === 'string' ? { title: parsed.title } : {}),
      ...(typeof parsed.category === 'string' ? { category: parsed.category } : {}),
      ...(isDesignSystemSurface(parsed.surface) ? { surface: parsed.surface } : {}),
      ...(isDesignSystemStatus(parsed.status) ? { status: parsed.status } : {}),
      ...(isDesignSystemArtifactMode(parsed.artifactMode) ? { artifactMode: parsed.artifactMode } : {}),
      ...(typeof parsed.createdAt === 'string' ? { createdAt: parsed.createdAt } : {}),
      ...(typeof parsed.updatedAt === 'string' ? { updatedAt: parsed.updatedAt } : {}),
      ...(provenance ? { provenance } : {}),
      ...(projectId ? { projectId } : {}),
    };
  } catch {
    return {};
  }
}

function cleanProjectIdForMetadata(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value === '.' || value === '..') return null;
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value)) return null;
  return value;
}

function isDesignSystemArtifactMode(raw: unknown): raw is DesignSystemArtifactMode {
  return raw === 'generated' || raw === 'agent-managed';
}

function normalizeArtifactMode(raw: unknown): DesignSystemArtifactMode | undefined {
  return isDesignSystemArtifactMode(raw) ? raw : undefined;
}

async function writeUserMetadata(
  root: string,
  id: string,
  metadata: UserDesignSystemMetadata,
): Promise<void> {
  await writeFile(
    path.join(root, id, 'metadata.json'),
    `${JSON.stringify(metadata, null, 2)}\n`,
    'utf8',
  );
}

async function writeUserDesignSystemRevision(
  root: string,
  id: string,
  revision: DesignSystemRevision,
): Promise<void> {
  await mkdir(path.join(root, id, 'revisions'), { recursive: true });
  await writeFile(
    path.join(root, id, 'revisions', `${revision.id}.json`),
    `${JSON.stringify(revision, null, 2)}\n`,
    'utf8',
  );
}

function parseDesignSystemRevision(
  raw: unknown,
  designSystemId: string,
): DesignSystemRevision | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Partial<DesignSystemRevision>;
  const id = sanitizeRevisionId(value.id);
  const feedback = cleanMultiline(value.feedback);
  const baseBody = normalizeBody(value.baseBody);
  const proposedBody = normalizeBody(value.proposedBody);
  if (!id || !feedback || !baseBody || !proposedBody) return null;
  return {
    id,
    designSystemId,
    status: isDesignSystemRevisionStatus(value.status) ? value.status : 'pending',
    feedback,
    baseBody,
    proposedBody,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString(),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString(),
    ...(cleanText(value.sectionTitle) ? { sectionTitle: cleanText(value.sectionTitle) } : {}),
    ...(typeof value.jobId === 'string' ? { jobId: value.jobId } : {}),
  };
}

function sanitizeRevisionId(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return /^[a-zA-Z0-9-]+$/.test(value) ? value : null;
}

async function uniqueSlug(root: string, base: string): Promise<string> {
  let candidate = base || 'design-system';
  let index = 2;
  for (;;) {
    try {
      await stat(path.join(root, candidate));
      candidate = `${base}-${index++}`;
    } catch {
      return candidate;
    }
  }
}

function slugify(raw: string): string {
  const ascii = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return ascii || 'design-system';
}

function normalizeTitle(raw: string | undefined): string {
  const title = cleanText(raw);
  return title || 'Untitled Design System';
}

function cleanText(raw: string | undefined): string {
  return typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
}

function cleanMultiline(raw: string | undefined): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim().replace(/[ \t]+/g, ' '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseProvenance(raw: unknown): DesignSystemProvenance | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const githubUrls = parseStringList(value.githubUrls);
  const localCodeFiles = parseStringList(value.localCodeFiles);
  const figFiles = parseStringList(value.figFiles);
  const assetFiles = parseStringList(value.assetFiles);
  return normalizeProvenance({
    ...(typeof value.companyBlurb === 'string' ? { companyBlurb: value.companyBlurb } : {}),
    ...(githubUrls ? { githubUrls } : {}),
    ...(localCodeFiles ? { localCodeFiles } : {}),
    ...(figFiles ? { figFiles } : {}),
    ...(assetFiles ? { assetFiles } : {}),
    ...(typeof value.notes === 'string' ? { notes: value.notes } : {}),
    ...(typeof value.sourceNotes === 'string' ? { sourceNotes: value.sourceNotes } : {}),
  });
}

function parseStringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const values = uniqueCleanList(raw.filter((value): value is string => typeof value === 'string'));
  return values.length > 0 ? values : undefined;
}

function normalizeProvenance(
  raw?: DesignSystemProvenance,
  fallback: { companyBlurb?: string; sourceNotes?: string } = {},
): DesignSystemProvenance | undefined {
  const companyBlurb = cleanMultiline(raw?.companyBlurb) || cleanMultiline(fallback.companyBlurb);
  const githubUrls = uniqueCleanList(raw?.githubUrls);
  const localCodeFiles = uniqueCleanList(raw?.localCodeFiles);
  const figFiles = uniqueCleanList(raw?.figFiles);
  const assetFiles = uniqueCleanList(raw?.assetFiles);
  const notes = cleanMultiline(raw?.notes);
  const sourceNotes = cleanMultiline(raw?.sourceNotes) || cleanMultiline(fallback.sourceNotes);
  const provenance: DesignSystemProvenance = {
    ...(companyBlurb ? { companyBlurb } : {}),
    ...(githubUrls.length > 0 ? { githubUrls } : {}),
    ...(localCodeFiles.length > 0 ? { localCodeFiles } : {}),
    ...(figFiles.length > 0 ? { figFiles } : {}),
    ...(assetFiles.length > 0 ? { assetFiles } : {}),
    ...(notes ? { notes } : {}),
    ...(sourceNotes ? { sourceNotes } : {}),
  };
  return hasProvenance(provenance) ? provenance : undefined;
}

function uniqueCleanList(values: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values ?? []) {
    const clean = cleanText(value);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= 100) break;
  }
  return out;
}

function hasProvenance(provenance: DesignSystemProvenance): boolean {
  return Boolean(
    provenance.companyBlurb
      || provenance.notes
      || provenance.sourceNotes
      || provenance.githubUrls?.length
      || provenance.localCodeFiles?.length
      || provenance.figFiles?.length
      || provenance.assetFiles?.length,
  );
}

function provenanceToNotes(provenance: DesignSystemProvenance | undefined): string {
  if (!provenance) return '';
  const lines: string[] = [];
  if (provenance.companyBlurb) lines.push(`Company/product context: ${provenance.companyBlurb}`);
  if (provenance.githubUrls?.length) lines.push(`GitHub/code links: ${provenance.githubUrls.join(', ')}`);
  if (provenance.localCodeFiles?.length) lines.push(`Local code references: ${provenance.localCodeFiles.join(', ')}`);
  if (provenance.figFiles?.length) lines.push(`Figma files: ${provenance.figFiles.join(', ')}`);
  if (provenance.assetFiles?.length) lines.push(`Fonts, logos and assets: ${provenance.assetFiles.join(', ')}`);
  if (provenance.notes) lines.push(`Additional notes: ${provenance.notes}`);
  if (provenance.sourceNotes && !lines.includes(provenance.sourceNotes)) {
    lines.push(provenance.sourceNotes);
  }
  return lines.join('\n');
}

function normalizeBody(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const body = raw.trim();
  return body.length > 0 ? `${body}\n` : null;
}

function firstHeading(raw: string): string | null {
  return /^#\s+(.+?)\s*$/m.exec(raw)?.[1]?.trim() ?? null;
}

function withDesignSystemHeader(
  body: string,
  input: { title: string; category: string; surface: DesignSystemSurface },
): string {
  let next = body.replace(/^#\s+.*$/m, `# ${input.title}`);
  if (next === body && !/^#\s+/.test(next)) next = `# ${input.title}\n\n${next}`;
  next = upsertBlockquoteMeta(next, 'Category', input.category);
  next = upsertBlockquoteMeta(next, 'Surface', input.surface);
  return next.endsWith('\n') ? next : `${next}\n`;
}

function upsertBlockquoteMeta(body: string, key: string, value: string): string {
  const re = new RegExp(`^>\\s*${key}:\\s*.*$`, 'im');
  if (re.test(body)) return body.replace(re, `> ${key}: ${value}`);
  const h1 = /^#\s+.*$/m.exec(body);
  if (!h1) return `> ${key}: ${value}\n\n${body}`;
  const insertAt = h1.index + h1[0].length;
  return `${body.slice(0, insertAt)}\n> ${key}: ${value}${body.slice(insertAt)}`;
}

function buildDraftDesignSystemBody(input: UserDesignSystemInput & { title: string }): string {
  const category = cleanText(input.category) || 'Custom';
  const surface = input.surface ?? 'web';
  const summary = cleanText(input.summary) || 'A user-authored design system for future Open Design projects.';
  const sourceNotes = cleanText(input.sourceNotes);
  return `# ${input.title}

> Category: ${category}
> Surface: ${surface}

${summary}

## 1. Visual Theme & Atmosphere

Describe the visual mood, product context, and the feeling this system should create.
${sourceNotes ? `\nSource context: ${sourceNotes}\n` : ''}
## 2. Color

List brand colors, semantic roles, background surfaces, text colors, borders, and states.

## 3. Typography

Define display, heading, body, caption, and code typography. Include fallback stacks.

## 4. Spacing

Define the spacing scale, density, radius, and layout rhythm.

## 5. Layout & Composition

Describe grids, page structure, information density, navigation, and responsive behavior.

## 6. Components

Document buttons, cards, forms, tables, navigation, modals, and product-specific components.

## 7. Motion & Interaction

Define hover, focus, loading, transition, and reduced-motion behavior.

## 8. Voice & Brand

Describe copy style, terminology, capitalization, and tone.

## 9. Anti-patterns

List visual and interaction choices the agent must avoid when generating with this system.
`;
}

type MarkdownSection = {
  title: string;
  body: string;
};

type GeneratedPalette = {
  background: string;
  border: string;
  foreground: string;
  accent: string;
  muted: string;
  success: string;
};

function normalizeSwatches(body: string): GeneratedPalette {
  const [background, border, foreground, accent] = extractSwatches(body);
  return {
    background: background ?? '#fbfaf7',
    border: border ?? '#ddd8d0',
    foreground: foreground ?? '#1f1d1b',
    accent: accent ?? '#d66f4d',
    muted: '#706b65',
    success: '#5d8f5a',
  };
}

function extractMarkdownSections(body: string): MarkdownSection[] {
  const matches = [...body.matchAll(/^##\s+(.+?)\s*$/gm)];
  if (matches.length === 0) return [];
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? body.length;
    return {
      title: match[1]?.replace(/^\d+\.\s*/, '').trim() || 'Section',
      body: body.slice(start, end).trim(),
    };
  });
}

function renderReadme(input: {
  title: string;
  category: string;
  surface: DesignSystemSurface;
  summary: string;
  sourceNotes?: string;
  provenance?: DesignSystemProvenance;
  palette: GeneratedPalette;
  sections: MarkdownSection[];
}): string {
  const notes = provenanceToNotes(input.provenance) || cleanMultiline(input.sourceNotes);
  const sectionLines = input.sections
    .slice(0, 8)
    .map((section) => `- ${section.title}`)
    .join('\n');
  return `# ${input.title}

${input.summary}

## Overview

- Category: ${input.category}
- Surface: ${input.surface}
- Primary accent: ${input.palette.accent}
- Background: ${input.palette.background}
- Foreground: ${input.palette.foreground}

## Captured Foundations

${sectionLines || '- Visual foundations\n- Component guidance\n- Brand usage'}

## Generated Files

- DESIGN.md: canonical design system source.
- colors_and_type.css: reusable CSS variables for color and type.
- preview/: HTML review cards for type, color, spacing, components, and brand.
- assets/: logo and brand asset references.
- context/: structured source context captured during setup.
- ui_kits/generated_interface/: interactive interface preview.
- SKILL.md: agent-facing usage instructions.
${notes ? `\n## Source Context\n\n${notes}\n` : ''}
`;
}

function renderProvenanceMarkdown(
  provenance: DesignSystemProvenance | undefined,
  title: string,
): string {
  if (!provenance) {
    return `# ${title} Source Context\n\nNo structured source context was captured for this design system.\n`;
  }
  const sections = [
    provenance.companyBlurb ? `## Company / Product\n\n${provenance.companyBlurb}` : '',
    provenance.githubUrls?.length
      ? `## GitHub / Code Links\n\n${provenance.githubUrls.map((value) => `- ${value}`).join('\n')}`
      : '',
    provenance.localCodeFiles?.length
      ? `## Local Code References\n\n${provenance.localCodeFiles.map((value) => `- ${value}`).join('\n')}`
      : '',
    provenance.figFiles?.length
      ? `## Figma Files\n\n${provenance.figFiles.map((value) => `- ${value}`).join('\n')}`
      : '',
    provenance.assetFiles?.length
      ? `## Fonts, Logos and Assets\n\n${provenance.assetFiles.map((value) => `- ${value}`).join('\n')}`
      : '',
    provenance.notes ? `## Notes\n\n${provenance.notes}` : '',
    provenance.sourceNotes ? `## Flattened Source Notes\n\n${provenance.sourceNotes}` : '',
  ].filter(Boolean);
  return `# ${title} Source Context\n\n${sections.join('\n\n')}\n`;
}

function renderSkill(input: {
  title: string;
  summary: string;
  palette: GeneratedPalette;
}): string {
  return `# ${input.title}

Use this skill when generating Open Design artifacts that should follow ${input.title}.

## Style Contract

- Start from DESIGN.md as the source of truth.
- Use colors_and_type.css for color, type, spacing, border, and state tokens.
- Use context/provenance.md to understand which source materials shaped the system.
- Prefer the preview HTML files as visual references before inventing new styles.
- Keep output aligned with this summary: ${input.summary}

## Core Tokens

- Background: ${input.palette.background}
- Foreground: ${input.palette.foreground}
- Accent: ${input.palette.accent}
- Border: ${input.palette.border}

## Workflow

1. Read DESIGN.md.
2. Inspect context/, preview/, and assets/ for concrete references.
3. Generate the requested interface or artifact.
4. Preserve the product context, hierarchy, density, and anti-patterns documented in DESIGN.md.
`;
}

function renderCssTokens(input: { title: string; palette: GeneratedPalette }): string {
  const slug = slugify(input.title);
  return `:root {
  --${slug}-background: ${input.palette.background};
  --${slug}-surface: #ffffff;
  --${slug}-surface-muted: #f4f1ec;
  --${slug}-foreground: ${input.palette.foreground};
  --${slug}-muted: ${input.palette.muted};
  --${slug}-border: ${input.palette.border};
  --${slug}-accent: ${input.palette.accent};
  --${slug}-success: ${input.palette.success};
  --${slug}-font-sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --${slug}-font-serif: Georgia, "Times New Roman", serif;
  --${slug}-font-mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  --${slug}-radius-sm: 6px;
  --${slug}-radius-md: 10px;
  --${slug}-radius-lg: 16px;
  --${slug}-space-1: 4px;
  --${slug}-space-2: 8px;
  --${slug}-space-3: 12px;
  --${slug}-space-4: 16px;
  --${slug}-space-6: 24px;
  --${slug}-space-8: 32px;
}

.od-design-system-preview {
  color: var(--${slug}-foreground);
  background: var(--${slug}-background);
  font-family: var(--${slug}-font-sans);
}
`;
}

function renderLogoSvg(title: string, palette: GeneratedPalette): string {
  const initials = title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('') || 'OD';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" viewBox="0 0 320 160" role="img" aria-label="${escapeHtml(title)}">
  <rect width="320" height="160" rx="28" fill="${palette.background}"/>
  <circle cx="84" cy="80" r="38" fill="${palette.accent}"/>
  <text x="84" y="92" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="28" font-weight="700" fill="#ffffff">${escapeHtml(initials)}</text>
  <text x="140" y="88" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="700" fill="${palette.foreground}">${escapeHtml(title)}</text>
</svg>
`;
}

function renderReferenceComponent(title: string): string {
  return `export function DesignSystemReference() {
  return (
    <section className="od-design-system-preview">
      <h1>${escapeTsxText(title)}</h1>
      <p>Use DESIGN.md and colors_and_type.css as the source of truth.</p>
    </section>
  );
}
`;
}

function renderOverviewHtml(
  title: string,
  summary: string,
  palette: GeneratedPalette,
  sections: MarkdownSection[],
): string {
  const items = sections
    .slice(0, 6)
    .map((section) => `<li><strong>${escapeHtml(section.title)}</strong><span>${escapeHtml(section.body.slice(0, 160) || 'Needs review.')}</span></li>`)
    .join('');
  return renderHtmlDocument(
    title,
    `<main class="overview">
      <p class="eyebrow">Open Design system</p>
      <h1>${escapeHtml(title)}</h1>
      <p class="lead">${escapeHtml(summary)}</p>
      <div class="palette">
        ${renderSwatch('Background', palette.background)}
        ${renderSwatch('Border', palette.border)}
        ${renderSwatch('Foreground', palette.foreground)}
        ${renderSwatch('Accent', palette.accent)}
      </div>
      <ul class="section-list">${items}</ul>
    </main>`,
    palette,
  );
}

function renderColorPreviewHtml(title: string, palette: GeneratedPalette): string {
  const colors: Array<[string, string]> = [
    ['Background', palette.background],
    ['Surface', '#ffffff'],
    ['Foreground', palette.foreground],
    ['Muted', palette.muted],
    ['Border', palette.border],
    ['Accent', palette.accent],
    ['Success', palette.success],
    ['Subtle', '#f4f1ec'],
  ];
  return renderHtmlDocument(
    title,
    `<main>
      <p class="eyebrow">${escapeHtml(title)}</p>
      <h1>${escapeHtml(title)}</h1>
      <div class="swatch-grid">${colors.map(([name, value]) => renderSwatch(name, value)).join('')}</div>
    </main>`,
    palette,
  );
}

function renderTypographyPreviewHtml(title: string): string {
  return renderHtmlDocument(
    'Typography Scale',
    `<main>
      <p class="eyebrow">Typography Scale</p>
      <div class="type-sample"><small>h1 - 40px/Bold</small><h1>${escapeHtml(title)}</h1></div>
      <div class="type-sample"><small>h2 - 32px/Bold</small><h2>Product Workspace</h2></div>
      <div class="type-sample"><small>h3 - 24px/Semibold</small><h3>Component Review</h3></div>
      <div class="type-sample"><small>body - 16px/Regular</small><p>Clear hierarchy, balanced density, and durable system defaults.</p></div>
    </main>`,
    normalizeSwatches(''),
  );
}

function renderSpacingPreviewHtml(): string {
  const spaces = [4, 8, 12, 16, 24, 32, 40, 48];
  return renderHtmlDocument(
    'Spacing and Radius',
    `<main>
      <p class="eyebrow">Spacing and Radius</p>
      <h1>Spacing Scale</h1>
      <div class="spacing-list">
        ${spaces.map((space) => `<div><code>space-${space / 4}</code><span>${space}px</span><b style="width:${space * 2}px"></b></div>`).join('')}
      </div>
      <h2>Border Radius</h2>
      <div class="radius-list"><span style="border-radius:6px">6px</span><span style="border-radius:10px">10px</span><span style="border-radius:16px">16px</span></div>
    </main>`,
    normalizeSwatches(''),
  );
}

function renderLogoPreviewHtml(title: string, palette: GeneratedPalette): string {
  return renderHtmlDocument(
    'Logo Variants',
    `<main>
      <p class="eyebrow">Logo Variants</p>
      <h1>${escapeHtml(title)}</h1>
      <div class="logo-frame">${renderLogoSvg(title, palette)}</div>
      <div class="logo-frame dark">${renderLogoSvg(title, { ...palette, background: palette.foreground, foreground: '#ffffff' })}</div>
    </main>`,
    palette,
  );
}

function renderComponentPreviewHtml(
  title: string,
  summary: string,
  palette: GeneratedPalette,
): string {
  return renderHtmlDocument(
    `${title} Interface`,
    `<main class="component-preview">
      <aside>
        <strong>${escapeHtml(title)}</strong>
        <button>Overview</button>
        <button>Components</button>
        <button>Brand</button>
      </aside>
      <section>
        <p class="eyebrow">Generated UI kit</p>
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(summary)}</p>
        <div class="component-row"><button class="primary">Primary action</button><button>Secondary action</button></div>
        <article><strong>Reference card</strong><span>Use this card to review density, borders, type, and action placement.</span></article>
      </section>
    </main>`,
    palette,
  );
}

function renderHtmlDocument(title: string, body: string, palette: GeneratedPalette): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: ${palette.background};
      --surface: #fff;
      --fg: ${palette.foreground};
      --muted: ${palette.muted};
      --border: ${palette.border};
      --accent: ${palette.accent};
    }
    body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--fg); font: 16px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(960px, calc(100vw - 48px)); margin: 48px auto; }
    h1 { margin: 0 0 14px; font-size: 42px; line-height: 1.04; letter-spacing: 0; }
    h2 { margin: 32px 0 14px; font-size: 26px; }
    h3 { margin: 0; font-size: 20px; }
    p { color: var(--muted); }
    .lead { max-width: 680px; font-size: 19px; }
    .eyebrow { margin: 0 0 10px; color: var(--accent); font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .palette, .swatch-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin: 32px 0; }
    .swatch { min-height: 126px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--surface); }
    .swatch b { display: block; height: 76px; background: var(--color); border-bottom: 1px solid var(--border); }
    .swatch span { display: block; padding: 10px 12px 2px; font-weight: 700; }
    .swatch code { display: block; padding: 0 12px 12px; color: var(--muted); }
    .section-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; padding: 0; list-style: none; }
    .section-list li, article { display: grid; gap: 6px; padding: 18px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
    .section-list span, article span { color: var(--muted); }
    .type-sample { border-bottom: 1px solid var(--border); padding: 26px 0; }
    .type-sample small { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .spacing-list { display: grid; gap: 16px; margin: 28px 0; }
    .spacing-list div { display: grid; grid-template-columns: 100px 60px 1fr; gap: 16px; align-items: center; }
    .spacing-list b { display: block; height: 22px; border-radius: 4px; background: var(--accent); }
    .radius-list { display: flex; gap: 16px; }
    .radius-list span { width: 96px; height: 72px; display: grid; place-items: center; background: var(--surface); border: 1px solid var(--border); }
    .logo-frame { padding: 34px; margin: 20px 0; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
    .logo-frame.dark { background: var(--fg); }
    .component-preview { display: grid; grid-template-columns: 240px 1fr; min-height: calc(100vh - 96px); background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
    .component-preview aside { display: grid; align-content: start; gap: 10px; padding: 20px; background: #f3f1ec; border-right: 1px solid var(--border); }
    button { border: 1px solid var(--border); background: var(--surface); color: var(--fg); border-radius: 7px; padding: 10px 14px; font-weight: 700; }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .component-preview section { padding: 48px; }
    .component-row { display: flex; gap: 10px; margin: 24px 0; }
    @media (max-width: 760px) { .palette, .swatch-grid, .section-list, .component-preview { grid-template-columns: 1fr; } main { width: min(100vw - 28px, 960px); margin: 24px auto; } }
  </style>
</head>
<body>${body}</body>
</html>
`;
}

function renderSwatch(name: string, value: string): string {
  return `<div class="swatch" style="--color:${escapeHtml(value)}"><b></b><span>${escapeHtml(name)}</span><code>${escapeHtml(value)}</code></div>`;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeTsxText(raw: string): string {
  return raw.replace(/[{}<>]/g, '');
}

async function readFileOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (isAbsenceError(err)) return undefined;
    throw err;
  }
}

function isAbsenceError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function summarize(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const firstH1 = lines.findIndex((l) => /^#\s+/.test(l));
  if (firstH1 === -1) return '';
  const afterH1 = lines.slice(firstH1 + 1);
  const nextHeading = afterH1.findIndex((l) => /^#{1,6}\s+/.test(l));
  const window = (nextHeading === -1 ? afterH1 : afterH1.slice(0, nextHeading))
    .join('\n')
    // Drop blockquote metadata lines — they are surfaced separately.
    .replace(/^>\s*Category:.*$/gim, '')
    .replace(/^>\s*Surface:.*$/gim, '')
    .replace(/^>\s*/gm, '')
    .trim();
  return window.split(/\n\n/)[0]?.slice(0, 240) ?? '';
}

function extractCategory(raw: string): string | undefined {
  const m = /^>\s*Category:\s*(.+?)\s*$/im.exec(raw);
  return m?.[1];
}

const KNOWN_SURFACES = new Set<DesignSystemSurface>(['web', 'image', 'video', 'audio']);
const KNOWN_STATUSES = new Set<DesignSystemStatus>(['draft', 'published']);
const KNOWN_REVISION_STATUSES = new Set<DesignSystemRevisionStatus>([
  'pending',
  'accepted',
  'rejected',
]);
function extractSurface(raw: string): DesignSystemSurface {
  const m = /^>\s*Surface:\s*(.+?)\s*$/im.exec(raw);
  if (!m) return 'web';
  const v = m[1]?.trim().toLowerCase();
  return isDesignSystemSurface(v) ? v : 'web';
}

function isDesignSystemSurface(value: string | undefined): value is DesignSystemSurface {
  return value !== undefined && KNOWN_SURFACES.has(value as DesignSystemSurface);
}

function isDesignSystemStatus(value: string | undefined): value is DesignSystemStatus {
  return value !== undefined && KNOWN_STATUSES.has(value as DesignSystemStatus);
}

function isDesignSystemRevisionStatus(
  value: string | undefined,
): value is DesignSystemRevisionStatus {
  return value !== undefined && KNOWN_REVISION_STATUSES.has(value as DesignSystemRevisionStatus);
}

// Strip boilerplate like "Design System Inspired by Cohere" → "Cohere" so
// the picker dropdown reads cleanly. Hand-authored titles that don't match
// the pattern (e.g. "Neutral Modern") pass through unchanged.
function cleanTitle(raw: string): string {
  return raw
    .replace(/^Design System (Inspired by|for)\s+/i, '')
    .trim();
}

/**
 * Pull 4 representative colors from a DESIGN.md so the picker can render
 * a tiny swatch row next to each system. Order: [bg, support, fg, accent].
 *
 * The shape is deliberately compact — one accent + one background + one
 * fg + one supporting tone — so the row reads like a brand mark even at
 * thumbnail scale. Picked greedily by token-name hints (matches the
 * heuristics in design-system-preview.js so the strip and the showcase
 * agree on which colors the system "is").
 *
 * @param {string} raw  Markdown body of DESIGN.md
 * @returns {string[]}  Up to 4 hex strings; [] if extraction fails.
 */
function extractSwatches(raw: string): string[] {
  const colors: ColorToken[] = [];
  const seen = new Set<string>();
  function push(name: string, value: string): void {
    const cleanName = name.replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const v = normalizeHex(value);
    if (!v || cleanName.length > 60) return;
    const key = `${cleanName}|${v}`;
    if (seen.has(key)) return;
    seen.add(key);
    colors.push({ name: cleanName, value: v });
  }
  // Form A: "- **Background:** `#FAFAFA`" — the colon may sit inside the
  // bold markers (`**Name:**`) or outside them (`**Name**:`). Both variants
  // are common in hand-authored DESIGN.md files, so we allow the colon in
  // either position around the closing `**`.
  const reA = /^[\s>*-]*\**\s*([A-Za-z][A-Za-z0-9 /&()+_-]{1,40}?)\s*[:：]?\s*\**\s*[:：]?\s*`?(#[0-9a-fA-F]{3,8})/gm;
  let m;
  while ((m = reA.exec(raw)) !== null) push(m[1] ?? '', m[2] ?? '');
  // Form B: "**Stripe Purple** (`#533afd`)"
  const reB = /\*\*([A-Za-z][A-Za-z0-9 /&()+_-]{1,40}?)\*\*\s*\(?\s*`?(#[0-9a-fA-F]{3,8})/g;
  while ((m = reB.exec(raw)) !== null) push(m[1] ?? '', m[2] ?? '');
  if (colors.length === 0) return [];

  function pick(hints: string[]): string | null {
    for (const h of hints) {
      const found = colors.find((c) => c.name.includes(h));
      if (found) return found.value;
    }
    return null;
  }
  function isNeutral(hex: string): boolean {
    if (!/^#[0-9a-f]{6}$/.test(hex)) return false;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return Math.max(r, g, b) - Math.min(r, g, b) < 10;
  }

  const bg =
    pick(['page background', 'background', 'canvas', 'paper', 'surface'])
    ?? '#ffffff';
  const fg =
    pick(['heading', 'foreground', 'ink', 'fg', 'text', 'navy', 'graphite'])
    ?? '#111111';
  const accent =
    pick(['primary brand', 'brand primary', 'accent', 'brand', 'primary'])
    ?? colors.find((c) => !isNeutral(c.value))?.value
    ?? colors[0]?.value
    ?? '#888888';
  const support =
    pick(['border', 'divider', 'rule', 'muted', 'secondary', 'subtle'])
    ?? colors.find(
      (c) => isNeutral(c.value) && c.value !== bg && c.value !== fg,
    )?.value
    ?? '#cccccc';

  return [bg, support, fg, accent];
}

function normalizeHex(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const m = /^#([0-9a-fA-F]{3,8})$/.exec(raw.trim());
  if (!m) return null;
  let hex = m[1] ?? '';
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  if (hex.length === 4) hex = hex.split('').map((c) => c + c).join('').slice(0, 8);
  return '#' + hex.toLowerCase();
}
