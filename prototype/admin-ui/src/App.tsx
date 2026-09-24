import { useSearchParams } from 'react-router-dom';
import { VariantA } from './variants/VariantA';
import { VariantB } from './variants/VariantB';
import { VariantC } from './variants/VariantC';
import { PrototypeSwitcher } from './PrototypeSwitcher';
import { Shell } from './shell/Shell';

const VariantE = () => <Shell variant="E" />;
const VariantF = () => <Shell variant="F" />;
const VariantG = () => <Shell variant="G" />;
const VariantH = () => <Shell variant="H" />;
const VariantI = () => <Shell variant="I" />;

export const VARIANTS = [
  { key: 'G', name: '#33 campaigns — nav page, links table, row editor', Component: VariantG },
  { key: 'H', name: '#33 campaigns — grouped in the feed, matrix generator', Component: VariantH },
  { key: 'I', name: '#33 campaigns — source × medium pivot', Component: VariantI },
  { key: 'E', name: '#20 shell — Links · API keys · Settings', Component: VariantE },
  { key: 'F', name: '#20 shell — Links · Security · Settings', Component: VariantF },
  { key: 'A', name: 'Table + pages', Component: VariantA },
  { key: 'B', name: 'Master-detail', Component: VariantB },
  { key: 'C', name: 'Feed + drawer', Component: VariantC },
  { key: 'D', name: 'Server-rendered HTML (no JS)', href: '/ssr/' },
] as const;

export function App() {
  const [params] = useSearchParams();
  const key = params.get('variant') ?? 'G';
  const v = VARIANTS.find((x) => x.key === key && 'Component' in x) ?? VARIANTS[0];
  const Component = (v as { Component: () => JSX.Element }).Component;
  return (
    <>
      <Component />
      <PrototypeSwitcher current={v.key} />
    </>
  );
}
