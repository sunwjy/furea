// PROTOTYPE (ticket #20) — the confirmed admin shell from ticket #11 (feed, /new page, /links/:slug page) plus the
// screens it lacked: login, API keys, settings, the degraded no-analytics layout and the sync-pending state.
// Two variants disagree on one structural question: where do credentials live?
//   E — "Links · API keys · Settings": API keys are their own page; Settings holds everything else. Key reveal inline.
//   F — "Links · Security · Settings": Security groups password / Access / API keys; Settings is instance behaviour
//       only (root destination, facts). Key reveal in a modal.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError, type Session, type Settings } from './v1api';
import { Feed, LinkPage, NewLink } from './Links';
import { ApiKeysPage, SecurityPage, SettingsPage } from './Admin';
import { AddLinks, CampaignList, CampaignPage, NewCampaign } from './Campaigns';
import { ScenarioPanel } from './ScenarioPanel';
import './shell.css';

// G/H/I (ticket #33) are F plus campaign screens; see Campaigns.tsx
export type Variant = 'E' | 'F' | 'G' | 'H' | 'I';
type Ctx = { variant: Variant; session: Session; settings: Settings; reloadSettings: () => Promise<void>; host: string };
const ShellCtx = createContext<Ctx>(null as unknown as Ctx);
export const useShell = () => useContext(ShellCtx);

// keep ?variant= on every in-app link
export function useTo() {
  const { search } = useLocation();
  return (pathname: string) => ({ pathname, search });
}

// the mock's simulated Host (own domain vs workers.dev); in the real Worker this is just location.host
const HostCtx = createContext('s.example.com');
export const useHost = () => useContext(HostCtx);

export function Shell({ variant }: { variant: Variant }) {
  const [host, setHost] = useState<string | null>(null);
  useEffect(() => { fetch('/__proto/state').then((r) => r.json()).then((s) => setHost(s.scenario.host)); }, []);
  if (!host) return null;
  return (
    <HostCtx.Provider value={host}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Authed variant={variant} />} />
      </Routes>
      <ScenarioPanel />
    </HostCtx.Provider>
  );
}

function Authed({ variant }: { variant: Variant }) {
  const [session, setSession] = useState<Session | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const navigate = useNavigate();
  const loc = useLocation();
  const to = useTo();
  const reloadSettings = () => api.settings().then(setSettings);
  useEffect(() => {
    const out = () => navigate({ pathname: '/login', search: loc.search }, { replace: true, state: { from: loc.pathname } });
    window.addEventListener('furea:unauthorized', out);
    api.session().then(setSession).then(reloadSettings).catch(() => {});
    return () => window.removeEventListener('furea:unauthorized', out);
  }, []);
  const host = useHost();
  if (!session || !settings) return <div className="s-loading">Loading…</div>;
  const logout = async () => {
    if (session.kind === 'access') { alert('PROTOTYPE: would navigate to /cdn-cgi/access/logout (Cloudflare Access sign-out).'); return; }
    await api.logout(); navigate(to('/login'));
  };
  return (
    <ShellCtx.Provider value={{ variant, session, settings, reloadSettings, host }}>
      <div className="c-root">
        <nav className="s-nav">
          <b>furea</b>
          <NavLink to={to('/')} end>Links</NavLink>
          {(variant === 'G' || variant === 'I') && <NavLink to={to('/campaigns')}>Campaigns</NavLink>}
          {variant === 'E' ? <NavLink to={to('/keys')}>API keys</NavLink> : <NavLink to={to('/security')}>Security</NavLink>}
          <NavLink to={to('/settings')}>Settings</NavLink>
          <span className="s-who">
            {session.kind === 'access' ? 'Signed in with Cloudflare Access' : 'Signed in'}
            <button className="ghost" onClick={logout}>Log out</button>
          </span>
        </nav>
        <Routes>
          <Route path="/" element={<Feed />} />
          <Route path="/new" element={<NewLink />} />
          <Route path="/links/:slug" element={<LinkPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          {variant !== 'H' && <Route path="/campaigns" element={<CampaignList />} />}
          <Route path="/campaigns/new" element={<NewCampaign />} />
          <Route path="/campaigns/:id" element={<CampaignPage />} />
          {variant === 'G' && <Route path="/campaigns/:id/add" element={<AddLinks />} />}
          {variant === 'E' ? <Route path="/keys" element={<ApiKeysPage />} /> : <Route path="/security" element={<SecurityPage />} />}
          <Route path="*" element={<Navigate to={to('/')} replace />} />
        </Routes>
      </div>
    </ShellCtx.Provider>
  );
}

// ---- /admin/login ----
function Login() {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [failed, setFailed] = useState(0);
  const [retryAt, setRetryAt] = useState(0);
  const [, tick] = useState(0);
  const navigate = useNavigate();
  const loc = useLocation();
  const from = (loc.state as { from?: string } | null)?.from ?? '/';
  const host = useHost();
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  const wait = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    try { await api.login(pw); navigate({ pathname: from, search: loc.search }, { replace: true }); }
    catch (x) {
      const ex = x as ApiError; setError(ex);
      if (ex.code === 'invalid_password') { setFailed((n) => n + 1); setPw(''); }
      if (ex.code === 'rate_limited') setRetryAt(Date.now() + (ex.retryAfter ?? 60) * 1000);
    } finally { setBusy(false); }
  };

  // login_disabled gets its own screen: the password form is the wrong door, not a wrong answer
  if (error?.code === 'login_disabled') return (
    <div className="s-login">
      <div className="s-login-card">
        <h1>furea</h1>
        <h2>This instance uses Cloudflare Access</h2>
        <p>Password sign-in is turned off. Sign in through your organisation's Cloudflare Access login instead.</p>
        <p className="muted">You reached this page without an Access session, which usually means the Access application does not cover <code>/admin/*</code> and <code>/api/*</code> on this hostname. Check the application in Cloudflare Zero Trust.</p>
        <p className="muted">Locked out? From a machine with Cloudflare credentials run <code>npx furea access disable</code> to switch back to the password.</p>
      </div>
    </div>
  );

  return (
    <div className="s-login">
      <form className="s-login-card" onSubmit={submit}>
        <h1>furea</h1>
        <p className="muted" style={{ marginTop: 0 }}>{host}</p>
        <label>Operator password
          <input type="password" autoFocus autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} disabled={wait > 0} />
        </label>
        {error?.code === 'invalid_password' && <div className="s-field-err">Wrong password.</div>}
        {wait > 0 && <div className="error">Too many attempts. Try again in {wait} s.</div>}
        {error && !['invalid_password', 'rate_limited'].includes(error.code) && <div className="error">{error.message}</div>}
        <button className="primary" style={{ width: '100%', marginTop: 12 }} disabled={busy || wait > 0 || !pw}>{busy ? 'Signing in…' : 'Sign in'}</button>
        {failed > 0 && <p className="muted s-small">Forgot the password? Run <code>npx furea reset-password</code> to set a new one.</p>}
        <p className="muted s-small">Mock password: <code>furea-proto</code></p>
      </form>
    </div>
  );
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="s-section">
      <div className="s-section-head"><h2>{title}</h2>{aside}</div>
      {children}
    </section>
  );
}
