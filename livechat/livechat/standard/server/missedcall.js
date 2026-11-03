// Pure helpers for the missed-call flow (no I/O), so they can be tested on their own.
import crypto from 'node:crypto';

export function safeEqual(a, b) {
  const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
}

// Meta signs every webhook POST: X-Hub-Signature-256: sha256=<HMAC-SHA256 of the raw body, keyed with the app secret>.
export function verifyMetaSignature(raw, header, appSecret) {
  if (!appSecret || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const want = crypto.createHmac('sha256', appSecret).update(raw).digest('hex');
  const got = header.slice(7);
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

// Flattens a WhatsApp Cloud API webhook into [{ id, from, text, type }] for messages sent to phoneId.
// Statuses (delivered/read) and other fields are ignored. Anything that is not text becomes a placeholder,
// so a voice note still reaches the owner.
export function extractWaMessages(payload, phoneId) {
  const out = [];
  if (!payload || payload.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) return out;
  for (const entry of payload.entry) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.field !== 'messages') continue;
      const v = change.value;
      if (!v || (phoneId && v.metadata?.phone_number_id !== phoneId)) continue;
      for (const m of Array.isArray(v.messages) ? v.messages : []) {
        if (typeof m?.id !== 'string' || typeof m?.from !== 'string') continue;
        const type = typeof m.type === 'string' ? m.type : 'unknown';
        const body = type === 'text' && typeof m.text?.body === 'string' ? m.text.body.trim().slice(0, 2000) : '';
        out.push({ id: m.id, from: m.from, type, text: body || `[הודעה שאינה טקסט: ${type.slice(0, 20)}]` });
      }
    }
  }
  return out;
}

const CALLBACK_WORDS = ['תתקשרו', 'התקשרו', 'תתקשר', 'תחזרו', 'חזרו אלי', 'חזרו אליי', 'חזור אלי', 'תצלצלו', 'צלצלו', 'שיחה חוזרת', 'תתקשרו אלי', 'call me'];

// True when the caller asks for a phone call back.
export function wantsCallback(text) {
  const t = String(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ');
  return CALLBACK_WORDS.some((w) => t.includes(w));
}

// 972501234567 -> 0501234567, for messages a person reads.
export const localPhone = (n) => (String(n).startsWith('972') ? `0${String(n).slice(3)}` : String(n));
