// Minimal RFC 6455 WebSocket server side, using only Node built-ins.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 64 * 1024;

export function acceptUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  return new WebSocketConnection(socket);
}

export function rejectUpgrade(socket, status, reason) {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function frame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

class WebSocketConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.alive = true;
    this.closed = false;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('close', () => this.onClosed());
    socket.on('error', () => this.onClosed());
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (!this.closed) {
      const parsed = this.parseFrame();
      if (!parsed) return;
      this.handleFrame(parsed);
    }
  }

  parseFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_PAYLOAD)) {
        this.close(1009);
        return null;
      }
      len = Number(big);
      offset = 10;
    }
    if (len > MAX_PAYLOAD) {
      this.close(1009);
      return null;
    }
    if (!masked) {
      this.close(1002);
      return null;
    }
    if (buf.length < offset + 4 + len) return null;
    const mask = buf.subarray(offset, offset + 4);
    const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + len));
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    this.buffer = buf.subarray(offset + 4 + len);
    return { fin, opcode, payload };
  }

  handleFrame({ fin, opcode, payload }) {
    if (opcode === 8) return this.close(1000);
    if (opcode === 9) return void this.socket.write(frame(10, payload));
    if (opcode === 10) {
      this.alive = true;
      return;
    }
    if (opcode === 1 || opcode === 2) {
      this.fragments = [payload];
      this.fragmentOpcode = opcode;
    } else if (opcode === 0) {
      this.fragments.push(payload);
    } else {
      return this.close(1002);
    }
    if (!fin) {
      const total = this.fragments.reduce((n, p) => n + p.length, 0);
      if (total > MAX_PAYLOAD) this.close(1009);
      return;
    }
    const message = Buffer.concat(this.fragments);
    this.fragments = [];
    if (this.fragmentOpcode === 1) {
      try {
        this.emit('message', message.toString('utf8'));
      } catch (err) {
        console.error('message handler failed', err);
        this.close(1011);
      }
    }
  }

  send(text) {
    if (this.closed) return;
    this.socket.write(frame(1, Buffer.from(text, 'utf8')));
  }

  ping() {
    if (this.closed) return;
    this.socket.write(frame(9, Buffer.alloc(0)));
  }

  close(code = 1000) {
    if (this.closed) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    this.socket.write(frame(8, payload));
    this.socket.end();
    this.onClosed();
  }

  onClosed() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}
