/*
 * Sticky Header — static markup rendered at build time. Headroom-style
 * hide/show and the live GitHub star count are attached by the tiny inline
 * scripts on each Astro page, so this marketing page ships no React runtime
 * to the browser.
 *
 * The nav links go to internal multi-page routes (`/skills/`, `/systems/`,
 * `/templates/`, `/craft/`) so Google sees a real site hierarchy. Numbers
 * reflect the live counts of the canonical Markdown bundles in the repo
 * root and are kept in sync with `getCatalogCounts()` at build time.
 */

import {
  DEFAULT_LOCALE,
  getCommonCopy,
  localizedHref,
  type HeaderCopy,
  type LandingLocaleCode,
} from '../i18n';

const REPO = 'https://github.com/nexu-io/open-design';
const REPO_RELEASES = `${REPO}/releases`;

const ext = {
  target: '_blank',
  rel: 'noreferrer noopener',
} as const;

export interface HeaderProps {
  /** Nav highlight target. `'home'` is the default for `/`. */
  active?: 'home' | 'skills' | 'systems' | 'templates' | 'craft' | 'blog';
  /**
   * Live counts from the Markdown catalogs. Required so we can never
   * silently render stale fallback numbers when a caller forgets to
   * thread `getCatalogCounts()` through. Header only consumes these
   * four scalar fields; the homepage passes the wider `CatalogCounts`
   * value (with `byMode` / `byPlatform`) by structural subtyping.
   */
  counts: {
    skills: number;
    systems: number;
    templates: number;
    craft: number;
  };
  github?: {
    starsLabel: string;
  };
  /** UI locale for nav labels and accessibility text. */
  locale?: LandingLocaleCode;
  /** Optional override for callers that already resolved localized chrome. */
  copy?: HeaderCopy;
  /** Brand link target — `#top` on the homepage, `/` on sub-pages. */
  brandHref?: string;
}

export function Header({
  active = 'home',
  counts,
  github,
  locale = DEFAULT_LOCALE,
  copy,
  brandHref = '#top',
}: HeaderProps) {
  const linkClass = (key: NonNullable<HeaderProps['active']>) =>
    active === key ? 'is-active' : undefined;
  const headerCopy = copy ?? getCommonCopy(locale).header;
  const href = (path: string) => localizedHref(path, locale);
  const homeBrandHref = brandHref === '/' ? href('/') : brandHref;
  const contactHref = brandHref === '#top' ? '#contact' : href('/#contact');

  return (
    <header className='nav' data-od-id='nav' data-nav-headroom>
      <div className='container nav-inner'>
        <a href={homeBrandHref} className='brand'>
          <span className='brand-mark'>
            <img src='/logo.webp' alt='' width={36} height={36} />
          </span>
          <span>Open Design</span>
          <span className='brand-meta'>
            <b>{headerCopy.brandMetaTitle}</b>
            {headerCopy.brandMetaBody}
          </span>
        </a>
        <nav>
          <ul className='nav-links'>
            <li>
              <a href={href('/skills/')} className={linkClass('skills')}>
                {headerCopy.nav.skills}
                <span className='num'>{counts.skills}</span>
              </a>
            </li>
            <li>
              <a href={href('/systems/')} className={linkClass('systems')}>
                {headerCopy.nav.systems}
                <span className='num'>{counts.systems}</span>
              </a>
            </li>
            <li>
              <a href={href('/templates/')} className={linkClass('templates')}>
                {headerCopy.nav.templates}
                <span className='num'>{counts.templates}</span>
              </a>
            </li>
            <li>
              <a href={href('/craft/')} className={linkClass('craft')}>
                {headerCopy.nav.craft}
                <span className='num'>{counts.craft}</span>
              </a>
            </li>
            <li>
              <a href={href('/blog/')} className={linkClass('blog')}>
                {headerCopy.nav.blog}
              </a>
            </li>
            <li>
              <a href={contactHref}>
                {headerCopy.nav.contact}
              </a>
            </li>
          </ul>
        </nav>
        <div className='nav-side'>
          <a
            className='nav-cta ghost'
            href={REPO_RELEASES}
            aria-label={headerCopy.downloadAria}
            title={headerCopy.downloadTitle}
            {...ext}
          >
            {headerCopy.download}
          </a>
          <a
            className='nav-cta'
            href={REPO}
            aria-label={headerCopy.starAria}
            title={headerCopy.starTitle}
            {...ext}
          >
            {headerCopy.starPrefix} ·{' '}
            <span data-github-stars>{github?.starsLabel ?? '40K+'}</span>
          </a>
          <span className='status-dot' aria-hidden='true' />
        </div>
      </div>
    </header>
  );
}
