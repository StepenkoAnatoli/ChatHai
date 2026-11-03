// Email alerts for agents who are not in the dashboard. Uses the Resend HTTP API through fetch (no dependency).
// Configure with RESEND_API_KEY and MAIL_FROM (an address on a domain verified in Resend). Without them it does nothing.
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
const MIN_GAP_MS = 10 * 60 * 1000;

export function isEmail(s) {
  return typeof s === 'string' && s.length <= 200 && EMAIL_RE.test(s);
}

const oneLine = (s) => String(s).replace(/[\r\n\u2028\u2029]+/g, ' ').trim();

export function createNotifier({
  apiKey = process.env.RESEND_API_KEY || '',
  from = process.env.MAIL_FROM || '',
  apiUrl = process.env.MAIL_API_URL || 'https://api.resend.com/emails',
  dashboardUrl = process.env.DASHBOARD_URL || '',
  minGapMs = MIN_GAP_MS,
  log = console,
} = {}) {
  const last = new Map(); // convId -> time of the last email for that conversation
  const enabled = Boolean(apiKey && from);

  // Returns true when an email was sent. Never throws: a mail problem must not break the chat.
  async function notify(site, conv, text) {
    if (!enabled || !isEmail(site.notifyEmail)) return false;
    const now = Date.now();
    if (now - (last.get(conv.id) || 0) < minGapMs) return false;
    last.set(conv.id, now);
    if (last.size > 5000) for (const [k, t] of last) if (now - t > minGapMs) last.delete(k);
    const body = [
      `מבקר באתר "${oneLine(site.name)}" כתב הודעה ואף נציג לא מחובר ללוח הבקרה:`,
      '',
      String(text).slice(0, 500),
      '',
      dashboardUrl ? `לענות בלוח הבקרה: ${dashboardUrl}` : 'היכנסו ללוח הבקרה כדי לענות.',
    ].join('\n');
    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [site.notifyEmail], subject: `הודעה חדשה באתר ${oneLine(site.name)}`.slice(0, 150), text: body }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        last.delete(conv.id);
        log.error(`שליחת מייל נכשלה (${res.status})`);
        return false;
      }
      return true;
    } catch (err) {
      last.delete(conv.id);
      log.error(`שליחת מייל נכשלה: ${err.message}`);
      return false;
    }
  }

  return { notify, enabled };
}
