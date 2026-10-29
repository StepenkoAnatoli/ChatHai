// Email alerts for agents who are not in the dashboard. Uses the Resend HTTP API through fetch (no dependency).
// Configure with RESEND_API_KEY and MAIL_FROM (an address on a domain verified in Resend). Without them it does nothing.
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
const MIN_GAP_MS = 10 * 60 * 1000;

export function isEmail(s) {
  return typeof s === 'string' && s.length <= 200 && EMAIL_RE.test(s);
}

// Israeli numbers: "050-123 4567", "+972501234567" and "972501234567" all become "972501234567".
// Returns '' when it does not look like a mobile or landline number, so a typo is rejected instead of silently alerting nobody.
export function normalizePhone(s) {
  if (typeof s !== 'string') return '';
  const digits = s.replace(/[\s\-().]/g, '').replace(/^\+/, '');
  if (!/^\d+$/.test(digits)) return '';
  const intl = digits.startsWith('972') ? digits : digits.startsWith('0') ? `972${digits.slice(1)}` : '';
  return /^972[2-9]\d{7,8}$/.test(intl) ? intl : '';
}

const oneLine = (s) => String(s).replace(/[\r\n\u2028\u2029]+/g, ' ').trim();

export function createNotifier({
  apiKey = process.env.RESEND_API_KEY || '',
  from = process.env.MAIL_FROM || '',
  apiUrl = process.env.MAIL_API_URL || 'https://api.resend.com/emails',
  dashboardUrl = process.env.DASHBOARD_URL || '',
  minGapMs = MIN_GAP_MS,
  log = console,
  // WhatsApp Business Cloud API (Meta). Business-initiated messages must use a template that Meta has approved.
  // The template needs one body variable ({{1}}), e.g. "הודעה חדשה באתר: {{1}}".
  waToken = process.env.WHATSAPP_TOKEN || '',
  waPhoneId = process.env.WHATSAPP_PHONE_ID || '',
  waTemplate = process.env.WHATSAPP_TEMPLATE || '',
  waLang = process.env.WHATSAPP_TEMPLATE_LANG || 'he',
  waApiUrl = process.env.WHATSAPP_API_URL || 'https://graph.facebook.com/v21.0',
} = {}) {
  const last = new Map(); // convId -> time of the last email for that conversation
  const enabled = Boolean(apiKey && from);
  const whatsappEnabled = Boolean(waToken && waPhoneId && waTemplate);

  // Body variables in a template may not contain newlines, tabs or 4+ spaces.
  const waText = (s) => oneLine(s).replace(/\s{2,}/g, ' ').slice(0, 300);

  async function sendWhatsapp(site, conv, text, urgent) {
    const to = normalizePhone(site.notifyWhatsapp || '');
    if (!whatsappEnabled || !to) return false;
    const body = `${urgent ? 'דחוף! ' : ''}${oneLine(site.name)}: ${text}`;
    try {
      const res = await fetch(`${waApiUrl.replace(/\/$/, '')}/${waPhoneId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${waToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: { name: waTemplate, language: { code: waLang }, components: [{ type: 'body', parameters: [{ type: 'text', text: waText(body) }] }] },
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        log.error(`שליחת וואטסאפ נכשלה (${res.status})`);
        return false;
      }
      return true;
    } catch (err) {
      log.error(`שליחת וואטסאפ נכשלה: ${err.message}`);
      return false;
    }
  }

  // Returns true when an email was sent. Never throws: a mail problem must not break the chat.
  // Urgent alerts have their own throttle slot, so an earlier ordinary alert never hides an emergency.
  async function notify(site, conv, text, { urgent = false } = {}) {
    const key = urgent ? `${conv.id}#urgent` : conv.id;
    const now = Date.now();
    if (now - (last.get(key) || 0) < minGapMs) return false;
    last.set(key, now);
    const wa = await sendWhatsapp(site, conv, text, urgent);
    if (!wa) last.delete(key);
    if (!enabled || !isEmail(site.notifyEmail)) return wa;
    last.set(key, now);
    if (last.size > 5000) for (const [k, t] of last) if (now - t > minGapMs) last.delete(k);
    const body = [
      urgent
        ? `פנייה דחופה (חירום) באתר "${oneLine(site.name)}":`
        : `מבקר באתר "${oneLine(site.name)}" כתב הודעה ואף נציג לא מחובר ללוח הבקרה:`,
      '',
      String(text).slice(0, 500),
      '',
      dashboardUrl ? `לענות בלוח הבקרה: ${dashboardUrl}` : 'היכנסו ללוח הבקרה כדי לענות.',
    ].join('\n');
    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [site.notifyEmail], subject: `${urgent ? 'דחוף: ' : ''}הודעה חדשה באתר ${oneLine(site.name)}`.slice(0, 150), text: body }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        if (!wa) last.delete(key);
        log.error(`שליחת מייל נכשלה (${res.status})`);
        return wa;
      }
      return true;
    } catch (err) {
      if (!wa) last.delete(key);
      log.error(`שליחת מייל נכשלה: ${err.message}`);
      return wa;
    }
  }

  return { notify, enabled, whatsappEnabled };
}
