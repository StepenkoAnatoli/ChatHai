import { useEffect, useRef, useState } from 'react';
import { api, timeOf, visitorName } from './api.js';
import ChatPane from './ChatPane.jsx';
import Settings from './Settings.jsx';

export default function Dashboard({ token, site, onLogout }) {
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
        r.conversations.forEach((c) => {
          map[c.id] = c;
        });
        if (!stopped) setConvs(map);
      } catch (err) {
        if (err.status === 401) onLogout();
      }
    }

    function connect() {
      const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      const ws = new WebSocket(`${proto}${location.host}/ws?role=agent&token=${encodeURIComponent(token)}`);
      wsRef.current = ws;
      ws.onopen = () => {
        retry = 0;
        setOnline(true);
        load();
      };
      ws.onmessage = (e) => {
        let d;
        try {
          d = JSON.parse(e.data);
        } catch {
          return;
        }
        if (d.type === 'message') mergeConv(d.conv, d.message);
        else if (d.type === 'conversation') mergeConv(d.conv);
      };
      ws.onclose = () => {
        setOnline(false);
        if (stopped) return;
        load(); // after a server restart the old login is gone: this notices the 401 and shows the login form
        retry += 1;
        timer = setTimeout(connect, Math.min(15000, 500 * 2 ** retry));
      };
    }

    load();
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      wsRef.current?.close();
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
  useEffect(() => {
    document.title = `${totalUnread ? `(${totalUnread}) ` : ''}לוח בקרה לצ׳אט`;
  }, [totalUnread]);

  const list = Object.values(convs)
    .filter((c) => filter === 'all' || c.status === filter)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className="app">
      <div className="top">
        <h2>{site.name}</h2>
        <div className="tabs">
          <button className={`tab ${tab === 'chats' ? 'active' : ''}`} onClick={() => setTab('chats')}>
            צ׳אטים{totalUnread ? ` (${totalUnread})` : ''}
          </button>
          <button className={`tab ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>
            הגדרות
          </button>
        </div>
        <span title={online ? 'מחובר' : 'מתחבר מחדש'}>
          <span className={`dot ${online ? 'on' : ''}`}></span>
        </span>
        <button className="btn ghost" onClick={onLogout}>התנתקות</button>
      </div>

      {tab === 'settings' ? (
        <Settings token={token} site={site} />
      ) : (
        <div className={`layout ${current ? 'has-selection' : ''}`}>
          <div className="list">
            <div className="filter">
              <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value="open">שיחות פתוחות</option>
                <option value="closed">טופלו</option>
                <option value="all">הכול</option>
              </select>
            </div>
            {list.length === 0 && <div className="empty">אין שיחות עדיין.</div>}
            {list.map((c) => (
              <button key={c.id} className={`item ${c.id === selected ? 'sel' : ''}`} onClick={() => setSelected(c.id)}>
                <div className="row">
                  <span className={`dot ${c.online ? 'on' : ''}`}></span>
                  <b>{visitorName(c)}</b>
                  {c.urgent && <span className="pill urgent">דחוף</span>}
                  {c.needsHuman && !c.humanTakeover && <span className="pill human">דורש התייחסות</span>}
                  {c.unread > 0 && <span className="pill unread">{c.unread}</span>}
                  <small>{timeOf(c.updatedAt)}</small>
                </div>
                <div className="last" dir="auto">{c.lastMessage}</div>
              </button>
            ))}
          </div>
          {current ? (
            <ChatPane
              conv={current}
              onReply={(id, text) => sendWs({ type: 'reply', convId: id, text })}
              onClose={(id) => sendWs({ type: 'close', convId: id })}
              onBack={() => setSelected(null)}
            />
          ) : (
            <div className="chat"><div className="empty">בחרו שיחה.</div></div>
          )}
        </div>
      )}
    </div>
  );
}
