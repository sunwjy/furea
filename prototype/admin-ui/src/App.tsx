import { useSearchParams } from 'react-router-dom';
import { VariantA } from './variants/VariantA';
import { VariantB } from './variants/VariantB';
import { VariantC } from './variants/VariantC';
import { PrototypeSwitcher } from './PrototypeSwitcher';

export const VARIANTS = [
  { key: 'A', name: 'Table + pages', Component: VariantA },
  { key: 'B', name: 'Master-detail', Component: VariantB },
  { key: 'C', name: 'Feed + drawer', Component: VariantC },
  { key: 'D', name: 'Server-rendered HTML (no JS)', href: '/ssr/' },
] as const;

export function App() {
  const [params] = useSearchParams();
  const key = params.get('variant') ?? 'A';
  const v = VARIANTS.find((x) => x.key === key && 'Component' in x) ?? VARIANTS[0];
  const Component = (v as { Component: () => JSX.Element }).Component;
  return (
    <>
      <Component />
      <PrototypeSwitcher current={v.key} />
    </>
  );
}
