// Floating bottom bar. Hidden in production builds.
import { useEffect } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { VARIANTS } from './App';

export function PrototypeSwitcher({ current }: { current: string }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  if (import.meta.env.PROD) return null;
  const idx = VARIANTS.findIndex((v) => v.key === current);
  const go = (delta: number) => {
    const next = VARIANTS[(idx + delta + VARIANTS.length) % VARIANTS.length];
    if ('href' in next) { window.location.href = next.href; return; }
    const p = new URLSearchParams(params);
    p.set('variant', next.key);
    // E <-> F keep the current page unless it only exists in one of them
    // shell variants keep the current page unless it only exists in some of them
    const SHELL = ['E', 'F', 'G', 'H', 'I'];
    const campaignOnly = /^\/campaigns/.test(pathname) && !['G', 'H', 'I'].includes(next.key);
    const shell = SHELL.includes(current) && SHELL.includes(next.key) && !/^\/(keys|security)/.test(pathname) && !campaignOnly
      && !(pathname === '/campaigns' && next.key === 'H') && !(/\/add$/.test(pathname) && next.key !== 'G');
    navigate({ pathname: shell ? pathname : '/', search: `?${p}` }, { replace: true });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <div className="proto-switcher">
      <button onClick={() => go(-1)} aria-label="previous variant">←</button>
      <span>{current} — {VARIANTS[idx].name}</span>
      <button onClick={() => go(1)} aria-label="next variant">→</button>
    </div>
  );
}
