// Callback bridge: ring the business owner first and, when they answer, connect the caller.
// The provider is behind one function, bridge(job), so it can be swapped without touching the chat server:
//   CALL_PROVIDER=twilio   Twilio REST "Create a Call" with inline TwiML (owner leg, then <Dial> to the caller).
//   CALL_PROVIDER=webhook  POSTs the job as JSON to CALL_WEBHOOK_URL (n8n, Make, or any service you run) and lets it place the calls.
// Without a provider the bridge is disabled and the owner is only alerted.
const e164 = (n) => `+${n}`;
const xmlEscape = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

export function createCallBridge({
  provider = process.env.CALL_PROVIDER || '',
  twilioSid = process.env.TWILIO_ACCOUNT_SID || '',
  twilioToken = process.env.TWILIO_AUTH_TOKEN || '',
  twilioFrom = process.env.TWILIO_FROM || '',
  twilioApiUrl = process.env.TWILIO_API_URL || 'https://api.twilio.com',
  webhookUrl = process.env.CALL_WEBHOOK_URL || '',
  webhookSecret = process.env.CALL_WEBHOOK_SECRET || '',
  log = console,
} = {}) {
  const twilio = provider === 'twilio' && Boolean(twilioSid && twilioToken && twilioFrom);
  const hook = provider === 'webhook' && /^https?:\/\//.test(webhookUrl);
  const enabled = twilio || hook;

  async function viaTwilio({ ownerPhone, callerPhone, siteName }) {
    // The owner hears a short notice, then the caller's number is dialled and the two are connected.
    const twiml =
      `<Response><Say language="he-IL">${xmlEscape(`לקוח של ${siteName} מחכה. מחברים אותך עכשיו.`)}</Say>` +
      `<Dial>${e164(callerPhone)}</Dial></Response>`;
    const res = await fetch(`${twilioApiUrl.replace(/\/$/, '')}/2010-04-01/Accounts/${encodeURIComponent(twilioSid)}/Calls.json`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: e164(ownerPhone), From: twilioFrom, Twiml: twiml }).toString(),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  }

  async function viaWebhook({ ownerPhone, callerPhone, siteName, reason }) {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(webhookSecret ? { 'x-webhook-secret': webhookSecret } : {}) },
      body: JSON.stringify({ event: 'callback_bridge', owner: e164(ownerPhone), caller: e164(callerPhone), site: siteName, reason }),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  }

  // job: { ownerPhone, callerPhone } in 972… form, plus siteName and reason ('urgent' | 'needs_human' | 'requested').
  // Resolves true when the provider accepted the request. Never throws.
  async function bridge(job) {
    if (!enabled) return false;
    try {
      const ok = twilio ? await viaTwilio(job) : await viaWebhook(job);
      if (!ok) log.error('בקשת חיוג חוזר נדחתה על ידי הספק');
      return ok;
    } catch (err) {
      log.error(`בקשת חיוג חוזר נכשלה: ${err.message}`);
      return false;
    }
  }

  return { enabled, provider: enabled ? provider : '', bridge };
}
