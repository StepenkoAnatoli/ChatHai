<div dir="rtl">

# נקודת המשך (מעודכן 2026-11-06)

## מצב
- **פרויקט ראשי:** צ'אט חי, `livechat/livechat/standard/` (קוד). `npm test` עובר: 23 e2e + 9 בוט + 9 WebSocket + 5 חירום + 11 שיחה-שלא-נענתה. קומיט `0f133c7` הוא עד החירום; **כל מה שלהלן לא בגיט (לא נעשה commit).**
- **נוסף בסשן הזה (לא בקומיט):** זרימת שיחה שלא נענתה. `server/missedcall.js` (עזרים), `server/callbridge.js` (מתאם חיוג: `twilio` או `webhook` ל־n8n/Make), `server/notify.js` (`sendTemplate`, `sendText`), `server/index.js` (`POST /api/missed-call`, `GET/POST /api/whatsapp/webhook`, שליחת תשובות הבוט לוואטסאפ, חיוג גישור, הגדרות לאתר), `test/missedcall.test.js`, `MISSED-CALL.md` (זרימה, משתני סביבה, n8n, מה לא אומת).
- **לא עודכן:** `zero/`, והעותק `מערכת-מלאה-צאט-חי-ווטסאפ/01_צאט-חי` (עותק ישן, אין סנכרון).
- `npm run setup` תוקן (`scripts/setup.js` מסיר `npm_config_allow_scripts` שנכנס מ־`~/.npmrc`). נוסף UI בדשבורד (פאנל "שיחה שלא נענתה" ב־Settings, תגי וואטסאפ/חיוג ב־Dashboard); הבנייה עוברת, לא נבדק בדפדפן. השינויים האלה עדיין לא בקומיט (הקומיט האחרון: 648090b).

## החלטות ולמה
- המתאם נפרד (`bridge(job)`) כדי להחליף Twilio/n8n בלי לגעת בשרת.
- "מוכן לאדם" = חירום / הבוט לא ידע / המתקשר ביקש שיתקשרו. שאלה רגילה (שעות פעילות) לא מחייגת לבעל העסק.
- משוחחי וואטסאפ מזוהים לפי `wa-<מספר>`; דפדפן לא יכול להתחבר ל־id כזה.
- הודעה אחת לשעה למתקשר, מכסות לדקה/ליום, ה־endpoint כבוי בלי `MISSED_CALL_SECRET`, ה־webhook של Meta לא מקבל בלי חתימה.
- תמחור: ההחלטה הקודמת הייתה בוט ב-₪299 (`03_תמחור.md`). **מוצע לשינוי** (`05`, `06`): סולם ₪290 / ₪490 (+₪990 הקמה) / ₪790 (+₪1,500 הקמה) לקליניקות; מסלול בסיסי ₪149–199 לבעלי מקצוע; סיטונאי ₪200–250 לסוכנויות. טרם אושר.
- כיוון (`05`): שילוב. מיקוד במרפאות אסתטיקה ושיניים פרטיות; בעלי מקצוע כמסלול בסיסי. טרם אושר.

## פתוח (עודכן 2026-11-06, ראו `04`, `05`, `06`)
**פעולות:**
1. **חוסם השקה:** opt-in בשיחה עצמה (IVR: "הקישו 1 לוואטסאפ") + לוג חותמת זמן; חוות דעת משפטית (סעיף 30א, תיקון 13, סעיף 13ד).
2. Meta: Business Verification + App Review (שני סרטונים, Advanced access ל-`whatsapp_business_messaging` ו-`whatsapp_business_management`). Access Verification כבר לא נדרש; אם הטופס עדיין מופיע ב-Dashboard, למלא אותו.
3. Embedded Signup (להתחיל ב-Hosted) + coexistence; טבלת tenants (WABA/phone_number_id לכל לקוח) במקום `WHATSAPP_PHONE_ID` יחיד; webhooks של `message_template_status_update` ו-`phone_number_name_update` + re-register אחרי אישור שם.
4. להגיש את `missed_call_he` ולוודא קטגוריית utility.
5. מספר דמו Twilio IL (Local – $5.50 לחודש) + הקצאה אוטומטית לכל לקוח + שליחת הוראות *61 לפי מפעיל + שיחת בדיקה.
6. חיוב: SUMIT ל-MVP (או Cardcom בנפח), הוראת קבע + רצף גבייה ב-n8n. לא Stripe.
7. DPA בלחיצה + מדיניות פרטיות + כפתור ביטול עצמי.
8. סריקת אתר → FAQ + guardrails לחירום + בדיקה ידנית; ציון בריאות + התראת "ההפניה נשברה"; דוח שבועי אוטומטי.
9. שוק: 25 ראיונות (15 אסתטיקה, 10 שיניים), פיילוט 30 יום ב-5 קליניקות, 2 סוכנויות white-label לפיילוט. פנייה יזומה: הודעה חד-פעמית שמבקשת הסכמה בלבד.
10. תחזוקה: לבדוק UI בדפדפן; `zero/` – להחיל או למחוק; מדיניות שמירה ומחיקה לתמלולים; גישור: הודעת המשך כשבעל העסק לא ענה + אישור לחיצה נגד תא קולי.

**עדיין לא מאומת:**
11. Twilio IL: דרישות Regulatory Bundle/Address (Regulations API, IsoCountry=IL); הפניה מותנית מ-Partner/Cellcom/Pelephone/Bezeq למספר Twilio (בדיקה מעשית).
12. Coexistence: אישור רשמי שמספרי +972 נתמכים.
13. תעריף Meta ל-utility בישראל ($0.0053 מול $0.0061) – לאמת מול ה-CSV של Meta.
14. מחירונים רשמיים: Tranzila, iCount, Smartbee, Hyp, Grow עצמאי, PayPlus, מנוי Cardcom; Stripe – מעקב אחרי כניסה לישראל.
15. מחירים רשמיים: Interakt, AiSensy, Kommo, ManyChat, Tidio, Podium, Birdeye, Weave, NexHealth, Synthflow, Prospira, Easybizy; סוכנויות ישראליות נוספות.
16. 019 / זול / exm / Voicenter: תעריפי דקה ו-API.
17. API של Medform, Calmark, Easybizy (יצירת תור).
18. סעיף 13ד לחוק הגנת הצרכן לגבי לקוח עסקי; איכות LLM בעברית; churn ושעות תמיכה ללקוח ב-SMB SaaS.

## קבצים
- קוד: `livechat/livechat/standard/server/{bot,notify,index,store,missedcall,callbridge}.js`, `test/{emergency,missedcall}.test.js`, `MISSED-CALL.md`
- מחקר: `מערכת-מלאה-צאט-חי-ווטסאפ/03_תמחור.md`, `00_השוואה.md`, `04_מתחרים.md`, `05_פלחים-ומודלים.md`, `06_אוטומציה-ומונטיזציה.md`; מכירה ומשפט: `02_מערכת-וואטסאפ/`

</div>
