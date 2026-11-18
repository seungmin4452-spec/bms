// Google Chat 폴링용 최소 클라이언트 (외부 의존성 없음, Node 20+)
// 사용법:
//   node chat.js auth            최초 1회: 브라우저 동의 → refresh token 저장
//   node chat.js list [개수]      스페이스 최근 메시지 출력 (테스트용)
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

const SECRET_DIR = path.join(process.env.USERPROFILE, '.pigon-chat');
const CLIENT_PATH = path.join(SECRET_DIR, 'client_secret.json');
const TOKEN_PATH = path.join(SECRET_DIR, 'token.json');
const CONFIG_PATH = path.join(__dirname, 'config.json');

const SCOPES = [
  'https://www.googleapis.com/auth/chat.messages.readonly',
  'https://www.googleapis.com/auth/chat.messages.create',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/documents.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
];

function loadClient() {
  const raw = JSON.parse(fs.readFileSync(CLIENT_PATH, 'utf8'));
  return raw.installed || raw.web;
}

async function auth() {
  const client = loadClient();
  const server = http.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const redirectUri = `http://127.0.0.1:${server.address().port}`;
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
  });
  console.log('브라우저에서 회사 계정으로 로그인/동의하세요:\n' + url);
  execFile('cmd', ['/c', 'start', '', url.replace(/&/g, '^&')]);

  const code = await new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      const q = new URL(req.url, redirectUri).searchParams;
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(q.get('code') ? '인증 완료. 이 창은 닫아도 됩니다.' : '인증 실패: ' + q.get('error'));
      server.close();
      q.get('code') ? resolve(q.get('code')) : reject(new Error(q.get('error')));
    });
  });

  const tok = await postForm('https://oauth2.googleapis.com/token', {
    code, client_id: client.client_id, client_secret: client.client_secret,
    redirect_uri: redirectUri, grant_type: 'authorization_code',
  });
  if (!tok.refresh_token) throw new Error('refresh_token 미발급: ' + JSON.stringify(tok));
  fs.writeFileSync(TOKEN_PATH, JSON.stringify({ refresh_token: tok.refresh_token }, null, 2));
  console.log('저장 완료: ' + TOKEN_PATH);
}

async function accessToken() {
  const client = loadClient();
  const { refresh_token } = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  const tok = await postForm('https://oauth2.googleapis.com/token', {
    refresh_token, client_id: client.client_id, client_secret: client.client_secret,
    grant_type: 'refresh_token',
  });
  if (!tok.access_token) throw new Error('토큰 갱신 실패: ' + JSON.stringify(tok));
  return tok.access_token;
}

async function postForm(url, body) {
  const res = await fetch(url, { method: 'POST', body: new URLSearchParams(body) });
  return res.json();
}

async function list(n) {
  const { spaceId } = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const token = await accessToken();
  const url = `https://chat.googleapis.com/v1/spaces/${spaceId}/messages?` +
    new URLSearchParams({ pageSize: String(n), orderBy: 'createTime desc' });
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const data = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
  for (const m of (data.messages || []).reverse()) {
    const text = (m.text || '').replace(/\s+/g, ' ').slice(0, 120);
    console.log(`${m.createTime} | ${m.sender && m.sender.name} | thread=${m.thread && m.thread.name} | ${text}`);
  }
}

(async () => {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'auth') return auth();
  if (cmd === 'list') return list(Number(arg) || 10);
  console.log('usage: node chat.js auth | list [n]');
})().catch(e => { console.error(e.message); process.exit(1); });
