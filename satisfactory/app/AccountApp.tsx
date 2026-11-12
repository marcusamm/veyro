import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Factory, KeyRound, LogIn, Plus, RefreshCw, X } from 'lucide-react';
import Planner from './Planner';
import type { AccountUser, Player } from './data/types';

type Session = { user: AccountUser; players: Player[] };
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const data = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw Object.assign(new Error(data.error || (response.status === 401 ? 'Please sign in again.' : 'The request could not be completed. Please try again.')), { status: response.status });
  return data as T;
}

export default function AccountApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reauth, setReauth] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  async function refresh() {
    const next = await request<Session>('/api/auth/me');
    setSession(next);
    setError('');
    return next;
  }
  useEffect(() => {
    refresh().catch(e => { if (e.status !== 401) setError(e.message); }).finally(() => setLoading(false));
  }, []);
  useEffect(() => { if (reauth) dialog.current?.showModal(); }, [reauth]);
  async function loggedIn() { await refresh(); setReauth(false); }
  async function signOut() {
    setLeaving(true);
    try { await request('/api/auth/logout', 'POST', {}); setSession(null); setReauth(false); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not sign out. Please retry.'); }
    finally { setLeaving(false); }
  }
  if (loading) return <main className="login-page"><div className="login-card"><Factory size={28}/><h1>Satisfactory venner</h1><p role="status">Opening your planner…</p></div></main>;
  if (!session) return <main className="login-page"><div className="login-card"><span className="login-mark"><Factory size={28}/></span><h1>Satisfactory venner</h1><p>A shared plan for our factory.</p>{error && <div className="account-alert" role="alert">{error}<button type="button" onClick={() => { setError(''); setLoading(true); refresh().catch(e => { if (e.status !== 401) setError(e.message); }).finally(() => setLoading(false)); }}>Retry connection</button></div>}<LoginForm onSuccess={loggedIn}/><p className="login-help">Use the username and password Marcus has given you. Only Marcus can add new players.</p><small>A separate login for this site.</small></div></main>;
  return <><Planner user={session.user} players={session.players} onSignOut={signOut} signingOut={leaving} onSignIn={() => setReauth(true)} accountPanel={<AccountsPanel user={session.user} players={session.players} onRefresh={refresh}/>}/>{error && <div className="account-global-error" role="alert">{error}<button aria-label="Dismiss account message" onClick={() => setError('')}><X size={16}/></button></div>}{reauth && <dialog ref={dialog} className="editor account-login-dialog" onCancel={() => setReauth(false)}><div className="login-card"><button className="icon-button login-close" aria-label="Close sign in" onClick={() => setReauth(false)}><X size={20}/></button><h2>Sign in again</h2><p>Your unsaved plan stays open while you sign in.</p><LoginForm onSuccess={loggedIn}/></div></dialog>}</>;
}

function LoginForm({ onSuccess }: { onSuccess: () => Promise<void> }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await request('/api/auth/login', 'POST', { username: username.trim().toLowerCase(), password }); setPassword(''); await onSuccess(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not sign in.'); }
    finally { setBusy(false); }
  }
  return <form className="account-form" onSubmit={submit}><label>Username<input name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={32} value={username} onChange={e => setUsername(e.target.value)} disabled={busy}/></label><label>Password<input type="password" name="password" autoComplete="current-password" required maxLength={128} value={password} onChange={e => setPassword(e.target.value)} disabled={busy}/></label>{error && <p className="account-alert" role="alert">{error}</p>}<button className="primary-button" disabled={busy}><LogIn size={16}/>{busy ? 'Signing in…' : 'Sign in'}</button></form>;
}

function AccountsPanel({ user, players, onRefresh }: { user: AccountUser; players: Player[]; onRefresh: () => Promise<unknown> }) {
  const admin = user.role === 'admin' && user.username === 'marcus';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [create, setCreate] = useState({ username: '', displayName: '', password: '' });
  const [editing, setEditing] = useState<Player | null>(null);
  const [name, setName] = useState('');
  const [resetPassword, setResetPassword] = useState('');
  const [passwords, setPasswords] = useState({ current: '', next: '', confirm: '' });
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (editing) dialog.current?.showModal(); }, [editing]);
  async function run(action: () => Promise<void>, success: string) {
    setBusy(true); setError(''); setMessage('');
    try { await action(); await onRefresh(); setMessage(success); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save. Please retry.'); }
    finally { setBusy(false); }
  }
  async function add(event: FormEvent) {
    event.preventDefault();
    await run(async () => { await request('/api/players', 'POST', { ...create, username: create.username.trim().toLowerCase(), displayName: create.displayName.trim() }); setCreate({ username: '', displayName: '', password: '' }); }, 'Player added. They can now sign in with the username and password you chose.');
  }
  async function update(event: FormEvent) {
    event.preventDefault(); if (!editing) return;
    await run(async () => { await request('/api/players/' + encodeURIComponent(editing.id), 'PATCH', { displayName: name.trim(), ...(resetPassword ? { password: resetPassword } : {}) }); setEditing(null); setResetPassword(''); }, resetPassword ? 'Player updated. Their previous sessions have been signed out.' : 'Player updated.');
  }
  async function changePassword(event: FormEvent) {
    event.preventDefault();
    if (passwords.next !== passwords.confirm) { setError('The new passwords do not match.'); return; }
    await run(async () => { await request('/api/auth/password', 'POST', { currentPassword: passwords.current, newPassword: passwords.next }); setPasswords({ current: '', next: '', confirm: '' }); }, 'Your password has been changed.');
  }
  return <section className="accounts-page"><div className="chapter-heading"><div><h1>Players & account</h1><p>{admin ? 'Add your friends here. Each player gets their own username and password.' : 'Everyone here shares the same checklist, recipes and notes.'}</p></div><button type="button" className="outline-button" disabled={busy} onClick={() => run(async () => {}, 'Player list refreshed.')}><RefreshCw size={15}/>Refresh</button></div>{error && <div className="account-alert" role="alert">{error}</div>}{message && <div className="account-success" role="status">{message}</div>}<div className="accounts-grid"><section className="panel players-panel"><h2>Players <span className="muted">({players.filter(p => p.active).length})</span></h2><ul className="player-list">{players.map(player => <li key={player.id}><span className={'avatar ' + (player.active ? '' : 'inactive')}>{player.displayName.slice(0, 1).toUpperCase()}</span><div className="player-summary"><strong>{player.displayName}{player.id === user.id && <small> · you</small>}</strong><span>@{player.username} · {player.role === 'admin' ? 'Administrator' : player.active ? 'Player' : 'Inactive'}</span></div>{admin && <div className="player-actions"><button type="button" className="outline-button" disabled={busy} onClick={() => { setEditing(player); setName(player.displayName); setResetPassword(''); setError(''); }}>Edit</button>{player.username !== 'marcus' && <button type="button" className="outline-button" disabled={busy} onClick={() => run(async () => { await request('/api/players/' + encodeURIComponent(player.id), 'PATCH', { active: !player.active }); }, player.active ? 'Player deactivated. Their access and sessions have been revoked.' : 'Player reactivated.')} >{player.active ? 'Deactivate' : 'Reactivate'}</button>}</div>}</li>)}</ul><p className="account-help">Marcus is the only administrator. {admin ? 'Deactivation keeps a player’s existing task assignments, but stops them signing in.' : 'Ask Marcus if you need another player added.'}</p></section>{admin && <section className="panel account-form-panel"><h2><Plus size={18}/>Add a player</h2><form className="account-form" onSubmit={add}><label>Display name<input value={create.displayName} onChange={e => setCreate({ ...create, displayName: e.target.value })} required maxLength={80} disabled={busy} autoComplete="off"/></label><label>Username<input value={create.username} onChange={e => setCreate({ ...create, username: e.target.value })} required minLength={3} maxLength={32} pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]{2,31}" title="3–32 letters, numbers, underscores, hyphens or dots" disabled={busy} autoComplete="off" autoCapitalize="none" spellCheck={false}/></label><label>Initial password<input type="password" value={create.password} onChange={e => setCreate({ ...create, password: e.target.value })} required minLength={8} maxLength={128} disabled={busy} autoComplete="new-password"/></label><p className="account-help">At least 8 characters. Give the username and password to your friend; they can change their own password after signing in.</p><button className="primary-button" disabled={busy}><Plus size={16}/>{busy ? 'Saving…' : 'Add player'}</button></form></section>}<section className="panel account-form-panel"><h2><KeyRound size={18}/>Your password</h2><p className="muted">Signed in as <strong>@{user.username}</strong></p><form className="account-form" onSubmit={changePassword}><label>Current password<input type="password" required maxLength={128} value={passwords.current} onChange={e => setPasswords({ ...passwords, current: e.target.value })} disabled={busy} autoComplete="current-password"/></label><label>New password<input type="password" required minLength={8} maxLength={128} value={passwords.next} onChange={e => setPasswords({ ...passwords, next: e.target.value })} disabled={busy} autoComplete="new-password"/></label><label>Repeat new password<input type="password" required minLength={8} maxLength={128} value={passwords.confirm} onChange={e => setPasswords({ ...passwords, confirm: e.target.value })} disabled={busy} autoComplete="new-password"/></label><button className="outline-button" disabled={busy}><KeyRound size={16}/>{busy ? 'Saving…' : 'Change password'}</button></form></section></div>{editing && <dialog ref={dialog} className="editor account-editor" onCancel={event => { if (busy) event.preventDefault(); else setEditing(null); }}><form onSubmit={update}><header><h2>Edit @{editing.username}</h2><button type="button" className="icon-button" aria-label="Close player editor" disabled={busy} onClick={() => setEditing(null)}><X size={20}/></button></header><div className="editor-body account-form"><label>Display name<input value={name} onChange={e => setName(e.target.value)} maxLength={80} required disabled={busy}/></label>{editing.id !== user.id && <label>Reset password <small>(leave blank to keep it)</small><input type="password" value={resetPassword} onChange={e => setResetPassword(e.target.value)} minLength={8} maxLength={128} autoComplete="new-password" disabled={busy}/></label>}{editing.id === user.id && <p className="account-help">Use “Your password” below to change your own password.</p>}{error && <p className="account-alert" role="alert">{error}</p>}</div><footer><button type="button" className="outline-button" disabled={busy} onClick={() => setEditing(null)}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? 'Saving…' : 'Save player'}</button></footer></form></dialog>}</section>;
}
