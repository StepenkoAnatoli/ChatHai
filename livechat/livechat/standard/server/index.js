import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createStore, verifyPassword, hashPassword, normalizeOrigins } from './store.js';
import { DEFAULT_PRIVACY_NOTE, DEFAULT_EMERGENCY_REPLY } from './store.js';
import { createNotifier, isEmail, normalizePhone } from './notify.js';
import { matchFaq, aiReply, isEmergency } from './bot.js';
import { createCallBridge } from './callbridge.js';
import { safeEqual, verifyMetaSignature, extractWaMessages, wantsCallback, localPhone } from './missedcall.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, 'public');
const DEFAULT_DIST = path.join(here, '..', 'dashboard', 'dist');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const DUMMY_HASH = hashPassword('dummy-password');
// Record of what the caller received. The words that really go out are in the template approved at Meta.
const DEFAULT_MISSED_CALL_TEXT = (site) => `החמצנו את שיחתך אל ${site.name}. אפשר לכתוב כאן במה מדובר ונחזור אליך.`;

export function startServer({
  port = Number(process.env.PORT) || 3000,
  dataFile = process.env.DATA_FILE || path.join(here, 'data.json'),
  seedDemo = process.env.SEED_DEMO ? process.env.SEED_DEMO === '1' : process.env.NODE_ENV !== 'production',
  trustProxy = process.env.TRUST_PROXY === '1',
  ipMessagesPerMinute = Number(process.env.IP_MESSAGES_PER_MINUTE) || 120,
  ipNewConversationsPerHour = Number(process.env.IP_NEW_CONVERSATIONS_PER_HOUR) || 30,
  adminToken = process.env.ADMIN_TOKEN || '',
  distDir = process.env.DASHBOARD_DIST || DEFAULT_DIST,
  notifier = createNotifier(),
  callBridge = createCallBridge(),
  // Missed-call flow. The endpoint is off (404) until MISSED_CALL_SECRET is set.
  missedCallSecret = process.env.MISSED_CALL_SECRET || '',
  missedCallTemplate = process.env.WHATSAPP_MISSED_TEMPLATE || '', // approved template, one body variable: the business name
  missedCallLang = process.env.WHATSAPP_MISSED_TEMPLATE_LANG || 'he',
  waVerifyToken = process.env.WHATSAPP_VERIFY_TOKEN || '',
  waAppSecret = process.env.WHATSAPP_APP_SECRET || '',
  missedCallsPerMinute = Number(process.env.MISSED_CALLS_PER_MINUTE) || 30,
  callbacksPerDay = Number(process.env.CALLBACKS_PER_DAY) || 20,
} = {}) {
  if (adminToken && adminToken.length < 16) throw new Error('ADMIN_TOKEN חייב להכיל לפחות 16 תווים');
  if (missedCallSecret && missedCallSecret.length < 16) throw new Error('MISSED_CALL_SECRET חייב להכיל לפחות 16 תווים');

  const store = createStore(dataFile);
  if (seedDemo && Object.keys(store.data.sites).length === 0) {
    store.createSite({ name: 'חנות הדגמה', key: 'demo', password: 'demo123' });
    console.log('נוצר אתר הדגמה: מפתח "demo", סיסמה "demo123". יש למחוק או להחליף אותו לפני עלייה לאוויר.');
  }

  const tokens = new Map(); // token -> { siteKey, exp }
  const agents = new Map(); // siteKey -> Set<ws>
  const visitors = new Map(); // convId -> Set<ws>
  const sockets = new Set();
  const loginAttempts = new Map(); // ip -> { count, reset } (failed attempts only)
  const msgStamps = new Map(); // convId -> timestamps of recent visitor messages
  const queues = new Map(); // convId -> tail of the bot-reply chain
  const ipMsgs = new Map(); // ip -> recent visitor message times
  const ipNewConvs = new Map(); // ip -> recent new-conversation times
  const missedStamps = new Map(); // 'all' | siteKey | siteKey:caller -> recent missed-call times
  const callbackStamps = new Map(); // siteKey -> recent callback-bridge times
  const seenWa = new Set(); // ids of WhatsApp messages already handled (Meta retries deliveries)
  const waTails = new Map(); // convId -> tail of the chain of WhatsApp sends, so replies keep their order

  const privacyOf = (site) => (site.privacyNote === undefined ? DEFAULT_PRIVACY_NOTE : site.privacyNote);
  const send = (ws, payload) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(payload));
  };
  const toAgents = (siteKey, payload) => (agents.get(siteKey) || new Set()).forEach((ws) => send(ws, payload));
  const toVisitors = (convId, payload) => (visitors.get(convId) || new Set()).forEach((ws) => send(ws, payload));

  function summary(conv, withMessages = false) {
    const last = conv.messages[conv.messages.length - 1];
    return {
      id: conv.id,
      visitorId: conv.visitorId,
      status: conv.status,
      humanTakeover: conv.humanTakeover,
      needsHuman: conv.needsHuman,
      urgent: !!conv.urgent,
      channel: conv.channel || 'web',
      phone: conv.phone || '',
      callback: conv.callback || '',
      unread: conv.unread,
      online: (visitors.get(conv.id)?.size || 0) > 0,
      updatedAt: conv.updatedAt,
      lastMessage: last ? last.text.slice(0, 120) : '',
      ...(withMessages ? { messages: conv.messages.slice(-100) } : {}),
    };
  }

  // ---------- HTTP ----------
  function json(res, status, body, cors = false) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...(cors ? { 'access-control-allow-origin': '*' } : {}),
    });
    res.end(JSON.stringify(body));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 100 * 1024) {
          reject(new Error('too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
    });
  }

  // Raw bytes, needed to check Meta's signature before anything is parsed.
  function readRaw(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(new Error('too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function authSite(req) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const entry = tokens.get(token);
    if (!entry || entry.exp < Date.now()) return null;
    return store.getSite(entry.siteKey);
  }

  // Only FAILED attempts count, per client IP. Behind a reverse proxy set TRUST_PROXY=1 so the real client
  // address (the last X-Forwarded-For entry, which your own proxy appends) is used instead of the proxy's.
  function clientIp(req) {
    if (trustProxy) {
      const parts = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
    return req.socket.remoteAddress;
  }

  function blocked(ip) {
    const rec = loginAttempts.get(ip);
    return !!rec && rec.reset > Date.now() && rec.count >= 10;
  }

  function recordFailure(ip) {
    const now = Date.now();
    const rec = loginAttempts.get(ip);
    if (!rec || rec.reset <= now) loginAttempts.set(ip, { count: 1, reset: now + 5 * 60 * 1000 });
    else rec.count += 1;
  }

  // Only a JSON object is a valid message. `null`, numbers, strings and arrays are valid JSON too,
  // and would otherwise crash the handlers below (TypeError on null.type).
  function parseMsg(raw) {
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('not an object');
    return d;
  }

  // Sliding-window counter: returns true (and counts the hit) while under the limit.
  function allow(map, key, windowMs, max) {
    const now = Date.now();
    const arr = map.get(key) || [];
    while (arr.length && arr[0] < now - windowMs) arr.shift();
    map.set(key, arr);
    if (arr.length >= max) return false;
    arr.push(now);
    return true;
  }

  const cleanStr = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

  const settingsOf = (site) => ({
    name: site.name,
    color: site.color,
    greeting: site.greeting,
    fallback: site.fallback,
    allowedOrigins: site.allowedOrigins,
    notifyEmail: site.notifyEmail || '',
    notifyWhatsapp: site.notifyWhatsapp || '',
    emergencyReply: site.emergencyReply ?? DEFAULT_EMERGENCY_REPLY,
    privacyNote: privacyOf(site),
    emailEnabled: notifier.enabled,
    whatsappEnabled: notifier.whatsappEnabled,
    missedCallEnabled: !!site.missedCallEnabled,
    missedCallText: site.missedCallText ?? DEFAULT_MISSED_CALL_TEXT(site),
    callbackPhone: site.callbackPhone || '',
    autoCallback: site.autoCallback !== false,
    missedCallAvailable: !!(missedCallSecret && missedCallTemplate && notifier.waReady),
    callbackAvailable: callBridge.enabled,
  });

  async function handleApi(req, res, url) {
    const route = `${req.method} ${url.pathname}`;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      return res.end();
    }

    if (route === 'GET /api/site-config') {
      const site = store.getSite(url.searchParams.get('key') || '');
      if (!site) return json(res, 404, { error: 'אתר לא מוכר' }, true);
      return json(res, 200, { name: site.name, color: site.color, greeting: site.greeting, privacyNote: privacyOf(site) }, true);
    }

    if (route === 'POST /api/login') {
      const ip = clientIp(req);
      if (blocked(ip)) return json(res, 429, { error: 'יותר מדי ניסיונות כושלים. נסו שוב בעוד כמה דקות' });
      const body = await readBody(req);
      const site = store.getSite(cleanStr(body.siteKey, 100));
      const ok = verifyPassword(cleanStr(body.password, 200), site ? site.passwordHash : DUMMY_HASH);
      if (!site || !ok) {
        recordFailure(ip);
        return json(res, 401, { error: 'מפתח האתר או הסיסמה שגויים' });
      }
      const token = crypto.randomBytes(24).toString('base64url');
      tokens.set(token, { siteKey: site.key, exp: Date.now() + 12 * 3600 * 1000 });
      return json(res, 200, { token, site: { key: site.key, name: site.name } });
    }

    // Create a client site on a running server. Disabled unless ADMIN_TOKEN is set.
    if (route === 'POST /api/admin/sites') {
      if (!adminToken) return json(res, 404, { error: 'לא נמצא' });
      const ip = clientIp(req);
      if (blocked(ip)) return json(res, 429, { error: 'יותר מדי ניסיונות כושלים. נסו שוב בעוד כמה דקות' });
      const given = (req.headers.authorization || '').replace(/^Bearer /, '');
      const digest = (s) => crypto.createHash('sha256').update(s).digest();
      if (!crypto.timingSafeEqual(digest(given), digest(adminToken))) {
        recordFailure(ip);
        return json(res, 401, { error: 'אסימון המנהל שגוי' });
      }
      const body = await readBody(req);
      const name = cleanStr(body.name, 80);
      if (!name) return json(res, 400, { error: 'חובה למלא שם' });
      const password = cleanStr(body.password, 200) || crypto.randomBytes(9).toString('base64url');
      if (password.length < 8) return json(res, 400, { error: 'הסיסמה חייבת להכיל לפחות 8 תווים' });
      let origins;
      try {
        origins = normalizeOrigins(body.allowedOrigins);
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
      const created = store.createSite({ name, password, allowedOrigins: origins });
      return json(res, 201, { key: created.key, name: created.name, password });
    }

    // ---------- Missed call ----------
    // A virtual-number provider (or n8n/Make in front of it) calls this when a call to the business was not answered.
    // POST /api/missed-call?site=<siteKey>   header x-webhook-secret: <MISSED_CALL_SECRET>   body {"caller": "050-123-4567"}
    if (route === 'POST /api/missed-call') {
      if (!missedCallSecret) return json(res, 404, { error: 'לא נמצא' });
      const ip = clientIp(req);
      if (blocked(ip)) return json(res, 429, { error: 'יותר מדי ניסיונות כושלים. נסו שוב בעוד כמה דקות' });
      const given = req.headers['x-webhook-secret'] || (req.headers.authorization || '').replace(/^Bearer /, '');
      if (!safeEqual(given, missedCallSecret)) {
        recordFailure(ip);
        return json(res, 401, { error: 'הסוד של ה־webhook שגוי' });
      }
      if (!allow(missedStamps, 'all', 60000, missedCallsPerMinute)) return json(res, 429, { error: 'יותר מדי בקשות' });
      const body = await readBody(req);
      const site = store.getSite(cleanStr(url.searchParams.get('site') || body.site, 100));
      if (!site || !site.missedCallEnabled) return json(res, 404, { error: 'האתר לא מוכר או שהשירות כבוי' });
      if (!missedCallTemplate || !notifier.waReady) return json(res, 503, { error: 'וואטסאפ לא מוגדר בשרת' });
      const rawCaller = body.caller ?? body.from;
      const caller = typeof rawCaller === 'string' ? normalizePhone(rawCaller) : '';
      if (!caller) return json(res, 400, { error: 'מספר המתקשר חסר או אינו מספר ישראלי תקין' });
      // The owner calling their own line must not start a chat with themselves.
      if (caller === normalizePhone(site.notifyWhatsapp || '') || caller === normalizePhone(site.callbackPhone || '')) {
        return json(res, 200, { ok: true, sent: false, reason: 'owner' });
      }
      if (!allow(missedStamps, site.key, 86400000, 300)) return json(res, 429, { error: 'חריגה ממכסת היום לאתר' });
      // One message per caller per hour: a caller who rings three times is still one conversation, and Meta bills per template.
      const callerKey = `${site.key}:${caller}`;
      if (!allow(missedStamps, callerKey, 3600000, 1)) return json(res, 200, { ok: true, sent: false, reason: 'recent' });
      const sent = await notifier.sendTemplate(caller, missedCallTemplate, [site.name], missedCallLang);
      if (!sent) {
        missedStamps.get(callerKey)?.pop(); // let the provider's retry through
        return json(res, 502, { error: 'שליחת הוואטסאפ למתקשר נכשלה' });
      }
      const conv = store.getConversation(site.key, `wa-${caller}`);
      conv.channel = 'whatsapp';
      conv.phone = caller;
      conv.missedCallAt = Date.now();
      const note = store.addMessage(conv, 'bot', site.missedCallText ?? DEFAULT_MISSED_CALL_TEXT(site));
      toAgents(site.key, { type: 'message', convId: conv.id, message: note, conv: summary(conv) });
      return json(res, 200, { ok: true, sent: true, conversationId: conv.id });
    }

    // Meta's webhook verification handshake (done once, when the callback URL is saved in the App Dashboard).
    if (route === 'GET /api/whatsapp/webhook') {
      if (!waVerifyToken) return json(res, 404, { error: 'לא נמצא' });
      const q = url.searchParams;
      if (q.get('hub.mode') !== 'subscribe' || !safeEqual(q.get('hub.verify_token') || '', waVerifyToken)) return json(res, 403, { error: 'אסימון אימות שגוי' });
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
      return res.end(String(q.get('hub.challenge') || '').slice(0, 200));
    }

    // Messages the caller sends back on WhatsApp. Signed by Meta with the app secret; unsigned requests are refused.
    if (route === 'POST /api/whatsapp/webhook') {
      if (!waAppSecret) return json(res, 404, { error: 'לא נמצא' });
      const raw = await readRaw(req, 3 * 1024 * 1024);
      if (!verifyMetaSignature(raw, req.headers['x-hub-signature-256'], waAppSecret)) return json(res, 401, { error: 'חתימה שגויה' });
      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        return json(res, 400, { error: 'בקשה לא תקינה' });
      }
      json(res, 200, { ok: true }); // answer first: Meta retries anything slower or non-200 for days
      for (const m of extractWaMessages(payload, notifier.waPhoneId)) {
        if (seenWa.has(m.id)) continue;
        seenWa.add(m.id);
        if (seenWa.size > 5000) seenWa.delete(seenWa.values().next().value);
        onWaMessage(m.from, m.text).catch((err) => console.error('whatsapp message handling failed', err));
      }
      return;
    }

    if (route === 'POST /api/logout') {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      const entry = tokens.get(token);
      tokens.delete(token);
      if (entry) (agents.get(entry.siteKey) || new Set()).forEach((ws) => ws.authToken === token && ws.close(1008));
      return json(res, 200, { ok: true });
    }

    const site = authSite(req);
    if (!site) return json(res, 401, { error: 'לא מחוברים' });

    if (route === 'GET /api/conversations') {
      return json(res, 200, { conversations: store.listConversations(site.key).slice(0, 200).map((c) => summary(c, true)) });
    }

    if (route === 'GET /api/faq') return json(res, 200, { faq: site.faq });

    if (route === 'PUT /api/faq') {
      const body = await readBody(req);
      if (!Array.isArray(body.faq) || body.faq.length > 100) return json(res, 400, { error: 'רשימת השאלות הנפוצות חייבת להכיל עד 100 פריטים' });
      site.faq = body.faq
        .map((f) => ({ q: cleanStr(f?.q, 300), a: cleanStr(f?.a, 1500), keywords: cleanStr(f?.keywords, 300) }))
        .filter((f) => f.q && f.a);
      store.save();
      return json(res, 200, { faq: site.faq });
    }

    if (route === 'GET /api/settings') {
      return json(res, 200, settingsOf(site));
    }

    if (route === 'PUT /api/settings') {
      const body = await readBody(req);
      let origins = null;
      if (Array.isArray(body.allowedOrigins)) {
        try {
          origins = normalizeOrigins(body.allowedOrigins);
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      }
      if (body.color !== undefined) {
        if (!/^#[0-9a-fA-F]{6}$/.test(body.color)) return json(res, 400, { error: 'הצבע חייב להיות בפורמט כמו #2563eb' });
        site.color = body.color;
      }
      if (body.name !== undefined && cleanStr(body.name, 80)) site.name = cleanStr(body.name, 80);
      if (body.greeting !== undefined) site.greeting = cleanStr(body.greeting, 300);
      if (body.fallback !== undefined) site.fallback = cleanStr(body.fallback, 300);
      if (body.notifyEmail !== undefined) {
        const e = typeof body.notifyEmail === 'string' ? body.notifyEmail.trim() : '';
        if (e && !isEmail(e)) return json(res, 400, { error: 'כתובת המייל להתראות אינה תקינה' });
        site.notifyEmail = e;
      }
      if (body.notifyWhatsapp !== undefined) {
        const raw = typeof body.notifyWhatsapp === 'string' ? body.notifyWhatsapp.trim() : '';
        if (raw && !normalizePhone(raw)) return json(res, 400, { error: 'מספר הוואטסאפ להתראות אינו תקין. יש לכתוב מספר ישראלי כמו 0501234567' });
        site.notifyWhatsapp = raw ? normalizePhone(raw) : '';
      }
      if (body.emergencyReply !== undefined) site.emergencyReply = cleanStr(body.emergencyReply, 300);
      if (body.privacyNote !== undefined) site.privacyNote = cleanStr(body.privacyNote, 200);
      if (body.callbackPhone !== undefined) {
        const raw = typeof body.callbackPhone === 'string' ? body.callbackPhone.trim() : '';
        if (raw && !normalizePhone(raw)) return json(res, 400, { error: 'מספר החיוג החוזר אינו תקין. יש לכתוב מספר ישראלי כמו 0501234567' });
        site.callbackPhone = raw ? normalizePhone(raw) : '';
      }
      if (body.missedCallEnabled !== undefined) site.missedCallEnabled = body.missedCallEnabled === true;
      if (body.autoCallback !== undefined) site.autoCallback = body.autoCallback === true;
      if (body.missedCallText !== undefined) site.missedCallText = cleanStr(body.missedCallText, 500);
      if (origins) site.allowedOrigins = origins;
      store.save();
      return json(res, 200, settingsOf(site));
    }

    return json(res, 404, { error: 'לא נמצא' });
  }

  function sendFile(res, file, noCache) {
    const body = fs.readFileSync(file);
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': noCache ? 'no-cache' : 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'content-security-policy': "frame-ancestors 'none'",
    });
    res.end(body);
  }

  // Serves the built dashboard (dashboard/dist). Returns false when there is no such file.
  function serveDist(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const root = path.resolve(distDir);
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    sendFile(res, file, !rel.startsWith('assets/'));
    return true;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method === 'GET') {
        if (url.pathname === '/widget.js') return sendFile(res, path.join(PUBLIC, 'widget.js'), true);
        if (url.pathname === '/demo') return sendFile(res, path.join(PUBLIC, 'demo.html'), true);
        if (serveDist(res, url.pathname)) return;
        if (url.pathname === '/') {
          res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
          return res.end('לוח הבקרה עדיין לא נבנה. יש להריץ "npm run build" בתיקיית הפרויקט, או "npm run dev" לפיתוח.');
        }
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
    } catch (err) {
      if (!res.headersSent) json(res, err.message === 'too large' ? 413 : 400, { error: 'בקשה לא תקינה' });
      else res.end();
    }
  });

  // ---------- WebSocket ----------
  // Bot replies for one conversation run one at a time, in order, so answers cannot overtake each other.
  function enqueue(id, task) {
    const tail = (queues.get(id) || Promise.resolve()).then(task);
    const safe = tail.catch(() => {});
    queues.set(id, safe);
    safe.then(() => {
      if (queues.get(id) === safe) queues.delete(id);
    });
    return tail;
  }

  // Delivers a message to the visitor's browser and, for a WhatsApp conversation, to their phone as well.
  function toCaller(conv, msg) {
    toVisitors(conv.id, { type: 'message', message: msg });
    if (conv.channel !== 'whatsapp' || msg.from === 'visitor') return;
    const tail = (waTails.get(conv.id) || Promise.resolve()).then(async () => {
      if (!(await notifier.sendText(conv.phone, msg.text))) console.error('לא ניתן לשלוח תשובה בוואטסאפ (חלון 24 השעות נסגר או שגיאת שליחה)');
    });
    const safe = tail.catch(() => {});
    waTails.set(conv.id, safe);
    safe.then(() => {
      if (waTails.get(conv.id) === safe) waTails.delete(conv.id);
    });
  }

  // A caller wrote back on WhatsApp. Only people we messaged first (a missed call) get a conversation:
  // anyone else writing to the number is ignored, so the number cannot be used to flood the dashboard.
  async function onWaMessage(from, text) {
    const phone = normalizePhone(from);
    if (!phone) return;
    let conv = null;
    for (const key of Object.keys(store.data.sites)) {
      const c = store.data.conversations[`${key}:wa-${phone}`];
      if (c && (!conv || c.updatedAt > conv.updatedAt)) conv = c;
    }
    const site = conv && store.getSite(conv.siteKey);
    if (!site || !allow(ipMsgs, `wa:${phone}`, 60000, 20)) return;
    await onVisitorMessage(site, conv, text);
  }

  // The caller is "ready" for a person when it is an emergency, the bot could not answer, or they asked to be called.
  // Rings the owner first; the provider connects the caller when the owner picks up. At most once per 30 minutes per chat.
  async function maybeCallback(site, conv, reason) {
    if (conv.channel !== 'whatsapp' || site.autoCallback === false || !callBridge.enabled) return;
    if (Date.now() - (conv.callbackAt || 0) < 30 * 60 * 1000) return;
    const ownerPhone = normalizePhone(site.callbackPhone || site.notifyWhatsapp || '');
    if (!ownerPhone || ownerPhone === conv.phone) return;
    if (!allow(callbackStamps, site.key, 86400000, callbacksPerDay)) {
      conv.callback = 'limit';
      return;
    }
    conv.callbackAt = Date.now();
    const ok = await callBridge.bridge({ ownerPhone, callerPhone: conv.phone, siteName: site.name, reason });
    if (!ok) {
      conv.callbackAt = 0;
      callbackStamps.get(site.key)?.pop();
      conv.callback = 'failed';
      toAgents(site.key, { type: 'conversation', conv: summary(conv) });
      return;
    }
    conv.callback = 'requested';
    const msg = store.addMessage(conv, 'bot', 'בעל העסק מקבל את הפרטים ויתקשר אליך בדקות הקרובות.');
    toCaller(conv, msg);
    toAgents(site.key, { type: 'message', convId: conv.id, message: msg, conv: summary(conv) });
  }

  async function onVisitorMessage(site, conv, text) {
    const msg = store.addMessage(conv, 'visitor', text);
    toVisitors(conv.id, { type: 'message', message: msg });
    toAgents(site.key, { type: 'message', convId: conv.id, message: msg, conv: summary(conv) });
    await enqueue(conv.id, () => botRespond(site, conv, text));
    // An emergency is sent to the owner even when the dashboard is open: someone may have left it on a desk.
    // Otherwise, nobody is watching the dashboard and the bot could not help: tell the owner.
    // For a WhatsApp conversation the owner cannot see who it is, so the caller's number leads the alert.
    const alertText = conv.phone ? `${localPhone(conv.phone)}: ${text}` : text;
    const asksCall = conv.channel === 'whatsapp' && wantsCallback(text);
    if (conv.alertUrgent) {
      conv.alertUrgent = false;
      notifier.notify(site, conv, alertText, { urgent: true }).catch(() => {});
    } else if ((conv.needsHuman || conv.humanTakeover || asksCall) && !(agents.get(site.key)?.size)) {
      notifier.notify(site, conv, alertText).catch(() => {});
    }
    if (conv.channel === 'whatsapp' && !conv.humanTakeover && (conv.urgent || conv.needsHuman || asksCall)) {
      await maybeCallback(site, conv, conv.urgent ? 'urgent' : asksCall ? 'requested' : 'needs_human');
    }
  }

  async function botRespond(site, conv, text) {
    if (conv.humanTakeover) return;

    // Emergency words beat the FAQ. Only the first one in a conversation gets the canned reply and the alert,
    // so a worried visitor typing three messages does not get three identical replies.
    if (!conv.urgent && isEmergency(text)) {
      conv.urgent = true;
      conv.needsHuman = true;
      conv.alertUrgent = true;
      const emsg = store.addMessage(conv, 'bot', site.emergencyReply ?? DEFAULT_EMERGENCY_REPLY);
      toCaller(conv, emsg);
      toAgents(site.key, { type: 'message', convId: conv.id, message: emsg, conv: summary(conv) });
      return;
    }

    let answer = matchFaq(site.faq, text)?.a || null;
    if (!answer) answer = await aiReply(site, conv.messages);
    // A person may have joined while the AI was thinking: never talk over them.
    if (conv.humanTakeover) return;

    if (answer) {
      conv.needsHuman = false;
    } else if (!conv.needsHuman) {
      conv.needsHuman = true;
      answer = site.fallback;
    } else {
      toAgents(site.key, { type: 'conversation', conv: summary(conv) });
      return;
    }
    const botMsg = store.addMessage(conv, 'bot', answer);
    toCaller(conv, botMsg);
    toAgents(site.key, { type: 'message', convId: conv.id, message: botMsg, conv: summary(conv) });
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  function reject(socket, status, reason) {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  function track(ws) {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('error', () => {});
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
  }

  function attachAgent(ws, site) {
    track(ws);
    if (!agents.has(site.key)) agents.set(site.key, new Set());
    agents.get(site.key).add(ws);
    ws.on('close', () => agents.get(site.key)?.delete(ws));
    ws.on('message', (raw) => {
      let data;
      try {
        data = parseMsg(raw.toString());
      } catch {
        return;
      }
      const conv = store.findConversation(site.key, cleanStr(data.convId, 200));
      if (!conv) return;
      if (data.type === 'reply') {
        const text = cleanStr(data.text, 2000);
        if (!text) return;
        conv.humanTakeover = true;
        conv.needsHuman = false;
        conv.urgent = false;
        conv.unread = 0;
        const msg = store.addMessage(conv, 'agent', text);
        toCaller(conv, msg);
        toAgents(site.key, { type: 'message', convId: conv.id, message: msg, conv: summary(conv) });
      } else if (data.type === 'read') {
        conv.unread = 0;
        store.save();
        toAgents(site.key, { type: 'conversation', conv: summary(conv) });
      } else if (data.type === 'close') {
        conv.status = 'closed';
        conv.humanTakeover = false;
        conv.needsHuman = false;
        conv.urgent = false;
        conv.unread = 0;
        store.save();
        toAgents(site.key, { type: 'conversation', conv: summary(conv) });
      }
    });
  }

  function attachVisitor(ws, site, vid, ip) {
    track(ws);
    const convId = `${site.key}:${vid}`;
    if (!visitors.has(convId)) visitors.set(convId, new Set());
    visitors.get(convId).add(ws);

    const existing = store.data.conversations[convId];
    send(ws, { type: 'history', messages: existing ? existing.messages.slice(-100) : [], humanTakeover: !!existing?.humanTakeover });
    if (existing) toAgents(site.key, { type: 'conversation', conv: summary(existing) });

    const stamps = msgStamps.get(convId) || (msgStamps.set(convId, []), msgStamps.get(convId));
    ws.on('close', () => {
      visitors.get(convId)?.delete(ws);
      const conv = store.data.conversations[convId];
      if (conv) toAgents(site.key, { type: 'conversation', conv: summary(conv) });
    });
    ws.on('message', async (raw) => {
      let data;
      try {
        data = parseMsg(raw.toString());
      } catch {
        return;
      }
      if (data.type !== 'message') return;
      const text = cleanStr(data.text, 2000);
      if (!text) return;
      const now = Date.now();
      while (stamps.length && stamps[0] < now - 60000) stamps.shift();
      if (stamps.length >= 20) return send(ws, { type: 'error', code: 'rate_limited' });
      stamps.push(now);
      // Limits per client address, so one machine cannot create endless conversations (each is stored forever)
      // or run up AI costs by opening many connections.
      if (!allow(ipMsgs, ip, 60000, ipMessagesPerMinute)) return send(ws, { type: 'error', code: 'rate_limited' });
      if (!store.data.conversations[convId] && !allow(ipNewConvs, ip, 3600000, ipNewConversationsPerHour)) {
        return send(ws, { type: 'error', code: 'rate_limited' });
      }
      const conv = store.getConversation(site.key, vid);
      try {
        await onVisitorMessage(site, conv, text);
      } catch (err) {
        console.error('message handling failed', err);
      }
    });
  }

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      // e.g. a request for "//": new URL() throws, and an exception here would take the whole server down
      return socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    }
    if (url.pathname !== '/ws') return reject(socket, 404, 'Not Found');
    const role = url.searchParams.get('role');

    if (role === 'agent') {
      const entry = tokens.get(url.searchParams.get('token') || '');
      const site = entry && entry.exp > Date.now() ? store.getSite(entry.siteKey) : null;
      if (!site) return reject(socket, 401, 'Unauthorized');
      return wss.handleUpgrade(req, socket, head, (ws) => {
        ws.authToken = url.searchParams.get('token');
        attachAgent(ws, site);
      });
    }

    if (role === 'visitor') {
      const site = store.getSite(url.searchParams.get('key') || '');
      const vid = url.searchParams.get('vid') || '';
      // wa-… ids belong to WhatsApp callers: a browser must not be able to join (and read) their conversation.
      if (!site || !/^[A-Za-z0-9_-]{8,64}$/.test(vid) || vid.startsWith('wa-')) return reject(socket, 400, 'Bad Request');
      const origin = req.headers.origin;
      if (site.allowedOrigins?.length && !site.allowedOrigins.includes(origin)) return reject(socket, 403, 'Forbidden');
      const ip = clientIp(req);
      return wss.handleUpgrade(req, socket, head, (ws) => attachVisitor(ws, site, vid, ip));
    }

    reject(socket, 400, 'Bad Request');
  });

  const heartbeat = setInterval(() => {
    for (const ws of sockets) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
    const now = Date.now();
    for (const [t, e] of tokens) if (e.exp < now) tokens.delete(t);
    for (const [ip, r] of loginAttempts) if (r.reset <= now) loginAttempts.delete(ip);
    for (const [ip, arr] of ipMsgs) if (!arr.length || arr[arr.length - 1] < now - 60000) ipMsgs.delete(ip);
    for (const m of [missedStamps, callbackStamps]) for (const [k, arr] of m) if (!arr.length || arr[arr.length - 1] < now - 86400000) m.delete(k);
    for (const [ip, arr] of ipNewConvs) if (!arr.length || arr[arr.length - 1] < now - 3600000) ipNewConvs.delete(ip);
    for (const [id, st] of msgStamps) {
      if (!visitors.get(id)?.size && (!st.length || st[st.length - 1] < now - 60000)) msgStamps.delete(id);
    }
  }, 30000);
  heartbeat.unref();

  return new Promise((resolve) => {
    server.listen(port, () => {
      resolve({
        server,
        store,
        port: server.address().port,
        close: () =>
          new Promise((done) => {
            clearInterval(heartbeat);
            for (const ws of sockets) ws.close(1001);
            wss.close();
            store.flush();
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await startServer();
  console.log(`הצ׳אט פועל בכתובת http://localhost:${app.port}  (לוח בקרה: /  ,  דף הדגמה: /demo)`);
  const stop = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
