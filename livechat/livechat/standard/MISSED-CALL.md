<div dir="rtl">

# שיחה שלא נענתה ← וואטסאפ ← בוט ← חיוג חוזר

## הזרימה
1. ספק המספר הווירטואלי (או n8n/Make לפניו) שולח `POST /api/missed-call?site=<מפתח האתר>` עם הכותרת `x-webhook-secret: <MISSED_CALL_SECRET>` וגוף `{"caller":"050-123-4567"}`.
2. השרת מאמת את הסוד, מגביל קצב, מאמת את המספר (`normalizePhone`) ושולח למתקשר תבנית וואטסאפ מאושרת (משתנה אחד: שם העסק). הודעה אחת לשעה לכל מתקשר.
3. תשובת המתקשר מגיעה ל־`POST /api/whatsapp/webhook` (חתום על ידי Meta), עוברת את אותו בוט (שאלות נפוצות, `isEmergency`) והתשובות חוזרות לוואטסאפ שלו. מי שלא קיבל מאיתנו הודעה ראשונה מתעלמים ממנו.
4. "מוכן לאדם" = חירום, או שהבוט לא ידע לענות, או שהמתקשר ביקש שיתקשרו אליו. אז: התראת וואטסאפ לבעל העסק (כבר קיימת, המספר של המתקשר בראשה) וחיוג גישור: קודם לבעל העסק, וכשהוא עונה מחברים את המתקשר. פעם אחת ל־30 דקות לשיחה, ועד `CALLBACKS_PER_DAY` (20) ביום לאתר.

## משתני סביבה
| משתנה | תפקיד |
|---|---|
| `MISSED_CALL_SECRET` | (16+ תווים) בלעדיו ה־endpoint כבוי (404) |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID` | כמו בהתראות |
| `WHATSAPP_MISSED_TEMPLATE` (+`_LANG`) | תבנית מאושרת עם משתנה גוף אחד: שם העסק |
| `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` | ל־webhook הנכנס של Meta. בלי הסוד לא מתקבלות הודעות |
| `CALL_PROVIDER=twilio` + `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | גישור דרך Twilio |
| `CALL_PROVIDER=webhook` + `CALL_WEBHOOK_URL`, `CALL_WEBHOOK_SECRET` | גישור דרך n8n/Make/שירות משלכם |
| `MISSED_CALLS_PER_MINUTE` (30), `CALLBACKS_PER_DAY` (20) | הגבלות |

הגדרות לכל אתר (`PUT /api/settings`): `missedCallEnabled`, `callbackPhone` (ברירת מחדל: מספר ההתראות), `autoCallback`, `missedCallText` (רישום בלבד, הנוסח האמיתי הוא התבנית ב־Meta).
בדשבורד עדיין אין שדות לזה; ה־API והתג `channel/phone/callback` ב־summary קיימים.

## חלופת n8n/Make
- **קלט:** ב־n8n webhook שמקבל את הפורמט של הספק ← צומת HTTP Request אל `/api/missed-call` עם הסוד והשדה `caller`.
- **גישור:** `CALL_PROVIDER=webhook` שולח ל־n8n `{"event":"callback_bridge","owner":"+972…","caller":"+972…","site":"…","reason":"urgent|needs_human|requested"}` עם הכותרת `x-webhook-secret`. ב־n8n מחייגים לבעל העסק ואז למתקשר (ספק הטלפוניה לבחירתכם). מחזירים 200 כשהבקשה התקבלה.
- מחליפים ספק בלי לגעת בשרת: רק `server/callbridge.js` (פונקציה אחת, `bridge(job)`).

## לא אומת (אין לטעון בלי בדיקה)
**אומת מול התיעוד הרשמי (2026-10-30):** מבנה ה־webhook הנכנס של Meta, handshake של `hub.challenge`, חתימת `X-Hub-Signature-256` (HMAC‑SHA256 על הגוף עם app secret), נקודת הקצה `/<PHONE_NUMBER_ID>/messages`, חלון שירות של 24 שעות ותבניות מחוצה לו, ושעסק רשאי לשלוח רק למי שנתן opt‑in. Twilio: `POST …/Accounts/{sid}/Calls.json` עם `To`, `From`, `Twiml` (עד 4000 תווים).

**לא אומת:**
- שהודעה ראשונה למי שרק התקשר נחשבת opt-in אצל Meta, באיזו קטגוריית תבנית היא תאושר ומה עולה; וחוק הספאם הישראלי (סעיף 30א).
- מבנה גוף ה־`text` ב־Cloud API (נלקח מהמבנה הכללי `{"type":"text","text":{"body":…}}`), ושגרסת ה־API `v21.0` בקוד עדיין נתמכת.
- Twilio: אימות Basic עם SID:Token, `<Say language="he-IL">` (תמיכה בעברית), `<Dial>` עם מספר גלוי, והתנהגות כשהבעלים מגיע לתא קולי (המתקשר יחובר לתא הקולי; אין `<Gather>` לאישור לחיצה).
- מספרים וירטואליים ישראליים: איזה ספק שולח webhook "לא נענתה", מה העלות, והאם Twilio מספקת מספר ישראלי או Caller ID ישראלי מאומת. לא נבדק.
- שום חלק לא נוסה מול Meta או ספק חיוג אמיתיים; הבדיקות משתמשות בשרתים מדומים.
</div>
