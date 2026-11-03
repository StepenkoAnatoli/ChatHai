<div dir="rtl">

# צ׳אט חי: הגרסה הסטנדרטית (Node + ws + React/Vite)

## הרצה

דורש Node 22 ומעלה.

```bash
npm run setup      # מתקין את תלויות השרת (ws) ולוח הבקרה (React, Vite)
npm run build      # בונה את לוח הבקרה לתוך dashboard/dist
npm start          # http://localhost:3000
```

- לוח בקרה: <http://localhost:3000/> (התחברות לדוגמה: מפתח אתר `demo`, סיסמה `demo123`)
- "אתר לקוח" לדוגמה עם בועת הצ׳אט: <http://localhost:3000/demo>

אתר ההדגמה נוצר אוטומטית בהפעלה הראשונה. מחק אותו, או הפעל עם `SEED_DEMO=0`, לפני העלייה לאוויר.

## פיתוח

שני טרמינלים:

```bash
npm run dev:server      # שרת הצ׳אט על :3000, עם הפעלה מחדש בכל שינוי
npm run dev:dashboard   # Vite על :5173, מעביר /api ו־/ws אל :3000
```

פתח את <http://localhost:5173/> ללוח הבקרה עם טעינה חמה.

## הוספת לקוח

הגדר אסימון מנהל (לפחות 16 תווים) כשמפעילים את השרת, ואז צור אתרים דרך HTTP:

```bash
ADMIN_TOKEN=$(openssl rand -hex 16) npm start

curl -X POST http://localhost:3000/api/admin/sites \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"name":"חנות אקמי","allowedOrigins":["https://acme.example"]}'
# -> {"key":"...","name":"חנות אקמי","password":"..."}
```

מסור ללקוח את מפתח האתר והסיסמה להתחברות ללוח הבקרה. בלשונית **הגדרות** הוא ימצא את קוד ההטמעה:

```html
<script src="https://chat.yourdomain.com/widget.js" data-site-key="SITE_KEY" async></script>
```

שם הוא גם יכול לערוך את ה־FAQ, הברכה, הצבע והאתרים המותרים (אתרים מותרים חייבים להיות כתובות מלאות כמו `https://shop.example.com`; כל דבר אחר נדחה). בלי `ADMIN_TOKEN` נקודת הקצה הזו לא קיימת; `npm run create-site -- "שם"` עובד כשהשרת כבוי.

## תשובות מבוססות Claude (לא חובה)

הגדר `ANTHROPIC_API_KEY` והבוט ישאל את Claude כשאין התאמה ב־FAQ. Claude עונה רק מתוך ה־FAQ של אותו לקוח, בשפת המבקר (עברית כברירת מחדל כשלא ברור); אם הוא לא בטוח, השיחה עוברת לנציג אנושי כרגיל. `CLAUDE_MODEL` (ברירת מחדל `claude-haiku-5-5`) קובע את המודל. בלי מפתח, משתמשים רק ב־FAQ.

## התראות מייל כשאין נציג מחובר

כשמבקר כותב שאלה שהבוט לא יודע לענות עליה, ואף נציג לא פתוח בלוח הבקרה, הלקוח מקבל מייל עם ההודעה וקישור ללוח הבקרה. מייל אחד לכל שיחה בעשר דקות, כדי לא להציף. שאלות שהבוט ענה עליהן לא שולחות מייל.

1. פתח חשבון ב־Resend, אמת דומיין, והגדר `RESEND_API_KEY`, `MAIL_FROM` ו־`DASHBOARD_URL` בשרת.
2. בלשונית **הגדרות** של כל לקוח, מלא "מייל להתראות". בלי כתובת, או בלי משתני הסביבה, לא נשלח כלום (לוח הבקרה מציג אזהרה כשהשרת לא מוגדר).

שליחה שנכשלה לא פוגעת בצ׳אט; היא נרשמת ביומן השרת ונוסה שוב בהודעה הבאה.

## הודעת פרטיות

מתחת לשדה ההקלדה בווידג'ט מופיעה שורה: "השיחה נשמרת אצל בעל האתר לצורך מתן שירות." הלקוח יכול לשנות אותה או לרוקן אותה בלשונית **הגדרות**. זו לא תחליף לניסוח משפטי: עדיף לתאם עם הלקוח מדיניות שמירה ולקשר אליה מהאתר.

## הגדרות (משתני סביבה)

| משתנה | ברירת מחדל | |
|---|---|---|
| `PORT` | 3000 | |
| `DATA_FILE` | `server/data.json` | כל האתרים והשיחות |
| `ADMIN_TOKEN` | כבוי | מפעיל את `POST /api/admin/sites` |
| `TRUST_PROXY` | כבוי | הגדר `1` מאחורי Caddy/nginx כדי שהגבלת ההתחברות תשתמש בכתובת הלקוח האמיתית (הערך האחרון ב־`X-Forwarded-For`) |
| `SEED_DEMO` | פעיל, חוץ מ־`NODE_ENV=production` | `1` מכריח את אתר `demo` / `demo123`, `0` אף פעם לא יוצר אותו |
| `IP_MESSAGES_PER_MINUTE` | 120 | הגבלת הודעות לכתובת IP בדקה (מעבר לגבלה לכל שיחה) |
| `IP_NEW_CONVERSATIONS_PER_HOUR` | 30 | כמה שיחות חדשות כתובת IP אחת יכולה לפתוח בשעה |
| `RESEND_API_KEY` | כבוי | מפתח של [Resend](https://resend.com) לשליחת התראות מייל (ראה למטה) |
| `MAIL_FROM` | כבוי | כתובת השולח, בדומיין שאומת ב־Resend, למשל `chat@yourdomain.com` |
| `DASHBOARD_URL` | ריק | כתובת לוח הבקרה, שתופיע כקישור במייל |
| `ANTHROPIC_API_KEY` | כבוי | מפעיל תשובות Claude |
| `CLAUDE_MODEL` | `claude-haiku-5-5` | |
| `DASHBOARD_DIST` | `dashboard/dist` | מיקום לוח הבקרה הבנוי |

## פריסה

הרץ `npm start` תחת מנהל תהליכים (systemd, pm2, Docker) מאחורי HTTPS, עם `NODE_ENV=production` ו־`TRUST_PROXY=1`. עם Caddy:

```
chat.yourdomain.com {
    reverse_proxy localhost:3000
}
```

Caddy מעביר WebSocket אוטומטית; ב־nginx יש להוסיף את הכותרות `Upgrade` ו־`Connection`.

## בדיקות

```bash
npm test               # בדיקות שרת ובוט (לא צריך דפדפן)
npm run test:browser   # Chromium אמיתי: דורש `npm run build`, וגם `pip install playwright && playwright install chromium`
```

## מבנה

```
server/index.js     API, WebSocket וקבצים סטטיים
server/store.js     אתרים, שיחות, שמירה ל־JSON, גיבוב סיסמאות
server/bot.js       התאמת FAQ (עברית + אנגלית) והקריאה האופציונלית ל־Claude
server/public/      widget.js (הצ׳אט להטמעה) ו־demo.html
dashboard/          לוח בקרה ב־React + Vite
test/               בדיקות קצה־לקצה, בוט ודפדפן
```

</div>
