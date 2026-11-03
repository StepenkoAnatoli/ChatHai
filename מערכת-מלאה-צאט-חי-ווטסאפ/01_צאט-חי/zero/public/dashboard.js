(function () {
  const { useState, useEffect, useRef } = React;
  const html = htm.bind(React.createElement);

  const storage = {
    get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  async function api(path, token, options = {}) {
    const res = await fetch(path, {
      method: options.method || 'GET',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'הבקשה נכשלה');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const timeOf = (ts) => new Date(ts).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  const visitorName = (c) => 'מבקר ' + c.visitorId.slice(0, 6);

  function Login({ onLogin }) {
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

    return html`
      <div className="center">
        <form className="card" onSubmit=${submit}>
          <h1>צ׳אט חי</h1>
          <p>התחברו כדי לענות למבקרים באתר.</p>
          <label htmlFor="login-key">מפתח האתר</label>
          <input id="login-key" type="text" value=${siteKey} onInput=${(e) => setSiteKey(e.target.value)} autoComplete="username" />
          <label htmlFor="login-password">סיסמה</label>
          <input id="login-password" type="password" value=${password} onInput=${(e) => setPassword(e.target.value)} autoComplete="current-password" />
          ${error && html`<div className="error">${error}</div>`}
          <div style=${{ marginTop: '16px' }}>
            <button className="btn" disabled=${busy || !siteKey || !password}>${busy ? 'מתחבר...' : 'התחברות'}</button>
          </div>
        </form>
      </div>
    `;
  }

  function ChatPane({ conv, onReply, onClose, onBack }) {
    const [text, setText] = useState('');
    const endRef = useRef(null);
    useEffect(() => { if (endRef.current) endRef.current.scrollIntoView(); }, [conv.id, conv.messages.length]);

    function submit(e) {
      e.preventDefault();
      const value = text.trim();
      if (!value) return;
      onReply(conv.id, value);
      setText('');
    }

    const who = { visitor: visitorName(conv), bot: 'בוט', agent: 'אתם' };
    return html`
      <div className="chat">
        <div className="chat-head">
          <button className="btn ghost back" onClick=${onBack}>חזרה</button>
          <b><span className=${'dot ' + (conv.online ? 'on' : '')}></span>${visitorName(conv)}</b>
          ${conv.humanTakeover ? html`<span className="pill human">אתם מטפלים בשיחה</span>` : html`<span className="pill">הבוט פעיל</span>`}
          ${conv.status === 'open' && html`<button className="btn danger" onClick=${() => onClose(conv.id)}>סיום טיפול</button>`}
        </div>
        <div className="msgs">
          ${conv.messages.map((m) => html`
            <${React.Fragment} key=${m.id}>
              <div className=${'meta ' + (m.from === 'visitor' ? '' : 'right')}>${who[m.from]} · ${timeOf(m.ts)}</div>
              <div className=${'msg ' + m.from} dir="auto">${m.text}</div>
            <//>
          `)}
          <div ref=${endRef}></div>
        </div>
        <form className="reply" onSubmit=${submit}>
          <input type="text" dir="auto" placeholder="כתבו תשובה..." value=${text} onInput=${(e) => setText(e.target.value)} maxLength="2000" />
          <button className="btn" disabled=${!text.trim()}>שליחה</button>
        </form>
      </div>
    `;
  }

  function Settings({ token, site }) {
    const [faq, setFaq] = useState(null);
    const [settings, setSettings] = useState(null);
    const [msg, setMsg] = useState('');
    const [error, setError] = useState('');

    useEffect(() => {
      Promise.all([api('/api/faq', token), api('/api/settings', token)])
        .then(([f, s]) => { setFaq(f.faq); setSettings({ ...s, origins: (s.allowedOrigins || []).join('\n') }); })
        .catch((err) => setError(err.message));
    }, [token]);

    if (error && !faq) return html`<div className="settings"><div className="error">${error}</div></div>`;
    if (!faq || !settings) return html`<div className="settings"><div className="empty">טוען...</div></div>`;

    const updateFaq = (i, field, value) => setFaq(faq.map((row, idx) => (idx === i ? { ...row, [field]: value } : row)));

    async function save() {
      setMsg('');
      setError('');
      try {
        const f = await api('/api/faq', token, { method: 'PUT', body: { faq } });
        setFaq(f.faq);
        await api('/api/settings', token, {
          method: 'PUT',
          body: {
            name: settings.name,
            color: settings.color,
            greeting: settings.greeting,
            fallback: settings.fallback,
            notifyEmail: settings.notifyEmail,
            privacyNote: settings.privacyNote,
            allowedOrigins: settings.origins.split('\n').map((s) => s.trim()).filter(Boolean),
          },
        });
        setMsg('נשמר');
        setTimeout(() => setMsg(''), 2500);
      } catch (err) {
        setError(err.message);
      }
    }

    const snippet = '<script src="' + location.origin + '/widget.js" data-site-key="' + site.key + '" async></script>';
    const set = (field) => (e) => setSettings({ ...settings, [field]: e.target.value });

    return html`
      <div className="settings">
        <div className="panel">
          <h3>הוספת הצ׳אט לאתר שלכם</h3>
          <p style=${{ color: '#6b7280', fontSize: '14px' }}>יש להדביק את הקוד בסוף כל עמוד באתר, ממש לפני סגירת תגית ה־body.</p>
          <code className="snippet">${snippet}</code>
        </div>
        <div className="panel">
          <h3>מראה והודעות</h3>
          <label htmlFor="set-name">שם העסק</label>
          <input id="set-name" type="text" value=${settings.name} onInput=${set('name')} />
          <label htmlFor="set-color">צבע</label>
          <input id="set-color" type="color" value=${settings.color} onInput=${set('color')} />
          <label htmlFor="set-greeting">ברכה למבקרים חדשים</label>
          <input id="set-greeting" type="text" value=${settings.greeting} onInput=${set('greeting')} />
          <label htmlFor="set-fallback">הודעה כשהבוט לא יודע את התשובה</label>
          <input id="set-fallback" type="text" value=${settings.fallback} onInput=${set('fallback')} />
          <label htmlFor="set-email">מייל להתראות כשאין נציג מחובר (לא חובה)</label>
          <input id="set-email" type="email" dir="ltr" value=${settings.notifyEmail} onInput=${set('notifyEmail')} />
          ${!settings.emailEnabled && html`<p style=${{ color: '#b45309', fontSize: '13px' }}>שליחת מיילים עדיין לא הוגדרה בשרת (RESEND_API_KEY ו־MAIL_FROM), ולכן לא יישלחו התראות.</p>`}
          <label htmlFor="set-privacy">הודעת פרטיות מתחת לשדה ההקלדה (אפשר להשאיר ריק)</label>
          <input id="set-privacy" type="text" value=${settings.privacyNote} onInput=${set('privacyNote')} />
          <label htmlFor="set-origins">אתרים מותרים (אחד בכל שורה, למשל https://shop.example.com). אם השדה ריק, כל אתר רשאי להשתמש בצ׳אט.</label>
          <textarea id="set-origins" value=${settings.origins} onInput=${set('origins')}></textarea>
        </div>
        <div className="panel">
          <h3>תשובות הבוט (שאלות נפוצות)</h3>
          <p style=${{ color: '#6b7280', fontSize: '14px' }}>הבוט עונה כשהודעת המבקר דומה לשאלה או למילות המפתח שלה. כל השאר מגיע אליכם.</p>
          ${faq.map((row, i) => html`
            <div className="faq-row" key=${i}>
              <label htmlFor=${'faq-q-' + i}>שאלה</label>
              <input id=${'faq-q-' + i} type="text" value=${row.q} onInput=${(e) => updateFaq(i, 'q', e.target.value)} />
              <label htmlFor=${'faq-a-' + i}>תשובה</label>
              <textarea id=${'faq-a-' + i} value=${row.a} onInput=${(e) => updateFaq(i, 'a', e.target.value)}></textarea>
              <label htmlFor=${'faq-k-' + i}>מילות מפתח נוספות (לא חובה)</label>
              <input id=${'faq-k-' + i} type="text" value=${row.keywords || ''} onInput=${(e) => updateFaq(i, 'keywords', e.target.value)} />
              <div style=${{ marginTop: '8px' }}>
                <button className="btn danger" onClick=${() => setFaq(faq.filter((_, idx) => idx !== i))}>הסרה</button>
              </div>
            </div>
          `)}
          <div style=${{ marginTop: '12px' }}>
            <button className="btn ghost" onClick=${() => setFaq([...faq, { q: '', a: '', keywords: '' }])}>הוספת שאלה</button>
          </div>
        </div>
        <div className="panel">
          <button className="btn" onClick=${save}>שמירת שינויים</button>
          ${msg && html`<span className="ok">${msg}</span>`}
          ${error && html`<span className="error" style=${{ marginInlineStart: '10px' }}>${error}</span>`}
        </div>
      </div>
    `;
  }

  function Dashboard({ token, site, onLogout }) {
    const [convs, setConvs] = useState({});
    const [selected, setSelected] = useState(null);
    const [tab, setTab] = useState('chats');
    const [filter, setFilter] = useState('open');
    const [online, setOnline] = useState(false);
    const wsRef = useRef(null);

    function mergeConv(summary, message) {
      setConvs((prev) => {
        const old = prev[summary.id] || { messages: [] };
        let messages = old.messages;
        if (message && !messages.some((m) => m.id === message.id)) messages = [...messages, message];
        return { ...prev, [summary.id]: { ...old, ...summary, messages } };
      });
    }

    useEffect(() => {
      let stopped = false;
      let retry = 0;
      let timer = null;

      async function load() {
        try {
          const r = await api('/api/conversations', token);
          const map = {};
          r.conversations.forEach((c) => { map[c.id] = c; });
          setConvs(map);
        } catch (err) {
          if (err.status === 401) onLogout();
        }
      }

      function connect() {
        const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
        const ws = new WebSocket(proto + location.host + '/ws?role=agent&token=' + encodeURIComponent(token));
        wsRef.current = ws;
        ws.onopen = () => { retry = 0; setOnline(true); load(); };
        ws.onmessage = (e) => {
          let d;
          try { d = JSON.parse(e.data); } catch (err) { return; }
          if (d.type === 'message') mergeConv(d.conv, d.message);
          else if (d.type === 'conversation') mergeConv(d.conv);
        };
        ws.onclose = () => {
          setOnline(false);
          if (stopped) return;
          load(); // after a server restart the old login is gone: this notices the 401 and shows the login form
          retry += 1;
          timer = setTimeout(connect, Math.min(15000, 500 * Math.pow(2, retry)));
        };
      }

      load();
      connect();
      return () => {
        stopped = true;
        clearTimeout(timer);
        if (wsRef.current) wsRef.current.close();
      };
    }, [token]);

    const sendWs = (obj) => {
      if (wsRef.current && wsRef.current.readyState === 1) wsRef.current.send(JSON.stringify(obj));
    };

    const current = selected ? convs[selected] : null;
    const currentUnread = current ? current.unread : 0;
    useEffect(() => {
      if (current && currentUnread > 0) sendWs({ type: 'read', convId: current.id });
    }, [selected, currentUnread]);

    const totalUnread = Object.values(convs).reduce((n, c) => n + (c.unread || 0), 0);
    useEffect(() => { document.title = (totalUnread ? '(' + totalUnread + ') ' : '') + 'לוח בקרה לצ׳אט'; }, [totalUnread]);

    const list = Object.values(convs)
      .filter((c) => filter === 'all' || c.status === filter)
      .sort((a, b) => b.updatedAt - a.updatedAt);

    return html`
      <div className="app">
        <div className="top">
          <h2>${site.name}</h2>
          <div className="tabs">
            <button className=${'tab ' + (tab === 'chats' ? 'active' : '')} onClick=${() => setTab('chats')}>צ׳אטים${totalUnread ? ' (' + totalUnread + ')' : ''}</button>
            <button className=${'tab ' + (tab === 'settings' ? 'active' : '')} onClick=${() => setTab('settings')}>הגדרות</button>
          </div>
          <span title=${online ? 'מחובר' : 'מתחבר מחדש'}><span className=${'dot ' + (online ? 'on' : '')}></span></span>
          <button className="btn ghost" onClick=${onLogout}>התנתקות</button>
        </div>
        ${tab === 'settings'
          ? html`<${Settings} token=${token} site=${site} />`
          : html`
            <div className=${'layout ' + (current ? 'has-selection' : '')}>
              <div className="list">
                <div className="filter">
                  <select value=${filter} onChange=${(e) => setFilter(e.target.value)}>
                    <option value="open">שיחות פתוחות</option>
                    <option value="closed">טופלו</option>
                    <option value="all">הכול</option>
                  </select>
                </div>
                ${list.length === 0 && html`<div className="empty">אין שיחות עדיין.</div>`}
                ${list.map((c) => html`
                  <button key=${c.id} className=${'item ' + (c.id === selected ? 'sel' : '')} onClick=${() => setSelected(c.id)}>
                    <div className="row">
                      <span className=${'dot ' + (c.online ? 'on' : '')}></span>
                      <b>${visitorName(c)}</b>
                      ${c.needsHuman && !c.humanTakeover && html`<span className="pill human">דורש התייחסות</span>`}
                      ${c.unread > 0 && html`<span className="pill unread">${c.unread}</span>`}
                      <small>${timeOf(c.updatedAt)}</small>
                    </div>
                    <div className="last" dir="auto">${c.lastMessage}</div>
                  </button>
                `)}
              </div>
              ${current
                ? html`<${ChatPane}
                    conv=${current}
                    onReply=${(id, text) => sendWs({ type: 'reply', convId: id, text })}
                    onClose=${(id) => sendWs({ type: 'close', convId: id })}
                    onBack=${() => setSelected(null)} />`
                : html`<div className="chat"><div className="empty">בחרו שיחה.</div></div>`}
            </div>`}
      </div>
    `;
  }

  function App() {
    const [token, setToken] = useState(storage.get('token'));
    const [site, setSite] = useState(() => {
      try { return JSON.parse(storage.get('site')); } catch (e) { return null; }
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

    if (!token || !site) return html`<${Login} onLogin=${onLogin} />`;
    return html`<${Dashboard} token=${token} site=${site} onLogout=${onLogout} />`;
  }

  ReactDOM.createRoot(document.getElementById('root')).render(html`<${App} />`);
})();
