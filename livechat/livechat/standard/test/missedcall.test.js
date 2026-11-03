import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createNotifier } from '../server/notify.js';
import { createCallBridge } from '../server/callbridge.js';
import { startServer } from '../server/index.js';
import { verifyMetaSignature, extractWaMessages, wantsCallback, localPhone } from '../server/missedcall.js';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.stack}`);
    process.exitCode = 1;
  }
}
console.log('Running missed-call flow tests');

// ---------- pure helpers ----------
await test('Meta signature: valid, tampered, missing and malformed headers', () => {
  const raw = Buffer.from('{"a":1}');
  const good = `sha256=${crypto.createHmac('sha256', 'app-secret').update(raw).digest('hex')}`;
  assert.equal(verifyMetaSignature(raw, good, 'app-secret'), true);
  assert.equal(verifyMetaSignature(Buffer.from('{"a":2}'), good, 'app-secret'), false);
  assert.equal(verifyMetaSignature(raw, good, 'other-secret'), false);
  for (const bad of [undefined, '', 'sha256=', 'sha256=abc', good.replace('sha256=', 'sha1='), `sha256=${'0'.repeat(64)}`]) assert.equal(verifyMetaSignature(raw, bad, 'app-secret'), false, String(bad));
  assert.equal(verifyMetaSignature(raw, good, ''), false, 'no secret configured: never valid');
});

await test('wantsCallback and localPhone', () => {
  for (const t of ['תתקשרו אלי בבקשה', 'אשמח שתחזרו אליי', 'חזרו אלי', 'please call me', 'אפשר שיחה חוזרת?']) assert.equal(wantsCallback(t), true, t);
  for (const t of ['מה שעות הפעילות?', 'כמה עולה ברז', 'תודה']) assert.equal(wantsCallback(t), false, t);
  assert.equal(localPhone('972501234567'), '0501234567');
});

await test('extractWaMessages reads text, flags other types, skips statuses and other phone numbers', () => {
  const mk = (value, field = 'messages') => ({ object: 'whatsapp_business_account', entry: [{ id: 'x', changes: [{ field, value }] }] });
  const meta = { phone_number_id: '555' };
  const out = extractWaMessages(mk({ metadata: meta, messages: [{ from: '972501234567', id: 'w1', type: 'text', text: { body: ' שלום ' } }, { from: '972501234567', id: 'w2', type: 'audio' }] }), '555');
  assert.deepEqual(out.map((m) => [m.id, m.text]), [['w1', 'שלום'], ['w2', '[הודעה שאינה טקסט: audio]']]);
  assert.deepEqual(extractWaMessages(mk({ metadata: meta, statuses: [{ id: 's', status: 'read' }] }), '555'), []);
  assert.deepEqual(extractWaMessages(mk({ metadata: { phone_number_id: '999' }, messages: [{ from: '1', id: 'w3', type: 'text', text: { body: 'x' } }] }), '555'), []);
  assert.deepEqual(extractWaMessages(mk({ metadata: meta, messages: [{ from: '1', id: 'w4', type: 'text', text: { body: 'x' } }] }, 'account_update'), '555'), []);
  for (const junk of [null, 5, 'x', [], {}, { object: 'page' }, { object: 'whatsapp_business_account', entry: [null, { changes: 5 }, { changes: [null] }] }]) assert.deepEqual(extractWaMessages(junk, '555'), []);
});

// ---------- fake Meta, fake call provider, fake Twilio ----------
const meta = { calls: [], status: 200 };
const metaSrv = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    meta.calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) });
    res.writeHead(meta.status, { 'content-type': 'application/json' });
    res.end('{}');
  });
});
const prov = { calls: [], status: 200 };
const provSrv = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    prov.calls.push({ url: req.url, headers: req.headers, body: b });
    res.writeHead(prov.status, { 'content-type': 'application/json' });
    res.end('{}');
  });
});
await Promise.all([metaSrv, provSrv].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
const metaUrl = `http://127.0.0.1:${metaSrv.address().port}/v1`;
const provUrl = `http://127.0.0.1:${provSrv.address().port}`;
const quiet = { error() {} };

const SECRET = 'missed-call-secret-123456';
const APP_SECRET = 'meta-app-secret';
const OWNER_ALERT = '0501111111'; // gets the alerts
const OWNER_CALL = '0502222222'; // gets the bridge call
const CALLER = '0541234567';
const CALLER_INTL = '972541234567';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, label) {
  for (let i = 0; i < 100; i += 1) {
    if (cond()) return;
    await sleep(20);
  }
  assert.fail(`timed out waiting for ${label}`);
}
const templates = (name) => meta.calls.filter((c) => c.body.type === 'template' && c.body.template.name === name);
const texts = () => meta.calls.filter((c) => c.body.type === 'text');
const reset = () => {
  meta.calls.length = 0;
  prov.calls.length = 0;
  meta.status = 200;
  prov.status = 200;
};

async function boot(extra = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-missed-'));
  const notifier = createNotifier({ apiKey: '', from: '', waToken: 'tok', waPhoneId: '555', waTemplate: 'new_chat', waApiUrl: metaUrl, minGapMs: 60000, log: quiet });
  const callBridge = createCallBridge({ provider: 'webhook', webhookUrl: `${provUrl}/bridge`, webhookSecret: 'bridge-secret', log: quiet });
  const s = await startServer({
    port: 0, dataFile: path.join(d, 'd.json'), seedDemo: true, notifier, callBridge,
    missedCallSecret: SECRET, missedCallTemplate: 'missed_call', waVerifyToken: 'verify-me', waAppSecret: APP_SECRET, ...extra,
  });
  const base = `http://127.0.0.1:${s.port}`;
  const call = async (p, opts = {}) => {
    const r = await fetch(base + p, opts);
    return { status: r.status, text: await r.text() };
  };
  const json = async (p, opts) => {
    const r = await call(p, opts);
    return { status: r.status, body: r.text ? (() => { try { return JSON.parse(r.text); } catch { return null; } })() : null };
  };
  const login = (await json('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ siteKey: 'demo', password: 'demo123' }) })).body.token;
  const auth = { authorization: `Bearer ${login}`, 'content-type': 'application/json' };
  const put = (body) => json('/api/settings', { method: 'PUT', headers: auth, body: JSON.stringify(body) });
  const missed = (body, headers = { 'x-webhook-secret': SECRET }, q = '?site=demo') =>
    json(`/api/missed-call${q}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const wa = (payload, { secret = APP_SECRET, sig } = {}) => {
    const raw = JSON.stringify(payload);
    const signature = sig ?? `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
    return call('/api/whatsapp/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, body: raw });
  };
  const inbound = (from, body, id = `wamid.${crypto.randomUUID()}`, type = 'text') =>
    wa({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '555' }, messages: [{ from, id, timestamp: '1', type, ...(type === 'text' ? { text: { body } } : {}) }] } }] }] });
  const cleanup = async () => {
    await s.close();
    fs.rmSync(d, { recursive: true, force: true });
  };
  return { s, call, json, put, missed, wa, inbound, auth, login, cleanup, conv: (phone) => s.store.data.conversations[`demo:wa-${phone}`] };
}

// ---------- the missed-call endpoint ----------
await test('missed-call endpoint: off without a secret, authenticated, rate-limited, validates the caller', async () => {
  const off = await boot({ missedCallSecret: '' });
  assert.equal((await off.missed({ caller: CALLER })).status, 404, 'disabled without a secret');
  await off.cleanup();

  assert.throws(() => startServer({ port: 0, dataFile: path.join(os.tmpdir(), 'x.json'), seedDemo: false, missedCallSecret: 'short' }), /MISSED_CALL_SECRET/);

  reset();
  const t = await boot();
  await t.put({ notifyWhatsapp: OWNER_ALERT, callbackPhone: OWNER_CALL, missedCallEnabled: true });
  assert.equal((await t.missed({ caller: CALLER }, {})).status, 401, 'no secret');
  assert.equal((await t.missed({ caller: CALLER }, { 'x-webhook-secret': 'wrong-secret-wrong-secret' })).status, 401);
  assert.equal((await t.missed({ caller: CALLER }, { authorization: `Bearer ${SECRET}` })).status, 200, 'Bearer form also accepted');
  reset();
  for (const caller of ['', '12345', 'unknown', 'anonymous', '+1 415 555 2671', undefined, null, 5, { a: 1 }, ['0541234567']]) {
    assert.equal((await t.missed({ caller })).status, 400, JSON.stringify(caller));
  }
  assert.equal((await t.missed({ caller: CALLER }, undefined, '?site=nope')).status, 404, 'unknown site');
  assert.equal(meta.calls.length, 0, 'nothing sent for any invalid request');
  // ten wrong secrets lock the address out, even for the right secret
  for (let i = 0; i < 10; i += 1) await t.missed({ caller: CALLER }, { 'x-webhook-secret': 'wrong-secret-wrong-secret' });
  assert.equal((await t.missed({ caller: CALLER }, { 'x-webhook-secret': SECRET })).status, 429);
  await t.cleanup();
});

await test('missed call sends the approved template to the normalised caller, once per hour, and tells the dashboard', async () => {
  reset();
  const t = await boot();
  assert.equal((await t.missed({ caller: CALLER })).status, 404, 'a site that has not switched the service on');
  await t.put({ notifyWhatsapp: OWNER_ALERT, callbackPhone: OWNER_CALL, missedCallEnabled: true });
  const agent = new WebSocket(`ws://127.0.0.1:${t.s.port}/ws?role=agent&token=${t.login}`);
  const events = [];
  agent.onmessage = (e) => events.push(JSON.parse(e.data));
  await new Promise((r) => (agent.onopen = r));

  const r1 = await t.missed({ caller: '054-123 4567' });
  assert.deepEqual([r1.status, r1.body.sent], [200, true]);
  assert.equal(meta.calls.length, 1);
  const c = meta.calls[0];
  assert.equal(c.url, '/v1/555/messages');
  assert.equal(c.auth, 'Bearer tok');
  assert.equal(c.body.to, CALLER_INTL);
  assert.equal(c.body.template.name, 'missed_call');
  assert.equal(c.body.template.language.code, 'he');
  assert.equal(c.body.template.components[0].parameters[0].text, 'חנות הדגמה');
  assert.equal(t.conv(CALLER_INTL).channel, 'whatsapp');
  await until(() => events.some((e) => e.conv?.phone === CALLER_INTL), 'dashboard event');

  const r2 = await t.missed({ caller: `+${CALLER_INTL}` });
  assert.deepEqual([r2.status, r2.body.sent, r2.body.reason], [200, false, 'recent']);
  assert.equal(meta.calls.length, 1, 'a second ring from the same caller sends nothing');
  assert.equal((await t.missed({ caller: OWNER_CALL })).body.reason, 'owner', "the owner's own number is ignored");
  assert.equal(meta.calls.length, 1);
  agent.close();
  await t.cleanup();
});

await test('a failed WhatsApp send returns 502 and the provider retry goes through; the global rate limit holds', async () => {
  reset();
  const t = await boot({ missedCallsPerMinute: 4 });
  await t.put({ notifyWhatsapp: OWNER_ALERT, missedCallEnabled: true });
  meta.status = 500;
  assert.equal((await t.missed({ caller: CALLER })).status, 502);
  meta.status = 200;
  assert.equal((await t.missed({ caller: CALLER })).body.sent, true, 'retry is not blocked by the failed attempt');
  assert.equal((await t.missed({ caller: '0551111111' })).status, 200);
  assert.equal((await t.missed({ caller: '0552222222' })).status, 200);
  assert.equal((await t.missed({ caller: '0553333333' })).status, 429, 'over the per-minute cap');
  await t.cleanup();
});

// ---------- Meta webhook ----------
await test('Meta webhook: verification handshake and signature checks', async () => {
  reset();
  const t = await boot();
  const ok = await t.call('/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1158201444');
  assert.deepEqual([ok.status, ok.text], [200, '1158201444']);
  assert.equal((await t.call('/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1')).status, 403);
  assert.equal((await t.call('/api/whatsapp/webhook?hub.verify_token=verify-me&hub.challenge=1')).status, 403, 'mode must be subscribe');
  assert.equal((await t.inbound(CALLER_INTL, 'x').then(() => t.wa({ object: 'whatsapp_business_account', entry: [] }, { sig: 'sha256=' + '0'.repeat(64) }))).status, 401);
  assert.equal((await t.wa({ object: 'whatsapp_business_account', entry: [] }, { secret: 'other' })).status, 401);
  assert.equal((await t.wa({ object: 'whatsapp_business_account', entry: [] })).status, 200);
  const raw = 'not json';
  const sig = `sha256=${crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
  assert.equal((await t.call('/api/whatsapp/webhook', { method: 'POST', headers: { 'x-hub-signature-256': sig }, body: raw })).status, 400, 'signed but not JSON');
  await t.cleanup();

  const bare = await boot({ waVerifyToken: '', waAppSecret: '' });
  assert.equal((await bare.call('/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=&hub.challenge=1')).status, 404);
  assert.equal((await bare.wa({ object: 'whatsapp_business_account', entry: [] })).status, 404, 'unsigned webhooks are never accepted');
  await bare.cleanup();
});

// ---------- the whole flow ----------
await test('flow: missed call -> FAQ answer on WhatsApp -> emergency -> owner alert + one callback bridge', async () => {
  reset();
  const t = await boot();
  await t.put({ notifyWhatsapp: OWNER_ALERT, callbackPhone: OWNER_CALL, missedCallEnabled: true });
  await t.missed({ caller: CALLER });
  assert.equal(templates('missed_call').length, 1);

  // a stranger who never called is ignored
  await t.inbound('972529999999', 'שלום');
  await sleep(100);
  assert.equal(Object.keys(t.s.store.data.conversations).filter((k) => k.includes('972529999999')).length, 0);

  // an ordinary question gets the FAQ answer on WhatsApp and does not ring the owner
  await t.inbound(CALLER_INTL, 'מה שעות הפעילות שלכם?');
  await until(() => texts().length === 1, 'FAQ reply on WhatsApp');
  assert.equal(texts()[0].body.to, CALLER_INTL);
  assert.match(texts()[0].body.text.body, /9:00/);
  await sleep(100);
  assert.equal(prov.calls.length, 0, 'no callback for an ordinary question');
  assert.equal(templates('new_chat').length, 0, 'no alert for an ordinary question');

  // an emergency: canned reply with 101/102, urgent alert to the owner, one bridge call
  const emergency = await t.inbound(CALLER_INTL, 'יש נזילה גדולה והמים בכל הבית!');
  assert.equal(emergency.status, 200);
  await until(() => prov.calls.length === 1 && templates('new_chat').length === 1 && texts().length === 3, 'alert, bridge and replies');
  const alert = templates('new_chat')[0];
  assert.equal(alert.body.to, '972501111111', 'alert goes to the alert number');
  assert.match(alert.body.template.components[0].parameters[0].text, /^דחוף! .*0541234567: יש נזילה/, 'urgent alert carries the caller number');
  const bridge = JSON.parse(prov.calls[0].body);
  assert.deepEqual([bridge.event, bridge.owner, bridge.caller, bridge.reason, bridge.site], ['callback_bridge', '+972502222222', '+972541234567', 'urgent', 'חנות הדגמה']);
  assert.equal(prov.calls[0].headers['x-webhook-secret'], 'bridge-secret');
  const sentTexts = texts().map((c) => c.body.text.body);
  assert.ok(sentTexts.some((x) => /101/.test(x)), 'caller got the emergency reply');
  assert.ok(sentTexts.some((x) => /יתקשר אליך/.test(x)), 'caller was told a call is coming');
  assert.equal(t.conv(CALLER_INTL).callback, 'requested');
  assert.equal(t.conv(CALLER_INTL).urgent, true);

  // more messages in the same emergency: no second alert, no second bridge
  await t.inbound(CALLER_INTL, 'המים ממשיכים, הצינור התפוצץ');
  await sleep(300);
  assert.equal(prov.calls.length, 1);
  assert.equal(templates('new_chat').filter((c) => /^דחוף!/.test(c.body.template.components[0].parameters[0].text)).length, 1, 'one urgent alert');
  await t.cleanup();
});

await test('flow: callback request, duplicate Meta deliveries, non-text messages, agent reply, and the numbers a browser cannot join', async () => {
  reset();
  const t = await boot();
  await t.put({ notifyWhatsapp: OWNER_ALERT, missedCallEnabled: true }); // no callbackPhone: the alert number is used
  await t.missed({ caller: CALLER });

  // Meta delivers the same message twice: handled once
  await t.inbound(CALLER_INTL, 'תתקשרו אלי בבקשה', 'wamid.same');
  await t.inbound(CALLER_INTL, 'תתקשרו אלי בבקשה', 'wamid.same');
  await until(() => prov.calls.length === 1, 'bridge');
  await sleep(200);
  assert.equal(prov.calls.length, 1);
  assert.equal(JSON.parse(prov.calls[0].body).owner, '+972501111111');
  assert.equal(JSON.parse(prov.calls[0].body).reason, 'requested');
  assert.equal(templates('new_chat').length, 1, 'ordinary alert for the callback request');
  assert.equal(t.conv(CALLER_INTL).messages.filter((m) => m.from === 'visitor').length, 1);

  // a voice note reaches the dashboard as a placeholder and counts as "needs a person"
  await t.inbound(CALLER_INTL, '', 'wamid.voice', 'audio');
  await until(() => t.conv(CALLER_INTL).messages.some((m) => /audio/.test(m.text)), 'voice placeholder');

  // the owner answers from the dashboard: it is sent to the caller's phone
  const agent = new WebSocket(`ws://127.0.0.1:${t.s.port}/ws?role=agent&token=${t.login}`);
  await new Promise((r) => (agent.onopen = r));
  const before = texts().length;
  agent.send(JSON.stringify({ type: 'reply', convId: `demo:wa-${CALLER_INTL}`, text: 'אני בדרך אליך' }));
  await until(() => texts().length === before + 1, 'agent reply on WhatsApp');
  assert.deepEqual([texts().at(-1).body.to, texts().at(-1).body.text.body], [CALLER_INTL, 'אני בדרך אליך']);
  agent.close();

  // a browser cannot join a WhatsApp conversation by guessing its id
  const ws = new WebSocket(`ws://127.0.0.1:${t.s.port}/ws?role=visitor&key=demo&vid=wa-${CALLER_INTL}`);
  const outcome = await new Promise((r) => {
    ws.onopen = () => r('open');
    ws.onerror = () => r('refused');
  });
  assert.equal(outcome, 'refused');
  await t.cleanup();
});

await test('callback bridge: provider failure is recorded and retried, autoCallback off and daily cap respected', async () => {
  reset();
  const t = await boot({ callbacksPerDay: 1 });
  await t.put({ notifyWhatsapp: OWNER_ALERT, callbackPhone: OWNER_CALL, missedCallEnabled: true });
  await t.missed({ caller: CALLER });
  prov.status = 500;
  await t.inbound(CALLER_INTL, 'יש נזילה!');
  await until(() => t.conv(CALLER_INTL).callback === 'failed', 'failure recorded');
  assert.equal(templates('new_chat').length, 1, 'the owner is still alerted when the bridge fails');
  assert.ok(!texts().some((c) => /יתקשר אליך/.test(c.body.text.body)), 'the caller is not promised a call that was not requested');
  prov.status = 200;
  await t.inbound(CALLER_INTL, 'עוד הודעה על הנזילה');
  await until(() => t.conv(CALLER_INTL).callback === 'requested', 'retry on the next message');

  // a second caller hits the daily cap of 1
  await t.missed({ caller: '0551111111' });
  await t.inbound('972551111111', 'יש נזילה!');
  await until(() => t.conv('972551111111')?.callback === 'limit', 'cap reached');
  assert.equal(prov.calls.filter((c) => c.url === '/bridge').length, 2, 'one failed attempt plus one accepted, none over the cap');

  // owner switched the automatic callback off
  await t.put({ autoCallback: false });
  await t.missed({ caller: '0552222222' });
  const n = prov.calls.length;
  await t.inbound('972552222222', 'יש נזילה!');
  await until(() => templates('new_chat').length >= 2, 'alert still sent');
  await sleep(150);
  assert.equal(prov.calls.length, n, 'no bridge with autoCallback off');
  assert.equal((await t.put({ callbackPhone: '123' })).status, 400);
  assert.equal((await t.json('/api/settings', { headers: t.auth })).body.callbackAvailable, true);
  await t.cleanup();
});

// ---------- Twilio adapter ----------
await test('Twilio adapter: Create Call request shape, XML-escaped TwiML, disabled without credentials', async () => {
  reset();
  const b = createCallBridge({ provider: 'twilio', twilioSid: 'AC123', twilioToken: 'secret', twilioFrom: '+972501110000', twilioApiUrl: provUrl, log: quiet });
  assert.equal(b.enabled, true);
  assert.equal(await b.bridge({ ownerPhone: '972502222222', callerPhone: CALLER_INTL, siteName: 'כהן <&> "אינסטלציה"', reason: 'urgent' }), true);
  const c = prov.calls[0];
  assert.equal(c.url, '/2010-04-01/Accounts/AC123/Calls.json');
  assert.equal(c.headers.authorization, `Basic ${Buffer.from('AC123:secret').toString('base64')}`);
  const form = new URLSearchParams(c.body);
  assert.equal(form.get('To'), '+972502222222');
  assert.equal(form.get('From'), '+972501110000');
  const twiml = form.get('Twiml');
  assert.match(twiml, /<Dial>\+972541234567<\/Dial>/);
  assert.match(twiml, /&lt;&amp;&gt;/);
  assert.doesNotMatch(twiml, /<&>/);
  assert.ok(twiml.length < 4000);
  prov.status = 401;
  assert.equal(await b.bridge({ ownerPhone: '972502222222', callerPhone: CALLER_INTL, siteName: 's', reason: 'urgent' }), false);
  for (const off of [createCallBridge({ provider: 'twilio', log: quiet }), createCallBridge({ provider: 'webhook', webhookUrl: 'ftp://x', log: quiet }), createCallBridge({ provider: '', log: quiet })]) {
    assert.equal(off.enabled, false);
    assert.equal(await off.bridge({}), false);
  }
  assert.equal(await createCallBridge({ provider: 'webhook', webhookUrl: 'http://127.0.0.1:1/x', log: quiet }).bridge({ ownerPhone: '1', callerPhone: '2', siteName: 's' }), false, 'unreachable provider: false, no throw');
});

metaSrv.close();
provSrv.close();
console.log(`${passed} passed`);
