import { Fragment, useEffect, useRef, useState } from 'react';
import { timeOf, visitorName } from './api.js';

export default function ChatPane({ conv, onReply, onClose, onBack }) {
  const [text, setText] = useState('');
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView();
  }, [conv.id, conv.messages.length]);

  function submit(e) {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    onReply(conv.id, value);
    setText('');
  }

  const who = { visitor: visitorName(conv), bot: 'בוט', agent: 'אתם' };

  return (
    <div className="chat">
      <div className="chat-head">
        <button className="btn ghost back" onClick={onBack}>חזרה</button>
        <b>
          <span className={`dot ${conv.online ? 'on' : ''}`}></span>
          {visitorName(conv)}
        </b>
        {conv.humanTakeover ? <span className="pill human">אתם מטפלים בשיחה</span> : <span className="pill">הבוט פעיל</span>}
        {conv.status === 'open' && (
          <button className="btn danger" onClick={() => onClose(conv.id)}>סיום טיפול</button>
        )}
      </div>
      <div className="msgs">
        {conv.messages.map((m) => (
          <Fragment key={m.id}>
            <div className={`meta ${m.from === 'visitor' ? '' : 'right'}`}>
              {who[m.from]} · {timeOf(m.ts)}
            </div>
            <div className={`msg ${m.from}`} dir="auto">{m.text}</div>
          </Fragment>
        ))}
        <div ref={endRef}></div>
      </div>
      <form className="reply" onSubmit={submit}>
        <input type="text" dir="auto" placeholder="כתבו תשובה..." value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} />
        <button className="btn" disabled={!text.trim()}>שליחה</button>
      </form>
    </div>
  );
}
