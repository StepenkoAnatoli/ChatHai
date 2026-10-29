// TEST-ONLY stand-in for the `htm` library (the sandbox cannot download the real one).
// Supports the subset used by public/dashboard.js: html`<${Comp} a=${v} b="str" c>text ${x}<//>`.
// Production uses the real htm from the CDN.
(function () {
  function htm(strings, ...values) {
    const h = this;
    let src = '';
    strings.forEach((s, i) => {
      src += s;
      if (i < values.length) src += '\u0000' + i + '\u0000';
    });
    let pos = 0;
    const PH = /\u0000(\d+)\u0000/g;

    function substitute(str) {
      const m = str.match(/^\u0000(\d+)\u0000$/);
      if (m) return values[+m[1]];
      return str.replace(PH, (_, i) => String(values[+i]));
    }

    function readName() {
      const start = pos;
      if (src[pos] === '\u0000') {
        pos += 1;
        while (src[pos] !== '\u0000') pos += 1;
        pos += 1;
        return substitute(src.slice(start, pos));
      }
      while (pos < src.length && !/[\s/>=]/.test(src[pos])) pos += 1;
      return src.slice(start, pos);
    }

    function textNodes(raw, out) {
      let last = 0;
      let m;
      PH.lastIndex = 0;
      const push = (t) => {
        const trimmed = t.replace(/^\s*\n\s*|\s*\n\s*$/g, '');
        if (trimmed) out.push(trimmed);
      };
      while ((m = PH.exec(raw))) {
        push(raw.slice(last, m.index));
        out.push(values[+m[1]]);
        last = m.index + m[0].length;
      }
      push(raw.slice(last));
    }

    function parseChildren() {
      const out = [];
      while (pos < src.length) {
        if (src[pos] === '<') {
          if (src[pos + 1] === '/') {
            pos = src.indexOf('>', pos) + 1;
            return out;
          }
          out.push(parseElement());
        } else {
          const end = src.indexOf('<', pos);
          const stop = end === -1 ? src.length : end;
          textNodes(src.slice(pos, stop), out);
          pos = stop;
        }
      }
      return out;
    }

    function parseElement() {
      pos += 1; // <
      const tag = readName();
      const props = {};
      let hasProps = false;
      let selfClosing = false;
      for (;;) {
        while (/\s/.test(src[pos])) pos += 1;
        if (src.startsWith('/>', pos)) {
          pos += 2;
          selfClosing = true;
          break;
        }
        if (src[pos] === '>') {
          pos += 1;
          break;
        }
        const name = readName();
        hasProps = true;
        if (src[pos] === '=') {
          pos += 1;
          if (src[pos] === '"' || src[pos] === "'") {
            const q = src[pos];
            const close = src.indexOf(q, pos + 1);
            props[name] = substitute(src.slice(pos + 1, close));
            pos = close + 1;
          } else {
            const start = pos;
            while (src[pos] === '\u0000' || /[\d]/.test(src[pos])) pos += 1;
            // value is a single placeholder: \0N\0
            const end = src.indexOf('\u0000', start + 1) + 1;
            props[name] = substitute(src.slice(start, end));
            pos = end;
          }
        } else {
          props[name] = true;
        }
      }
      const children = selfClosing ? [] : parseChildren();
      return h(tag, hasProps ? props : null, ...children);
    }

    const roots = parseChildren();
    return roots.length === 1 ? roots[0] : roots;
  }
  window.htm = htm;
})();
