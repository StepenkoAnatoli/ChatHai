import { useState } from 'react';
import { api, storage } from './api.js';

export default function Login({ onLogin }) {
  const [siteKey, setSiteKey] = useState(storage.get('siteKey') || '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api('/api/login', null, { method: 'POST', body: { siteKey: siteKey.trim(), password } });
      onLogin(r.token, r.site);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <form className="card" onSubmit={submit}>
        <h1>צ׳אט חי</h1>
        <p>התחברו כדי לענות למבקרים באתר.</p>
        <label htmlFor="login-key">מפתח האתר</label>
        <input id="login-key" type="text" value={siteKey} onChange={(e) => setSiteKey(e.target.value)} autoComplete="username" />
        <label htmlFor="login-password">סיסמה</label>
        <input id="login-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        {error && <div className="error">{error}</div>}
        <div style={{ marginTop: '16px' }}>
          <button className="btn" disabled={busy || !siteKey || !password}>
            {busy ? 'מתחבר...' : 'התחברות'}
          </button>
        </div>
      </form>
    </div>
  );
}
