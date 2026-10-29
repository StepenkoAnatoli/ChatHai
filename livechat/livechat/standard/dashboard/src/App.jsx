import { useState } from 'react';
import { api, storage } from './api.js';
import Login from './Login.jsx';
import Dashboard from './Dashboard.jsx';

export default function App() {
  const [token, setToken] = useState(() => storage.get('token'));
  const [site, setSite] = useState(() => {
    try {
      return JSON.parse(storage.get('site'));
    } catch {
      return null;
    }
  });

  function onLogin(t, s) {
    storage.set('token', t);
    storage.set('site', JSON.stringify(s));
    storage.set('siteKey', s.key);
    setToken(t);
    setSite(s);
  }

  function onLogout() {
    const old = storage.get('token');
    if (old) api('/api/logout', old, { method: 'POST' }).catch(() => {});
    storage.del('token');
    storage.del('site');
    setToken(null);
    setSite(null);
  }

  if (!token || !site) return <Login onLogin={onLogin} />;
  return <Dashboard token={token} site={site} onLogout={onLogout} />;
}
