// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installMockOpenDesignHost } from '@open-design/host/testing';

import { DesignBrowserPanel } from '../../src/components/DesignBrowserPanel';

// The panel imports these writers from the registry at module load; stub them so
// rendering never reaches the network.
vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    openExternalUrl: vi.fn(async () => true),
    writeProjectTextFile: vi.fn(async () => null),
    writeProjectBase64File: vi.fn(async () => null),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let restoreHost: (() => void) | null = null;

beforeEach(() => {
  window.localStorage.clear();
  // Makes isOpenDesignHostAvailable() true so the panel renders the desktop
  // <webview> branch (rather than the iframe fallback).
  restoreHost = installMockOpenDesignHost();
});

afterEach(() => {
  cleanup();
  restoreHost?.();
  restoreHost = null;
  window.localStorage.clear();
});

function dispatchWebviewNavigate(webview: HTMLElement, url: string) {
  act(() => {
    const event = new Event('did-navigate') as Event & { url?: string; isMainFrame?: boolean };
    event.url = url;
    event.isMainFrame = true;
    webview.dispatchEvent(event);
  });
}

function dispatchWebviewTitle(webview: HTMLElement, title: string) {
  act(() => {
    const event = new Event('page-title-updated') as Event & { title?: string };
    event.title = title;
    webview.dispatchEvent(event);
  });
}

describe('DesignBrowserPanel <webview> navigation', () => {
  it('pins the webview src to the load target when the guest commits a redirected URL', () => {
    // Regression guard for the blank-page bug: the embedded <webview> rendered
    // but never painted because did-navigate fed the committed (trailing-slash)
    // URL straight back into the src prop, so Electron re-navigated and aborted
    // the in-flight load (ERR_ABORTED -3). The load target (src) must stay put
    // while only the address bar follows the committed URL.
    const { container } = render(
      <DesignBrowserPanel projectId="proj-webview" onOpenFile={() => {}} onRefreshFiles={() => {}} />,
    );

    const input = screen.getByLabelText('Browser address') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'example.com' } });
    fireEvent.submit(input.closest('form')!);

    const webview = container.querySelector('webview.db-webview') as HTMLElement | null;
    expect(webview).not.toBeNull();
    // The bare domain is normalized to https and becomes the load target.
    expect(webview!.getAttribute('src')).toBe('https://example.com');
    expect(input.value).toBe('https://example.com');

    // The guest commits a redirect that appends a trailing slash.
    dispatchWebviewNavigate(webview!, 'https://example.com/');

    // The address bar follows the committed URL...
    expect(input.value).toBe('https://example.com/');
    // ...but the src remains the original target, so no abort/reload loop.
    expect(webview!.getAttribute('src')).toBe('https://example.com');
  });

  it('changes the src only when the user navigates to a new target', () => {
    const { container } = render(
      <DesignBrowserPanel projectId="proj-webview-2" onOpenFile={() => {}} onRefreshFiles={() => {}} />,
    );

    const input = screen.getByLabelText('Browser address') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://gsap.com' } });
    fireEvent.submit(input.closest('form')!);

    const webview = container.querySelector('webview.db-webview') as HTMLElement;
    expect(webview.getAttribute('src')).toBe('https://gsap.com');

    // An in-page navigation event must not move the load target.
    dispatchWebviewNavigate(webview, 'https://gsap.com/docs/');
    expect(webview.getAttribute('src')).toBe('https://gsap.com');
    expect(input.value).toBe('https://gsap.com/docs/');

    // A fresh user navigation does move it.
    fireEvent.change(input, { target: { value: 'unsplash.com' } });
    fireEvent.submit(input.closest('form')!);
    expect(webview.getAttribute('src')).toBe('https://unsplash.com');
  });

  it('derives back and forward availability from the committed navigation stack', () => {
    const { container } = render(
      <DesignBrowserPanel projectId="proj-webview-3" onOpenFile={() => {}} onRefreshFiles={() => {}} />,
    );

    const input = screen.getByLabelText('Browser address') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'example.com' } });
    fireEvent.submit(input.closest('form')!);

    const webview = container.querySelector('webview.db-webview') as HTMLElement & {
      loadURL?: (url: string) => void;
    };
    const loadURL = vi.fn();
    webview.loadURL = loadURL;

    const backButton = screen.getByRole('button', { name: 'Go Back' }) as HTMLButtonElement;
    const forwardButton = screen.getByRole('button', { name: 'Go Forward' }) as HTMLButtonElement;
    expect(backButton.disabled).toBe(true);
    expect(backButton.parentElement?.getAttribute('data-tooltip')).toBe('Go Back');

    dispatchWebviewNavigate(webview, 'https://example.com/');
    expect(backButton.disabled).toBe(true);

    dispatchWebviewNavigate(webview, 'https://example.com/docs/');
    expect(input.value).toBe('https://example.com/docs/');
    expect(backButton.disabled).toBe(false);
    expect(forwardButton.disabled).toBe(true);

    fireEvent.click(backButton);
    expect(loadURL).toHaveBeenCalledWith('https://example.com/');
    expect(forwardButton.disabled).toBe(false);
  });

  it('uses native webview history for back navigation when Chromium has it cached', () => {
    const { container } = render(
      <DesignBrowserPanel projectId="proj-webview-native" onOpenFile={() => {}} onRefreshFiles={() => {}} />,
    );

    const input = screen.getByLabelText('Browser address') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'example.com' } });
    fireEvent.submit(input.closest('form')!);

    const webview = container.querySelector('webview.db-webview') as HTMLElement & {
      canGoBack?: () => boolean;
      goBack?: () => void;
      loadURL?: (url: string) => void;
    };
    dispatchWebviewNavigate(webview, 'https://example.com/');
    dispatchWebviewNavigate(webview, 'https://example.com/docs/');

    const goBack = vi.fn();
    const loadURL = vi.fn();
    webview.canGoBack = () => true;
    webview.goBack = goBack;
    webview.loadURL = loadURL;

    fireEvent.click(screen.getByRole('button', { name: 'Go Back' }));

    expect(goBack).toHaveBeenCalledTimes(1);
    expect(loadURL).not.toHaveBeenCalled();
  });

  it('shows extracted page titles in the passive address display and history suggestions', () => {
    const { container } = render(
      <DesignBrowserPanel projectId="proj-webview-title" onOpenFile={() => {}} onRefreshFiles={() => {}} />,
    );

    const input = screen.getByLabelText('Browser address') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://www.baidu.com' } });
    fireEvent.submit(input.closest('form')!);

    const webview = container.querySelector('webview.db-webview') as HTMLElement & {
      getTitle?: () => string;
      getURL?: () => string;
    };
    webview.getURL = () => 'https://www.baidu.com/';
    webview.getTitle = () => '百度一下，你就知道';
    dispatchWebviewNavigate(webview, 'https://www.baidu.com/');
    dispatchWebviewTitle(webview, '百度一下，你就知道');
    fireEvent.blur(input);

    expect(input.value).toBe('https://www.baidu.com/ / 百度一下，你就知道');

    fireEvent.focus(input);
    expect(input.value).toBe('https://www.baidu.com/');
    expect(screen.getByRole('option', { name: /百度一下，你就知道/ })).toBeTruthy();
  });

  it('opens all reference suggestions by default from the address bar', () => {
    render(
      <DesignBrowserPanel projectId="proj-webview-suggestions" onOpenFile={() => {}} onRefreshFiles={() => {}} />,
    );

    fireEvent.focus(screen.getByLabelText('Browser address'));

    expect(screen.getByRole('option', { name: /Whirrls/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /Startups Gallery/ })).toBeTruthy();
  });

  it('keeps the browser fallback content free of desktop-only overlay banners', () => {
    restoreHost?.();
    restoreHost = null;

    const { container } = render(
      <DesignBrowserPanel projectId="proj-browser-fallback" onOpenFile={() => {}} onRefreshFiles={() => {}} />,
    );

    const input = screen.getByLabelText('Browser address') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://example.com' } });
    fireEvent.submit(input.closest('form')!);

    expect(container.querySelector('iframe')).not.toBeNull();
    expect(screen.queryByText('Embedded browser controls are available in the desktop app.')).toBeNull();
  });
});
