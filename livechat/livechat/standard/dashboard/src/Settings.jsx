import { useEffect, useState } from 'react';
import { api } from './api.js';

export default function Settings({ token, site }) {
  const [faq, setFaq] = useState(null);
  const [settings, setSettings] = useState(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api('/api/faq', token), api('/api/settings', token)])
      .then(([f, s]) => {
        setFaq(f.faq);
        setSettings({ ...s, origins: (s.allowedOrigins || []).join('\n') });
      })
      .catch((err) => setError(err.message));
  }, [token]);

  if (error && !faq) return <div className="settings"><div className="error">{error}</div></div>;
  if (!faq || !settings) return <div className="settings"><div className="empty">טוען...</div></div>;

  const updateFaq = (i, field, value) => setFaq(faq.map((row, idx) => (idx === i ? { ...row, [field]: value } : row)));
  const set = (field) => (e) => setSettings({ ...settings, [field]: e.target.value });

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
          notifyWhatsapp: settings.notifyWhatsapp,
          emergencyReply: settings.emergencyReply,
          privacyNote: settings.privacyNote,
          missedCallEnabled: settings.missedCallEnabled,
          missedCallText: settings.missedCallText,
          callbackPhone: settings.callbackPhone,
          autoCallback: settings.autoCallback,
          allowedOrigins: settings.origins.split('\n').map((s) => s.trim()).filter(Boolean),
        },
      });
      setMsg('נשמר');
      setTimeout(() => setMsg(''), 2500);
    } catch (err) {
      setError(err.message);
    }
  }

  const snippet = `<script src="${location.origin}/widget.js" data-site-key="${site.key}" async></script>`;

  return (
    <div className="settings">
      <div className="panel">
        <h3>הוספת הצ׳אט לאתר שלכם</h3>
        <p style={{ color: '#6b7280', fontSize: '14px' }}>יש להדביק את הקוד בסוף כל עמוד באתר, ממש לפני סגירת תגית ה־body.</p>
        <code className="snippet">{snippet}</code>
      </div>

      <div className="panel">
        <h3>מראה והודעות</h3>
        <label htmlFor="set-name">שם העסק</label>
        <input id="set-name" type="text" value={settings.name} onChange={set('name')} />
        <label htmlFor="set-color">צבע</label>
        <input id="set-color" type="color" value={settings.color} onChange={set('color')} />
        <label htmlFor="set-greeting">ברכה למבקרים חדשים</label>
        <input id="set-greeting" type="text" value={settings.greeting} onChange={set('greeting')} />
        <label htmlFor="set-fallback">הודעה כשהבוט לא יודע את התשובה</label>
        <input id="set-fallback" type="text" value={settings.fallback} onChange={set('fallback')} />
        <label htmlFor="set-email">מייל להתראות כשאין נציג מחובר (לא חובה)</label>
        <input id="set-email" type="email" dir="ltr" value={settings.notifyEmail} onChange={set('notifyEmail')} />
        {!settings.emailEnabled && <p style={{ color: '#b45309', fontSize: '13px' }}>שליחת מיילים עדיין לא הוגדרה בשרת (RESEND_API_KEY ו־MAIL_FROM), ולכן לא יישלחו התראות.</p>}
        <label htmlFor="set-wa">וואטסאפ להתראות, בעיקר לפניות דחופות (למשל 0501234567, לא חובה)</label>
        <input id="set-wa" type="tel" dir="ltr" value={settings.notifyWhatsapp} onChange={set('notifyWhatsapp')} />
        {!settings.whatsappEnabled && <p style={{ color: '#b45309', fontSize: '13px' }}>שליחת וואטסאפ עדיין לא הוגדרה בשרת (WHATSAPP_TOKEN, WHATSAPP_PHONE_ID ו־WHATSAPP_TEMPLATE), ולכן לא יישלחו התראות.</p>}
        <label htmlFor="set-emergency">תשובה אוטומטית כשהמבקר כותב על חירום (נזילה, ניצוצות, אין חשמל ועוד)</label>
        <input id="set-emergency" type="text" value={settings.emergencyReply} onChange={set('emergencyReply')} />
        <label htmlFor="set-privacy">הודעת פרטיות מתחת לשדה ההקלדה (אפשר להשאיר ריק)</label>
        <input id="set-privacy" type="text" value={settings.privacyNote} onChange={set('privacyNote')} />
        <label htmlFor="set-origins">אתרים מותרים (אחד בכל שורה, למשל https://shop.example.com). אם השדה ריק, כל אתר רשאי להשתמש בצ׳אט.</label>
        <textarea id="set-origins" value={settings.origins} onChange={set('origins')}></textarea>
      </div>

      <div className="panel">
        <h3>שיחה שלא נענתה</h3>
        <p style={{ color: '#6b7280', fontSize: '14px' }}>כשמישהו מתקשר ואף אחד לא עונה, נשלחת לו הודעת וואטסאפ והבוט ממשיך את השיחה. פנייה דחופה או בקשה לשיחה מתריעה אליכם ומחייגת אליכם ואז אל הלקוח.</p>
        <label htmlFor="set-mc-on"><input id="set-mc-on" type="checkbox" checked={!!settings.missedCallEnabled} onChange={(e) => setSettings({ ...settings, missedCallEnabled: e.target.checked })} /> הפעלת השירות</label>
        {!settings.missedCallAvailable && <p style={{ color: '#b45309', fontSize: '13px' }}>השירות עדיין לא הוגדר בשרת (MISSED_CALL_SECRET, WHATSAPP_MISSED_TEMPLATE ופרטי וואטסאפ).</p>}
        <label htmlFor="set-mc-text">נוסח ההודעה שנשלחת (לתיעוד בשיחה בלבד; ההודעה בפועל היא התבנית המאושרת ב־Meta)</label>
        <input id="set-mc-text" type="text" value={settings.missedCallText} onChange={set('missedCallText')} />
        <label htmlFor="set-cb-phone">מספר לחיוג חוזר אליכם (אם ריק, מספר הוואטסאפ להתראות)</label>
        <input id="set-cb-phone" type="tel" dir="ltr" value={settings.callbackPhone} onChange={set('callbackPhone')} />
        <label htmlFor="set-cb-auto"><input id="set-cb-auto" type="checkbox" checked={!!settings.autoCallback} onChange={(e) => setSettings({ ...settings, autoCallback: e.target.checked })} /> חיוג אוטומטי אליכם כשיש פנייה דחופה או בקשה לשיחה</label>
        {!settings.callbackAvailable && <p style={{ color: '#b45309', fontSize: '13px' }}>חיוג חוזר עדיין לא הוגדר בשרת (CALL_PROVIDER), ולכן תקבלו רק התראה.</p>}
      </div>

      <div className="panel">
        <h3>תשובות הבוט (שאלות נפוצות)</h3>
        <p style={{ color: '#6b7280', fontSize: '14px' }}>
          הבוט עונה כשהודעת המבקר דומה לשאלה או למילות המפתח שלה. כל השאר מגיע אליכם.
        </p>
        {faq.map((row, i) => (
          <div className="faq-row" key={i}>
            <label htmlFor={`faq-q-${i}`}>שאלה</label>
            <input id={`faq-q-${i}`} type="text" value={row.q} onChange={(e) => updateFaq(i, 'q', e.target.value)} />
            <label htmlFor={`faq-a-${i}`}>תשובה</label>
            <textarea id={`faq-a-${i}`} value={row.a} onChange={(e) => updateFaq(i, 'a', e.target.value)}></textarea>
            <label htmlFor={`faq-k-${i}`}>מילות מפתח נוספות (לא חובה)</label>
            <input id={`faq-k-${i}`} type="text" value={row.keywords || ''} onChange={(e) => updateFaq(i, 'keywords', e.target.value)} />
            <div style={{ marginTop: '8px' }}>
              <button className="btn danger" onClick={() => setFaq(faq.filter((_, idx) => idx !== i))}>הסרה</button>
            </div>
          </div>
        ))}
        <div style={{ marginTop: '12px' }}>
          <button className="btn ghost" onClick={() => setFaq([...faq, { q: '', a: '', keywords: '' }])}>הוספת שאלה</button>
        </div>
      </div>

      <div className="panel">
        <button className="btn" onClick={save}>שמירת שינויים</button>
        {msg && <span className="ok">{msg}</span>}
        {error && <span className="error" style={{ marginInlineStart: '10px' }}>{error}</span>}
      </div>
    </div>
  );
}
