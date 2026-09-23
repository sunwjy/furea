// PROTOTYPE-ONLY: flips the mock instance into the states the ticket asks about, and prints the mock's full state.
// Deliberately garish (same pink as the variant switcher) so it never reads as part of the design.
import { useEffect, useState } from 'react';

type State = { scenario: { host: string; analyticsConfigured: boolean; access: unknown; accessJwt: boolean; accessUnreachable: boolean }; [k: string]: unknown };

export function ScenarioPanel() {
  const [s, setS] = useState<State | null>(null);
  const [open, setOpen] = useState(false);
  const load = () => fetch('/__proto/state').then((r) => r.json()).then(setS);
  useEffect(() => { load(); }, []);
  if (import.meta.env.PROD || !s) return null;
  const post = async (body: object) => { await fetch('/__proto/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); location.reload(); };
  const sc = s.scenario;
  return (
    <div className="proto-scenario">
      <button className="proto-scenario-toggle" onClick={() => { setOpen(!open); load(); }}>{open ? '× scenario' : '⚙ scenario'}</button>
      {open && (
        <div className="proto-scenario-body">
          <label><input type="checkbox" checked={sc.analyticsConfigured} onChange={(e) => post({ scenario: { analyticsConfigured: e.target.checked } })} /> analytics token configured</label>
          <label><input type="checkbox" checked={sc.host.endsWith('.workers.dev')} onChange={(e) => post({ scenario: { host: e.target.checked ? 'furea-sun.workers.dev' : 's.example.com' } })} /> reached via workers.dev</label>
          <label><input type="checkbox" checked={!!sc.access} onChange={(e) => post({ scenario: { access: e.target.checked ? { teamDomain: 'acme.cloudflareaccess.com', aud: 'a'.repeat(64) } : null } })} /> Access mode on (set via CLI)</label>
          <label><input type="checkbox" checked={sc.accessJwt} onChange={(e) => post({ scenario: { accessJwt: e.target.checked } })} /> …and Access fronted this request (JWT)</label>
          <label><input type="checkbox" checked={sc.accessUnreachable} onChange={(e) => post({ scenario: { accessUnreachable: e.target.checked } })} /> next Access enable → access_unreachable</label>
          <div className="proto-scenario-btns">
            <button onClick={() => post({ markSyncPending: true })}>+1 sync pending</button>
            <button onClick={() => post({ clearSyncPending: true })}>clear sync</button>
            <button onClick={() => post({ resetLoginLimiter: true })}>reset login limiter</button>
            <button onClick={() => post({ signOutEverywhere: true })}>expire sessions</button>
          </div>
          <pre>{JSON.stringify(s, null, 1)}</pre>
        </div>
      )}
    </div>
  );
}
