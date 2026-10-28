# איך לבנות את הבוט ב-WATI

## שלב 1: ברכה
- Type: Message
- Text: היי! איך אפשר לעזור?\n\nבחר אחת מהאפשרויות:
- Buttons: חירום / דחוף | פנייה רגילה

## שלב 2: מיון חירום
כשנבחר חירום / דחוף -> Message + Buttons
כפתורים: נזילה / דליפה | פיצוץ צינור | אין מים | בעיה חשמלית דחופה | אין חשמל | אחר - דחוף
חבר את כולם ל-emergency_type (שמירת סוג התקלה)

## שלב 3: שם + כתובת (חירום)
1. Save Answer - שמירת בחירת סוג התקלה ל-emergency_type
2. Question - איך קוראים לך? (emergency_name)
3. Question - מה הכתובת המלאה (עיר, רחוב, מספר בית)? (emergency_address)
4. Human Handoff - עם שם, טלפון, כתובת ובעיה ({{emergency_type}})

## שלב 4: פנייה רגילה
1. Question - איך קוראים לך? (name)
2. Question - מה הכתובת? (address)
3. Question - תאר בקצרה את הבעיה (issue)
4. Question - אם יש תמונה שלח, אם אין לחץ 'אין תמונה' (photo)
5. Message + כפתור העבר לנציג -> Human Handoff

## כללים
- תמיד Human Handoff
- ללא מתן מחיר סופי
- העברה מיידית בחירום
