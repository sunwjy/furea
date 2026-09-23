// Floating bottom bar. Hidden in production builds.
import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { VARIANTS } from './App';

export function PrototypeSwitcher({ current }: { current: string }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  if (import.meta.env.PROD) return null;
  const idx = VARIANTS.findIndex((v) => v.key === current);
  const go = (delta: number) => {
    const next = VARIANTS[(idx + delta + VARIANTS.length) % VARIANTS.length];
    if ('href' in next) { window.location.href = next.href; return; }
    const p = new URLSearchParams(params);
    p.set('variant', next.key);
    navigate({ pathname: '/', search: `?${p}` }, { replace: true });
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
