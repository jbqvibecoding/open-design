// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  browserFileName,
  browserHarnessTaskMarkdown,
  faviconUrl,
  formatAddressDisplay,
  hostnameFromUrl,
  isHistoryEntry,
  isHistoryUrl,
  labelFromUrl,
  loadHistory,
  normalizeBrowserAddress,
  pageBriefMarkdown,
  sameUrl,
  saveHistory,
} from '../../src/components/DesignBrowserPanel';

describe('normalizeBrowserAddress', () => {
  it('passes through absolute http URLs unchanged', () => {
    expect(normalizeBrowserAddress('http://example.com/page')).toBe('http://example.com/page');
  });

  it('passes through absolute https URLs unchanged', () => {
    expect(normalizeBrowserAddress('https://example.com/page')).toBe('https://example.com/page');
  });

  it('passes through file URLs unchanged', () => {
    expect(normalizeBrowserAddress('file:///Users/me/page.html')).toBe('file:///Users/me/page.html');
  });

  it('trims surrounding whitespace before matching', () => {
    expect(normalizeBrowserAddress('  https://example.com  ')).toBe('https://example.com');
  });

  it('promotes a bare domain to https', () => {
    expect(normalizeBrowserAddress('example.com')).toBe('https://example.com');
  });

  it('promotes a bare domain with a path and port to https', () => {
    expect(normalizeBrowserAddress('example.com:8080/path')).toBe('https://example.com:8080/path');
  });

  it('maps localhost to http', () => {
    expect(normalizeBrowserAddress('localhost')).toBe('http://localhost');
    expect(normalizeBrowserAddress('localhost:3000/dash')).toBe('http://localhost:3000/dash');
  });

  it('maps loopback IPs to http', () => {
    expect(normalizeBrowserAddress('127.0.0.1')).toBe('http://127.0.0.1');
    expect(normalizeBrowserAddress('127.0.0.1:5173')).toBe('http://127.0.0.1:5173');
    expect(normalizeBrowserAddress('0.0.0.0:8000')).toBe('http://0.0.0.0:8000');
  });

  it('resolves /api, /artifacts, /frames paths against the page origin', () => {
    const origin = window.location.origin;
    expect(normalizeBrowserAddress('/api/runs')).toBe(`${origin}/api/runs`);
    expect(normalizeBrowserAddress('/artifacts/x.png')).toBe(`${origin}/artifacts/x.png`);
    expect(normalizeBrowserAddress('/frames/1')).toBe(`${origin}/frames/1`);
  });

  it('maps other absolute paths to file URLs', () => {
    expect(normalizeBrowserAddress('/Users/me/page.html')).toBe('file:///Users/me/page.html');
    expect(normalizeBrowserAddress('/some path/with space')).toBe(`file://${encodeURI('/some path/with space')}`);
  });

  it('treats free text as a Google search', () => {
    expect(normalizeBrowserAddress('design inspiration')).toBe(
      'https://www.google.com/search?q=design%20inspiration',
    );
  });

  it('maps an empty string to about:blank', () => {
    expect(normalizeBrowserAddress('')).toBe('about:blank');
    expect(normalizeBrowserAddress('   ')).toBe('about:blank');
  });

  it('passes through an explicit about:blank', () => {
    expect(normalizeBrowserAddress('about:blank')).toBe('about:blank');
  });
});

describe('sameUrl', () => {
  it('treats trailing slashes as equivalent', () => {
    expect(sameUrl('https://example.com', 'https://example.com/')).toBe(true);
    expect(sameUrl('https://example.com///', 'https://example.com')).toBe(true);
  });

  it('distinguishes different paths', () => {
    expect(sameUrl('https://example.com/a', 'https://example.com/b')).toBe(false);
  });
});

describe('labelFromUrl', () => {
  it('returns New Tab for the blank URL', () => {
    expect(labelFromUrl('about:blank')).toBe('New Tab');
  });

  it('strips the www. prefix from the host', () => {
    expect(labelFromUrl('https://www.example.com/page')).toBe('example.com');
    expect(labelFromUrl('https://sub.example.com/')).toBe('sub.example.com');
  });

  it('falls back to the raw value when the URL cannot be parsed', () => {
    expect(labelFromUrl('not a url')).toBe('not a url');
  });
});

describe('formatAddressDisplay', () => {
  it('keeps the URL alone when the title is only the host fallback', () => {
    expect(formatAddressDisplay('https://www.example.com/path', 'example.com')).toBe('https://www.example.com/path');
  });

  it('appends a real page title for the passive address display', () => {
    expect(formatAddressDisplay('https://www.baidu.com/', '百度一下，你就知道')).toBe(
      'https://www.baidu.com/ / 百度一下，你就知道',
    );
  });

  it('keeps the blank tab display empty', () => {
    expect(formatAddressDisplay('about:blank', 'New Tab')).toBe('');
  });
});

describe('hostnameFromUrl', () => {
  it('returns a compact hostname without www', () => {
    expect(hostnameFromUrl('https://www.example.com/docs')).toBe('example.com');
  });

  it('falls back to the raw value when parsing fails', () => {
    expect(hostnameFromUrl('not a url')).toBe('not a url');
  });
});

describe('faviconUrl', () => {
  it('derives a same-origin favicon URL for http pages', () => {
    expect(faviconUrl('https://www.example.com/docs')).toBe('https://www.example.com/favicon.ico');
  });

  it('skips non-http urls', () => {
    expect(faviconUrl('file:///Users/me/page.html')).toBeUndefined();
  });
});

describe('isHistoryUrl', () => {
  it('accepts http(s) and file URLs', () => {
    expect(isHistoryUrl('https://example.com')).toBe(true);
    expect(isHistoryUrl('http://localhost:3000')).toBe(true);
    expect(isHistoryUrl('file:///Users/me/x.html')).toBe(true);
  });

  it('rejects the blank URL', () => {
    expect(isHistoryUrl('about:blank')).toBe(false);
  });

  it('rejects non http/file schemes', () => {
    expect(isHistoryUrl('data:text/html,hi')).toBe(false);
    expect(isHistoryUrl('mailto:hi@example.com')).toBe(false);
  });
});

describe('browserHarnessTaskMarkdown', () => {
  it('embeds the target URL and the browser-harness command', () => {
    const md = browserHarnessTaskMarkdown('proj-123', 'https://example.com/ref');
    expect(md).toContain('Target URL: https://example.com/ref');
    expect(md).toContain('Open Design project: proj-123');
    expect(md).toContain('browser-harness');
    expect(md).toContain('new_tab("https://example.com/ref")');
  });

  it('uses the current-project fallback line when projectId is empty', () => {
    const md = browserHarnessTaskMarkdown('', 'https://example.com/ref');
    expect(md).toContain('Open Design project: current project');
    expect(md).not.toContain('Open Design project: \n');
  });
});

describe('pageBriefMarkdown', () => {
  it('renders title, source, and populated sections while skipping empty ones', () => {
    const md = pageBriefMarkdown(
      {
        title: 'Example',
        url: 'https://example.com',
        description: 'A description',
        headings: ['Hero', '  ', 'Features'],
        images: [],
        links: [{ text: 'Docs', url: 'https://example.com/docs' }],
        colors: [{ value: 'rgb(0, 0, 0)', count: 4 }],
      },
      'https://fallback.example.com',
    );
    expect(md).toContain('# Example');
    expect(md).toContain('Source: https://example.com');
    expect(md).toContain('## Description');
    expect(md).toContain('## Headings');
    expect(md).toContain('- Hero');
    expect(md).toContain('- Features');
    expect(md).not.toContain('## Images');
    expect(md).toContain('## Links');
    expect(md).toContain('- Docs - https://example.com/docs');
    expect(md).toContain('## Colors');
    expect(md).toContain('- rgb(0, 0, 0) (4)');
    expect(md).toContain('## Browser Harness follow-up');
  });

  it('falls back to label and url when the brief omits them', () => {
    const md = pageBriefMarkdown({}, 'https://www.fallback.example.com/path');
    expect(md).toContain('# fallback.example.com');
    expect(md).toContain('Source: https://www.fallback.example.com/path');
  });
});

describe('browserFileName', () => {
  it('sanitizes the host and includes the prefix and extension', () => {
    const name = browserFileName('browser-capture', 'https://www.example.com/page', 'png');
    expect(name).toMatch(/^browser\/browser-capture-example\.com-[\dTZ-]+\.png$/);
  });

  it('uses a page fallback when the host sanitizes to empty', () => {
    const name = browserFileName('browser-brief', 'about:blank', 'md');
    // about:blank -> labelFromUrl 'New Tab' -> 'New-Tab'
    expect(name).toMatch(/^browser\/browser-brief-New-Tab-[\dTZ-]+\.md$/);
  });
});

describe('isHistoryEntry', () => {
  it('accepts a well-formed entry', () => {
    expect(
      isHistoryEntry({ url: 'https://x', title: 'X', iconUrl: 'https://x/favicon.ico', lastVisitedAt: 1, visitCount: 1 }),
    ).toBe(true);
  });

  it('rejects malformed values', () => {
    expect(isHistoryEntry(null)).toBe(false);
    expect(isHistoryEntry([])).toBe(false);
    expect(isHistoryEntry('x')).toBe(false);
    expect(isHistoryEntry({ url: 1, title: 'X', lastVisitedAt: 1, visitCount: 1 })).toBe(false);
    expect(isHistoryEntry({ url: 'x', title: 'X', lastVisitedAt: 1 })).toBe(false);
  });
});

describe('loadHistory / saveHistory round-trip', () => {
  const projectId = 'proj-history';

  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('returns an empty array when nothing is stored', () => {
    expect(loadHistory(projectId)).toEqual([]);
  });

  it('round-trips entries and sorts by lastVisitedAt descending', () => {
    saveHistory(projectId, [
      { url: 'https://a.com', title: 'A', lastVisitedAt: 100, visitCount: 1 },
      { url: 'https://b.com', title: 'B', lastVisitedAt: 300, visitCount: 2 },
      { url: 'https://c.com', title: 'C', lastVisitedAt: 200, visitCount: 1 },
    ]);
    const loaded = loadHistory(projectId);
    expect(loaded.map((entry) => entry.url)).toEqual([
      'https://b.com',
      'https://c.com',
      'https://a.com',
    ]);
  });

  it('drops malformed entries on load', () => {
    window.localStorage.setItem(
      `od:design-browser:${projectId}:history:v1`,
      JSON.stringify([
        { url: 'https://ok.com', title: 'OK', lastVisitedAt: 1, visitCount: 1 },
        { url: 123, title: 'bad', lastVisitedAt: 1, visitCount: 1 },
      ]),
    );
    const loaded = loadHistory(projectId);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.url).toBe('https://ok.com');
  });

  it('returns an empty array for corrupt or non-array JSON', () => {
    const key = `od:design-browser:${projectId}:history:v1`;
    window.localStorage.setItem(key, 'not json');
    expect(loadHistory(projectId)).toEqual([]);
    window.localStorage.setItem(key, JSON.stringify({ not: 'an array' }));
    expect(loadHistory(projectId)).toEqual([]);
  });

  it('caps stored history at the HISTORY_LIMIT on save and load', () => {
    const many = Array.from({ length: 120 }, (_, index) => ({
      url: `https://site-${index}.com`,
      title: `Site ${index}`,
      lastVisitedAt: index,
      visitCount: 1,
    }));
    saveHistory(projectId, many);
    expect(loadHistory(projectId)).toHaveLength(80);
  });
});
