// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { buildSrcdoc } from '../../src/runtime/srcdoc';

function extractDeckBridgeScript(srcdoc: string): string {
  const match = srcdoc.match(/<script data-od-deck-bridge>([\s\S]*?)<\/script>/);
  if (!match || !match[1]) {
    throw new Error('deck bridge script not found in srcdoc');
  }
  return match[1];
}

function setupViewportTrackDeck() {
  const bodyHtml = `
    <div id="deck" style="position: fixed; inset: 0; display: flex; width: 300vw; transform: translateX(0);">
      <section class="slide active" style="width: 100vw; height: 100vh; flex: 0 0 100vw;">One</section>
      <section class="slide" style="width: 100vw; height: 100vh; flex: 0 0 100vw;">Two</section>
      <section class="slide" style="width: 100vw; height: 100vh; flex: 0 0 100vw;">Three</section>
    </div>`;
  const srcdoc = buildSrcdoc(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    deck: true,
  });
  const script = extractDeckBridgeScript(srcdoc);
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const win = dom.window;
  const parentPostMessage = vi.fn();
  const scrollTo = vi.fn();

  Object.defineProperty(win, 'innerWidth', { configurable: true, value: 1000 });
  Object.defineProperty(win, 'parent', {
    configurable: true,
    value: { postMessage: parentPostMessage },
  });
  Object.defineProperty(win.document.body, 'clientWidth', { configurable: true, value: 1000 });
  Object.defineProperty(win.document.body, 'scrollWidth', { configurable: true, value: 3000 });
  Object.defineProperty(win.document.body, 'scrollLeft', { configurable: true, value: 0 });
  Object.defineProperty(win.document.body, 'scrollTo', { configurable: true, value: scrollTo });

  const evaluate = new win.Function(script);
  evaluate.call(win);

  return { win, scrollTo };
}

describe('deck bridge — fixed viewport transform tracks (#1531)', () => {
  it('drives 100vw fixed tracks with translateX instead of document scrolling', () => {
    const { win, scrollTo } = setupViewportTrackDeck();
    const deck = win.document.getElementById('deck') as HTMLElement;
    const slides = Array.from(win.document.querySelectorAll<HTMLElement>('.slide'));

    win.dispatchEvent(new win.MessageEvent('message', {
      data: { type: 'od:slide', action: 'next' },
    }));

    expect(scrollTo).not.toHaveBeenCalled();
    expect(deck.style.transform).toBe('translateX(-100vw)');
    expect(slides.map((slide) => slide.classList.contains('active'))).toEqual([false, true, false]);
  });
});
