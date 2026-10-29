import fs from 'node:fs';
import crypto from 'node:crypto';

export const DEFAULT_EMERGENCY_REPLY = 'קיבלנו. זה נשמע דחוף, ועדכנו את בעל העסק עכשיו. אם יש סכנה לחיים, ריח גז או שריפה, התקשרו מיד ל־101 או 102.';
export const DEFAULT_PRIVACY_NOTE = 'השיחה נשמרת אצל בעל האתר לצורך מתן שירות.';

const DEFAULT_FAQ = [
  { q: 'מה שעות הפעילות שלכם?', a: 'אנחנו פתוחים בימים א׳–ה׳, בין 9:00 ל־18:00.', keywords: 'שעות פתיחה פעילות זמנים פתוחים סגורים' },
  { q: 'כמה עולה משלוח?', a: 'משלוח חינם בהזמנה מעל 200 ש״ח, ו־30 ש״ח בהזמנות קטנות יותר.', keywords: 'משלוח משלוחים שילוח דמי עלות מחיר' },
  { q: 'איך אפשר ליצור קשר עם התמיכה?', a: 'אפשר לכתוב כאן ונציג יצטרף לשיחה, או לשלוח מייל לכתובת support@example.com.', keywords: 'קשר תמיכה עזרה נציג טלפון מייל' },
];

// Turns user input like "https://Shop.Example/" into the exact form browsers send in the Origin header.
// Throws on anything that is not a full http(s) address, because a silently ignored typo would leave the site open to everyone.
export function normalizeOrigins(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error('רשימת האתרים המותרים חייבת להיות רשימה');
  const out = new Set();
  for (const raw of list) {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (!s) continue;
    let u;
    try {
      u = new URL(s);
    } catch {
      throw new Error(`"${s.slice(0, 60)}" אינה כתובת אתר תקינה. יש לכתוב את הכתובת המלאה, למשל https://shop.example.com`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`"${s.slice(0, 60)}" אינה כתובת אתר תקינה. הכתובת חייבת להתחיל ב־http:// או ב־https://`);
    out.add(u.origin);
  }
  if (out.size > 20) throw new Error('אפשר להוסיף עד 20 אתרים מותרים');
  return [...out];
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = crypto.scryptSync(String(password), salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createStore(file) {
  let data = { sites: {}, conversations: {} };
  let timer = null;

  if (fs.existsSync(file)) {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  function save() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    }, 200);
  }

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  }

  function createSite({ name, password, key, color = '#2563eb', greeting, allowedOrigins = [] }) {
    const siteKey = key || crypto.randomBytes(9).toString('base64url');
    if (data.sites[siteKey]) throw new Error('מפתח האתר כבר קיים');
    data.sites[siteKey] = {
      key: siteKey,
      name,
      color,
      greeting: greeting || `שלום! אפשר לשאול אותנו כל דבר על ${name}.`,
      fallback: 'תודה! נציג יחזור אליך כאן בהקדם האפשרי.',
      allowedOrigins: normalizeOrigins(allowedOrigins),
      passwordHash: hashPassword(password),
      faq: DEFAULT_FAQ.map((f) => ({ ...f })),
      createdAt: Date.now(),
    };
    save();
    return data.sites[siteKey];
  }

  function getSite(key) {
    return Object.prototype.hasOwnProperty.call(data.sites, key) ? data.sites[key] : null;
  }

  function getConversation(siteKey, visitorId) {
    const id = `${siteKey}:${visitorId}`;
    let conv = data.conversations[id];
    if (!conv) {
      conv = data.conversations[id] = {
        id,
        siteKey,
        visitorId,
        messages: [],
        status: 'open',
        humanTakeover: false,
        needsHuman: false,
        urgent: false,
        unread: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      save();
    }
    return conv;
  }

  function findConversation(siteKey, id) {
    const conv = data.conversations[id];
    return conv && conv.siteKey === siteKey ? conv : null;
  }

  function addMessage(conv, from, text) {
    const message = { id: crypto.randomUUID(), from, text, ts: Date.now() };
    conv.messages.push(message);
    if (conv.messages.length > 500) conv.messages.splice(0, conv.messages.length - 500);
    conv.updatedAt = message.ts;
    if (from === 'visitor') {
      conv.unread += 1;
      if (conv.status === 'closed') conv.status = 'open';
    }
    save();
    return message;
  }

  function listConversations(siteKey) {
    return Object.values(data.conversations)
      .filter((c) => c.siteKey === siteKey)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  return { createSite, getSite, getConversation, findConversation, addMessage, listConversations, save, flush, data };
}
