// Settings-side screens. The sections are shared; the variants only disagree on how they are grouped into pages
// (E: Settings + API keys, F: Settings + Security) and on how a new API key is revealed (E inline, F modal).
import { useEffect, useState } from 'react';
import { api, ago, ApiError, copy, type ApiKey } from './v1api';
import { Section, useShell } from './Shell';

// ---- E ----
export function SettingsPage() {
  const { variant } = useShell();
  return (
    <div className="s-page wide">
      <h1>Settings</h1>
      <InstanceFacts />
      <RootDestination />
      {variant === 'E' && <><Password /><AccessMode /></>}
    </div>
  );
}
export function ApiKeysPage() {
  return <div className="s-page wide"><h1>API keys</h1><ApiKeys reveal="inline" /></div>;
}
// ---- F ----
export function SecurityPage() {
  return (
    <div className="s-page wide">
      <h1>Security</h1>
      <Password />
      <AccessMode />
      <ApiKeys reveal="modal" />
    </div>
  );
}

function InstanceFacts() {
  const { settings, host } = useShell();
  return (
    <Section title="Instance">
      <dl className="s-dl">
        <dt>Hostname</dt><dd>{host}{host.endsWith('.workers.dev') && <span className="muted"> — workers.dev fallback. Attach your own domain with <code>npx furea domain set</code>.</span>}</dd>
        <dt>Version</dt><dd>{settings.version} <span className="muted">— upgrade with <code>npx furea@latest deploy</code></span></dd>
        <dt>Click analytics</dt>
        <dd>{settings.analyticsConfigured
          ? <>On <span className="muted">— countries, referrers, devices and time series for the last 90 days.</span></>
          : <>Off <span className="muted">— only exact lifetime totals are shown. Run <code>npx furea analytics-token</code> to add a read-only analytics token; it is a Worker secret, so it cannot be set here.</span></>}</dd>
      </dl>
    </Section>
  );
}

function RootDestination() {
  const { settings, reloadSettings, host } = useShell();
  const [v, setV] = useState(settings.rootDestination ?? '');
  const [e, setE] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  const save = async (value: string | null) => {
    try { await api.patchSettings({ rootDestination: value }); await reloadSettings(); setE(null); setSaved(true); if (value === null) setV(''); }
    catch (x) { setE(x as ApiError); setSaved(false); }
  };
  return (
    <Section title="Root destination">
      <p className="muted">
        What visitors get at <code>https://{host}/</code>.{' '}
        {settings.rootDestination
          ? <>Now: a 302 redirect to <a href={settings.rootDestination}>{settings.rootDestination}</a> (not counted as a click).</>
          : <>Now: a plain 404, like any unknown slug.</>}
      </p>
      <div className="s-row">
        <input style={{ flex: 1 }} placeholder="https://… (empty = 404)" value={v} onChange={(ev) => { setV(ev.target.value); setSaved(false); }} />
        <button className="primary" onClick={() => save(v.trim() || null)} disabled={(v.trim() || null) === settings.rootDestination}>Save</button>
        {settings.rootDestination && <button onClick={() => save(null)}>Clear</button>}
      </div>
      {e && <div className="s-field-err">{e.field('rootDestination') ?? e.message}</div>}
      {saved && <div className="s-ok">Saved. The root may take a few minutes to change worldwide.</div>}
    </Section>
  );
}

function Password() {
  const { settings } = useShell();
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const [e, setE] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  if (settings.access) return (
    <Section title="Operator password">
      <p className="muted">Password sign-in is off while Access mode is on. The password is kept and works again as soon as Access mode is turned off.</p>
    </Section>
  );
  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault(); setOk(false);
    if (f.next !== f.again) { setE('The new passwords do not match.'); return; }
    try { await api.changePassword(f.current, f.next); setF({ current: '', next: '', again: '' }); setE(null); setOk(true); }
    catch (x) { const ex = x as ApiError; setE(ex.field('newPassword') ?? ex.message); }
  };
  return (
    <Section title="Operator password">
      <form onSubmit={submit} style={{ maxWidth: 360 }}>
        <label>Current password<input type="password" autoComplete="current-password" value={f.current} onChange={(ev) => setF({ ...f, current: ev.target.value })} /></label>
        <label>New password <span className="muted">(at least 12 characters)</span><input type="password" autoComplete="new-password" value={f.next} onChange={(ev) => setF({ ...f, next: ev.target.value })} /></label>
        <label>New password again<input type="password" autoComplete="new-password" value={f.again} onChange={(ev) => setF({ ...f, again: ev.target.value })} /></label>
        {e && <div className="s-field-err">{e}</div>}
        {ok && <div className="s-ok">Password changed. Every other browser has been signed out.</div>}
        <button className="primary" style={{ marginTop: 10 }} disabled={!f.current || !f.next}>Change password</button>
      </form>
    </Section>
  );
}

function AccessMode() {
  const { settings, reloadSettings, host } = useShell();
  const [f, setF] = useState({ teamDomain: '', aud: '' });
  const [e, setE] = useState<ApiError | null>(null);
  const workersDev = host.endsWith('.workers.dev');
  const enable = async () => {
    if (!confirm(`Turn on Access mode?\n\nThe operator password stops working immediately. Make sure you can pass Cloudflare Access at https://${host}/admin/ first.\nIf you get locked out, run: npx furea access disable`)) return;
    try { await api.patchSettings({ access: f }); setE(null); location.reload(); } catch (x) { setE(x as ApiError); }
  };
  const disable = async () => {
    if (!confirm('Turn off Access mode?\n\nThe operator password becomes the way in again, and you will be asked for it now.')) return;
    await api.patchSettings({ access: null }); await reloadSettings(); location.reload();
  };
  if (settings.access) return (
    <Section title="Cloudflare Access" aside={<span className="badge">On</span>}>
      <p className="muted">Sign-in is handled by Cloudflare Access; the password login is off. API keys keep working.</p>
      <dl className="s-dl">
        <dt>Team domain</dt><dd><code>{settings.access.teamDomain}</code></dd>
        <dt>Audience (AUD)</dt><dd><code>{settings.access.aud.slice(0, 16)}…</code></dd>
      </dl>
      <button onClick={disable}>Turn off Access mode</button>
    </Section>
  );
  return (
    <Section title="Cloudflare Access" aside={<span className="badge off-grey">Off</span>}>
      <p className="muted">
        Replace the password with your organisation's Cloudflare Access login (SSO, MFA, several people).
        Create a self-hosted Access application for <code>{host}/admin</code> and <code>{host}/api</code> in Cloudflare Zero Trust, then paste its team domain and Application Audience tag here.
      </p>
      {workersDev ? (
        <div className="s-notice">
          <b>Needs your own domain.</b> On <code>{host}</code> an Access application would also gate every short link.
          Attach a domain with <code>npx furea domain set</code>, then open the admin surface there to turn this on.
        </div>
      ) : (
        <>
          <label>Team domain<input placeholder="yourteam.cloudflareaccess.com" value={f.teamDomain} onChange={(ev) => setF({ ...f, teamDomain: ev.target.value })} /></label>
          {e?.field('access.teamDomain') && <div className="s-field-err">{e.field('access.teamDomain')}</div>}
          <label>Application Audience (AUD) tag<input placeholder="64 hex characters" value={f.aud} onChange={(ev) => setF({ ...f, aud: ev.target.value })} /></label>
          {e?.field('access.aud') && <div className="s-field-err">{e.field('access.aud')}</div>}
          {e && !e.details.length && <div className="error">{e.message}</div>}
          <button className="primary" style={{ marginTop: 10 }} onClick={enable} disabled={!f.teamDomain || !f.aud}>Turn on Access mode</button>
        </>
      )}
    </Section>
  );
}

function ApiKeys({ reveal }: { reveal: 'inline' | 'modal' }) {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'read' | 'write'>('read');
  const [fresh, setFresh] = useState<(ApiKey & { key: string }) | null>(null);
  const [e, setE] = useState<ApiError | null>(null);
  const reload = () => api.apiKeys().then(setKeys);
  useEffect(() => { reload(); }, []);
  const create = async (ev: React.FormEvent) => {
    ev.preventDefault();
    try { setFresh(await api.createKey(name, scope)); setName(''); setE(null); reload(); } catch (x) { setE(x as ApiError); }
  };
  const revoke = async (k: ApiKey) => {
    if (!confirm(`Revoke "${k.name}"?\n\nScripts using ${k.prefix}… stop working immediately. This cannot be undone.`)) return;
    await api.revokeKey(k.id); reload();
  };
  const revealBox = fresh && (
    <div className={reveal === 'modal' ? 's-modal' : 's-reveal'}>
      <b>Copy the key for "{fresh.name}" now.</b> It is shown only this once; furea keeps only a hash.
      <div className="s-keybox"><code>{fresh.key}</code><button onClick={() => copy(fresh.key)}>Copy</button></div>
      <p className="muted s-small">Send it as <code>Authorization: Bearer {fresh.key.slice(0, 9)}…</code> to <code>/api/v1</code>.</p>
      <button className="primary" onClick={() => setFresh(null)}>I have copied it</button>
    </div>
  );
  return (
    <Section title="API keys">
      <p className="muted">
        For your own scripts calling <code>/api/v1</code>. A <b>read</b> key can list links and stats; a <b>write</b> key can also create, edit and delete links and set the root destination.
        No key can manage keys, the password or Access mode — that needs this signed-in page.
      </p>
      {reveal === 'inline' && revealBox}
      {reveal === 'modal' && fresh && <div className="s-modal-backdrop">{revealBox}</div>}
      <table className="s-table">
        <thead><tr><th>Name</th><th>Key</th><th>Scope</th><th>Created</th><th>Last used</th><th /></tr></thead>
        <tbody>
          {keys?.map((k) => (
            <tr key={k.id}>
              <td>{k.name}</td><td><code>{k.prefix}…</code></td><td><span className={`badge ${k.scope === 'write' ? 'sync' : ''}`}>{k.scope}</span></td>
              <td>{ago(k.createdAt)}</td><td>{ago(k.lastUsedAt)}</td>
              <td style={{ textAlign: 'right' }}><button className="danger" onClick={() => revoke(k)}>Revoke</button></td>
            </tr>
          ))}
          {keys?.length === 0 && <tr><td colSpan={6} className="muted">No API keys yet.</td></tr>}
        </tbody>
      </table>
      <form className="s-row" style={{ marginTop: 12 }} onSubmit={create}>
        <input placeholder="Name, e.g. deploy script" value={name} onChange={(ev) => setName(ev.target.value)} style={{ flex: 1 }} />
        <label className="s-radio"><input type="radio" checked={scope === 'read'} onChange={() => setScope('read')} /> read</label>
        <label className="s-radio"><input type="radio" checked={scope === 'write'} onChange={() => setScope('write')} /> write</label>
        <button className="primary" disabled={!name.trim()}>Create key</button>
      </form>
      {e && <div className="s-field-err">{e.field('name') ?? e.message}</div>}
    </Section>
  );
}
