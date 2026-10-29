/*
 * Live chat widget. Embed with:
 *   <script src="https://YOUR-SERVER/widget.js" data-site-key="SITE_KEY" async></script>
 */
(function () {
  var script = document.currentScript;
  if (!script || window.__liveChatLoaded) return;
  var siteKey = script.getAttribute('data-site-key');
  if (!siteKey) return console.warn('[livechat] missing data-site-key');
  window.__liveChatLoaded = true;

  var origin = new URL(script.src).origin;
  var wsUrl = origin.replace(/^http/, 'ws') + '/ws';

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch (e) {
      return null;
    }
  }

  var vid = store('lc_vid');
  if (!vid || !/^[A-Za-z0-9_-]{8,64}$/.test(vid)) {
    var bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    vid = Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    store('lc_vid', vid);
  }

  fetch(origin + '/api/site-config?key=' + encodeURIComponent(siteKey))
    .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('unknown site')); })
    .then(init)
    .catch(function (e) { console.warn('[livechat]', e.message); });

  function el(tag, props, children) {
    var node = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'class') node.className = props[k];
      else if (k === 'text') node.textContent = props[k];
      else node.setAttribute(k, props[k]);
    });
    (children || []).forEach(function (c) { node.appendChild(c); });
    return node;
  }

  function init(config) {
    var color = /^#[0-9a-fA-F]{6}$/.test(config.color) ? config.color : '#2563eb';
    var host = el('div', { id: 'livechat-host' });
    var root = host.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent =
      ':host{all:initial}' +
      '*{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}' +
      '.bubble{position:fixed;right:20px;bottom:20px;width:58px;height:58px;border-radius:50%;border:0;background:' + color + ';color:#fff;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;z-index:2147483646}' +
      '.bubble svg{width:28px;height:28px;fill:#fff}' +
      '.badge{position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;border-radius:10px;background:#ef4444;color:#fff;font-size:12px;display:none;align-items:center;justify-content:center;padding:0 5px}' +
      '.panel{position:fixed;right:20px;bottom:90px;width:360px;max-width:calc(100vw - 24px);height:520px;max-height:calc(100vh - 110px);background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.3);display:none;flex-direction:column;overflow:hidden;z-index:2147483647}' +
      '.panel.open{display:flex}' +
      '.head{background:' + color + ';color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:space-between}' +
      '.head b{font-size:16px}.head small{display:block;opacity:.85;font-size:12px;margin-top:2px}' +
      '.close{background:none;border:0;color:#fff;font-size:24px;line-height:1;cursor:pointer;padding:4px 8px}' +
      '.msgs{flex:1;overflow-y:auto;padding:14px;background:#f5f6f8;display:flex;flex-direction:column;gap:8px}' +
      '.m{max-width:80%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}' +
      '.m.visitor{align-self:flex-start;background:' + color + ';color:#fff;border-bottom-right-radius:4px}' +
      '.m.bot,.m.agent{align-self:flex-end;background:#fff;color:#111;border-bottom-left-radius:4px;box-shadow:0 1px 2px rgba(0,0,0,.08)}' +
      '.who{font-size:11px;color:#6b7280;margin:0 4px -4px;align-self:flex-end}.who.visitor{align-self:flex-start}' +
      '.status{text-align:center;font-size:12px;color:#9ca3af;padding:4px}' +
      '.privacy{text-align:center;font-size:11px;color:#6b7280;padding:0 10px 8px;background:#fff}' +
      'form{display:flex;gap:8px;padding:10px;border-top:1px solid #e5e7eb;background:#fff}' +
      'input{flex:1;min-width:0;border:1px solid #d1d5db;border-radius:20px;padding:10px 14px;font-size:16px;outline:none}' +
      'input:focus{border-color:' + color + '}' +
      'button.send{border:0;background:' + color + ';color:#fff;border-radius:20px;padding:0 16px;font-size:14px;cursor:pointer}';
    root.appendChild(style);

    var badge = el('span', { class: 'badge' });
    var bubble = el('button', { class: 'bubble', 'aria-label': 'פתיחת צ\u2019אט' }, [badge]);
    bubble.insertAdjacentHTML('afterbegin', '<svg viewBox="0 0 24 24"><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-5 4V6a2 2 0 0 1 1-2z"/></svg>');

    var title = el('b', { text: config.name });
    var sub = el('small', { text: 'בדרך כלל עונים תוך כמה דקות' });
    var closeBtn = el('button', { class: 'close', 'aria-label': 'סגירת הצ\u2019אט', text: '×' });
    var head = el('div', { class: 'head' }, [el('div', {}, [title, sub]), closeBtn]);
    var msgs = el('div', { class: 'msgs' });
    var status = el('div', { class: 'status', text: 'מתחבר…' });
    var input = el('input', { type: 'text', placeholder: 'כתבו הודעה…', maxlength: '2000', dir: 'auto', autocomplete: 'off' });
    var sendBtn = el('button', { class: 'send', type: 'submit', text: 'שליחה' });
    var form = el('form', {}, [input, sendBtn]);
    var panel = el('div', { class: 'panel', role: 'dialog', 'aria-label': 'צ\u2019אט', dir: 'rtl', lang: 'he' }, [head, msgs, status, form].concat(config.privacyNote ? [el('div', { class: 'privacy', text: String(config.privacyNote) })] : []));
    root.appendChild(panel);
    root.appendChild(bubble);
    if (document.body) document.body.appendChild(host);
    else document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(host); });

    var open = false;
    var unread = 0;
    var seen = {};
    var hasHistory = false;
    var seenKey = 'lc_seen_' + siteKey;
    var lastSeen = Number(store(seenKey)) || 0; // timestamp of the newest reply the visitor has actually seen
    var latestTs = 0;

    function markSeen(ts) {
      if (ts > lastSeen) {
        lastSeen = ts;
        store(seenKey, String(ts));
      }
    }

    function render(message) {
      if (seen[message.id]) return;
      seen[message.id] = true;
      var label = message.from === 'visitor' ? 'אני' : message.from === 'bot' ? 'עוזר אוטומטי' : 'צוות התמיכה';
      msgs.appendChild(el('div', { class: 'who ' + message.from, text: label }));
      msgs.appendChild(el('div', { class: 'm ' + message.from, dir: 'auto', text: message.text }));
      msgs.scrollTop = msgs.scrollHeight;
      if (message.ts > latestTs) latestTs = message.ts;
      if (message.from !== 'visitor' && message.ts > lastSeen) {
        if (open) {
          markSeen(message.ts);
        } else {
          unread += 1;
          badge.textContent = String(unread);
          badge.style.display = 'flex';
        }
      }
    }

    function setOpen(next) {
      open = next;
      panel.classList.toggle('open', open);
      if (open) {
        unread = 0;
        badge.style.display = 'none';
        markSeen(latestTs);
        msgs.scrollTop = msgs.scrollHeight;
        input.focus();
      }
    }
    bubble.addEventListener('click', function () { setOpen(!open); });
    closeBtn.addEventListener('click', function () { setOpen(false); });

    var ws = null;
    var retry = 0;

    function connect() {
      ws = new WebSocket(wsUrl + '?role=visitor&key=' + encodeURIComponent(siteKey) + '&vid=' + encodeURIComponent(vid));
      ws.onopen = function () {
        retry = 0;
        status.textContent = '';
        status.style.display = 'none';
      };
      ws.onmessage = function (e) {
        var data;
        try { data = JSON.parse(e.data); } catch (err) { return; }
        if (data.type === 'history') {
          if (!hasHistory) {
            hasHistory = true;
            if (!data.messages.length) {
              render({ id: 'greeting', from: 'bot', text: config.greeting });
            }
          }
          data.messages.forEach(render);
        } else if (data.type === 'message') {
          render(data.message);
        } else if (data.type === 'error' && data.code === 'rate_limited') {
          status.textContent = 'שולחים הודעות מהר מדי. אפשר להמתין רגע.';
          status.style.display = 'block';
        }
      };
      ws.onclose = function () {
        status.textContent = 'מתחבר מחדש…';
        status.style.display = 'block';
        retry += 1;
        setTimeout(connect, Math.min(15000, 500 * Math.pow(2, retry)));
      };
    }
    connect();

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = input.value.trim();
      if (!text || !ws || ws.readyState !== 1) return;
      ws.send(JSON.stringify({ type: 'message', text: text }));
      input.value = '';
    });
  }
})();
