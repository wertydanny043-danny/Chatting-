// 실시간 채팅 서버 - 외부 의존성은 'ws' 하나뿐 (나머지는 Node 내장 모듈)
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const HISTORY_FILE = path.join(DATA_DIR, 'messages.json');
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_HISTORY = 500;
const MAX_TEXT = 2000;

const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
const BLOCKED_EXT = new Set([
  '.exe', '.bat', '.cmd', '.com', '.scr', '.msi', '.vbs', '.ps1', '.sh', '.jar', '.dll',
]);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- 메시지 기록 (파일로 저장) ----------
let history = [];
try {
  history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  if (!Array.isArray(history)) history = [];
} catch {
  history = [];
}

let saveTimer = null;
function saveHistory() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(HISTORY_FILE, JSON.stringify(history), () => {});
  }, 300);
}

function addMessage(msg) {
  history.push(msg);
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  saveHistory();
  broadcast({ type: 'message', message: msg });
}

function cleanNick(v) {
  return String(v || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 20) || '익명';
}
function cleanId(v) {
  return String(v || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
}
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ---------- 파일 업로드: 요청 본문 자체가 파일 (POST /upload?name=...&nick=...&clientId=...) ----------
function handleUpload(req, res, url) {
  const originalName = (url.searchParams.get('name') || 'file').replace(/[\u0000-\u001f/\\]/g, '_').slice(0, 200);
  const ext = path.extname(originalName).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);

  if (BLOCKED_EXT.has(ext)) return sendJson(res, 400, { error: '실행 파일은 올릴 수 없어요.' });

  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_FILE_SIZE) return sendJson(res, 413, { error: '파일은 10MB까지 올릴 수 있어요.' });
  if (declared === 0) return sendJson(res, 400, { error: '빈 파일은 올릴 수 없어요.' });

  const stored = crypto.randomBytes(16).toString('hex') + ext;
  const filePath = path.join(UPLOAD_DIR, stored);
  const out = fs.createWriteStream(filePath);
  let size = 0;
  let aborted = false;

  const fail = (status, error) => {
    if (aborted) return;
    aborted = true;
    out.destroy();
    fs.unlink(filePath, () => {});
    sendJson(res, status, { error });
    req.unpipe(out);
    req.resume();
  };

  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_FILE_SIZE) fail(413, '파일은 10MB까지 올릴 수 있어요.');
  });
  req.on('error', () => fail(400, '업로드에 실패했어요.'));
  out.on('error', () => fail(500, '파일을 저장하지 못했어요.'));
  out.on('finish', () => {
    if (aborted) return;
    addMessage({
      id: crypto.randomBytes(8).toString('hex'),
      type: 'file',
      clientId: cleanId(url.searchParams.get('clientId')),
      nick: cleanNick(url.searchParams.get('nick')),
      time: Date.now(),
      file: {
        url: '/files/' + stored,
        name: originalName,
        size,
        isImage: Object.prototype.hasOwnProperty.call(IMAGE_TYPES, ext),
      },
    });
    sendJson(res, 200, { ok: true });
  });
  req.pipe(out);
}

// ---------- 업로드 파일 제공 ----------
// 이미지는 화면에 표시, 그 외(html 포함)는 항상 '다운로드'로만 제공 (브라우저에서 실행되지 않음)
function handleFile(req, res, url) {
  const name = decodeURIComponent(url.pathname.slice('/files/'.length));
  if (!/^[a-f0-9]{32}(\.[a-z0-9]{1,10})?$/.test(name)) return res.writeHead(404).end();
  const filePath = path.join(UPLOAD_DIR, name);
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return res.writeHead(404).end();

    const ext = path.extname(name).toLowerCase();
    const headers = {
      'Content-Length': st.size,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Cache-Control': 'public, max-age=31536000, immutable',
    };
    if (IMAGE_TYPES[ext]) {
      headers['Content-Type'] = IMAGE_TYPES[ext];
    } else {
      const dl = (url.searchParams.get('name') || name).replace(/[\u0000-\u001f]/g, '').slice(0, 200);
      headers['Content-Type'] = 'application/octet-stream';
      headers['Content-Disposition'] = "attachment; filename*=UTF-8''" + encodeURIComponent(dl);
    }
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---------- HTTP 서버 ----------
const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return res.writeHead(400).end();
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return fs.readFile(INDEX_FILE, (err, data) => {
      if (err) return res.writeHead(500).end('index.html 을 찾을 수 없어요.');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  }
  if (req.method === 'POST' && url.pathname === '/upload') return handleUpload(req, res, url);
  if (req.method === 'GET' && url.pathname.startsWith('/files/')) return handleFile(req, res, url);
  res.writeHead(404).end('Not found');
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}
function broadcastOnline() {
  broadcast({ type: 'online', count: wss.clients.size });
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.send(JSON.stringify({ type: 'history', messages: history }));
  broadcastOnline();

  // 간단한 도배 방지: 1초에 5개까지
  let tokens = 5;
  const refill = setInterval(() => (tokens = 5), 1000);

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!data || data.type !== 'chat') return;
    const text = String(data.text || '').replace(/\r\n/g, '\n').trim().slice(0, MAX_TEXT);
    if (!text || tokens <= 0) return;
    tokens--;

    addMessage({
      id: crypto.randomBytes(8).toString('hex'),
      type: 'text',
      clientId: cleanId(data.clientId),
      nick: cleanNick(data.nick),
      text,
      time: Date.now(),
    });
  });

  ws.on('close', () => {
    clearInterval(refill);
    broadcastOnline();
  });
  ws.on('error', () => {});
});

// 끊긴 연결 정리 (30초마다)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`채팅 서버 실행 중: http://localhost:${PORT}`);
});
