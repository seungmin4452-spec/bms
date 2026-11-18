// 개발 봇 로컬 관리 페이지 서버
// 실행: node admin/server.js  →  http://127.0.0.1:20020
// - 봇 코드(poll.js 등)는 건드리지 않는다. 스케줄 작업을 제어하고 봇이 남긴 파일을 읽기만 한다.
// - 내장 모듈만 사용한다.
'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const createHarness = require('./harness');
const createAssistant = require('./assistant');
const createUsage = require('./usage');
const createChat = require('./chat');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(__dirname, 'public');
const RUNS_DIR = path.join(ROOT, 'runs');
const PORT = Number(process.env.ADMIN_PORT) || 20020;
const TASK = process.env.ADMIN_TASK || 'PigonChatBot';
const TOKEN = crypto.randomBytes(24).toString('hex');
const INTERVALS = { 10: 'PT10M', 15: 'PT15M', 30: 'PT30M', 60: 'PT1H' };
const HOSTS = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
const TAIL_BYTES = 200 * 1024;
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
  '/chat-panel.js': ['chat-panel.js', 'text/javascript; charset=utf-8'],
};

if (!/^[\w-]{1,64}$/.test(TASK)) throw new Error('ADMIN_TASK 값이 올바르지 않습니다');

// ---------- 공통 ----------
function audit(action, result) {
  const d = new Date();
  const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const dir = path.join(ROOT, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `admin-${day}.log`), `[${d.toISOString()}] ${action} → ${result}\n`);
}

// 입력값은 스크립트 문자열에 넣지 않고 환경변수로만 넘긴다
function ps(script, extraEnv) {
  return new Promise((resolve, reject) => {
    const full = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; " + script;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', full], {
      env: Object.assign({}, process.env, { ADMIN_TASK_NAME: TASK }, extraEnv),
      windowsHide: true, timeout: 20000, encoding: 'utf8',
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).split(/\r?\n/)[0].slice(0, 200)));
      resolve(stdout.trim());
    });
  });
}

function readTail(file, maxBytes) {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - maxBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return { text: buf.toString('utf8'), truncated: start > 0 };
  } finally {
    fs.closeSync(fd);
  }
}

// ---------- 스케줄 작업 ----------
// ScheduledTasks 모듈(Get-ScheduledTask)은 한 번 부를 때 5초 넘게 걸려서 COM 을 직접 쓴다 (약 0.7초)
const TASK_OPEN = "$s = New-Object -ComObject Schedule.Service; $s.Connect(); $folder = $s.GetFolder('\\'); $t = $folder.GetTask($env:ADMIN_TASK_NAME); ";
const TASK_INFO = TASK_OPEN + `
$f = { param($d) if ($d -and $d.Year -gt 2000) { $d.ToUniversalTime().ToString('o') } else { $null } }
$d = $t.Definition
[pscustomobject]@{
  enabled = [bool]$t.Enabled
  lastRun = (& $f $t.LastRunTime)
  nextRun = (& $f $t.NextRunTime)
  lastResult = ([long]$t.LastTaskResult) -band 4294967295
  interval = "$($d.Triggers.Item(1).Repetition.Interval)"
  timeLimit = "$($d.Settings.ExecutionTimeLimit)"
} | ConvertTo-Json -Compress`;

function minutesOf(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?/.exec(iso || '');
  return m ? Number(m[1] || 0) * 60 + Number(m[2] || 0) : null;
}

// 0x800710E0: 중복 실행 정책(IgnoreNew)으로 이전 실행이 아직 진행 중이라 이번 회차를 건너뜀 — 오류 아님
const SKIPPED_BUSY = 0x800710E0;
const RESULT_TEXT = { 0: '정상 종료', 267009: '실행 중', 267011: '아직 실행한 적 없음', 3221225786: '강제 종료됨', [SKIPPED_BUSY]: '이전 실행이 진행 중이라 이번 회차는 건너뜀' };
const OK_RESULTS = [0, 267009, 267011, SKIPPED_BUSY];

let taskCache = null;
async function getTask(force) {
  if (!force && taskCache && Date.now() - taskCache.at < 4000) return taskCache.value;
  const raw = JSON.parse(await ps(TASK_INFO));
  const value = {
    name: TASK,
    enabled: raw.enabled,
    lastRun: raw.lastRun,
    nextRun: raw.nextRun,
    lastResult: raw.lastResult,
    lastResultText: RESULT_TEXT[raw.lastResult] || `오류 코드 0x${raw.lastResult.toString(16).toUpperCase()}`,
    intervalMinutes: minutesOf(raw.interval),
    timeLimitMinutes: minutesOf(raw.timeLimit),
  };
  taskCache = { at: Date.now(), value };
  return value;
}

// ---------- 봇이 남긴 파일 ----------
function getLock() {
  let pid;
  try {
    pid = Number(fs.readFileSync(path.join(ROOT, 'state', 'poll.lock'), 'utf8').trim());
  } catch (e) {
    return { exists: false, alive: false };
  }
  if (!Number.isInteger(pid) || pid <= 0) return { exists: true, alive: false };
  try {
    process.kill(pid, 0);
    return { exists: true, alive: true, pid };
  } catch (e) {
    return { exists: true, alive: e.code === 'EPERM', pid };
  }
}

const HEAD = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) \| ([\w-]+) \| (\w+) \| (\S+) \| (.*)$/;
const FIELD = /^ {2}(시작|요약|MR|질문|메모|작업폴더): (.*)$/;
const KEY = { 시작: 'start', 요약: 'summary', MR: 'mr', 질문: 'questions', 메모: 'notes', 작업폴더: 'dir' };

function loadRuns() {
  let text;
  try {
    text = fs.readFileSync(path.join(ROOT, 'SUMMARY.log'), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const runs = [];
  text.split(/\r?\n/).forEach(line => {
    const h = HEAD.exec(line);
    if (h) {
      runs.push({ id: runs.length, time: h[1], start: '', status: h[2], mode: h[3], ticket: h[4], title: h[5], summary: '', mr: '', questions: [], notes: [], dir: '' });
      return;
    }
    const f = FIELD.exec(line);
    const cur = runs[runs.length - 1];
    if (!f || !cur) return;
    const key = KEY[f[1]];
    cur[key] = Array.isArray(cur[key]) ? f[2].split(' / ') : f[2];
  });
  return runs;
}

const isDone = s => s === 'pushed' || s === 'modified' || s === 'unchanged';
const listItem = r => ({ id: r.id, time: r.time, start: r.start, status: r.status, mode: r.mode, ticket: r.ticket, title: r.title, questionCount: r.questions.length });

// 작업폴더는 runs/ 안에 있을 때만 읽는다
function runFolder(dir) {
  if (!dir) return null;
  const abs = path.resolve(dir);
  if (!abs.startsWith(RUNS_DIR + path.sep) || !fs.existsSync(abs)) return null;
  return abs;
}

function readOptional(file) {
  return fs.existsSync(file) ? readTail(file, TAIL_BYTES) : null;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

// 봇이 작업폴더 screenshots/ 에 보관한 E2E 스크린샷. *_before / *_after 를 같은 장면으로 묶는다.
const SHOT_NAME = /^[\w.-]{1,120}\.(png|jpe?g)$/i;
function listShots(folder) {
  const dir = path.join(folder, 'screenshots');
  if (!fs.existsSync(dir)) return [];
  const pairs = new Map();
  fs.readdirSync(dir).filter(f => SHOT_NAME.test(f)).sort().forEach(f => {
    const m = /^(.*?)[_-](before|after)(?:[_-](.*))?\.\w+$/i.exec(f);
    const key = m ? m[1] + (m[3] ? `_${m[3]}` : '') : f.replace(/\.\w+$/, '');
    const side = m ? m[2].toLowerCase() : 'only';
    if (!pairs.has(key)) pairs.set(key, { name: key });
    pairs.get(key)[side] = f;
  });
  return [...pairs.values()];
}

// 진행 로그(state/progress.log)에서 지금 실행의 제목과 할일 진행(TodoWrite)을 읽는다
function readProgress() {
  let text;
  try { text = readTail(path.join(ROOT, 'state', 'progress.log'), 64 * 1024); } catch (e) { return null; }
  if (!text.text) return null;
  const lines = text.text.split(/\r?\n/);
  const out = { title: '', done: 0, total: 0, current: '', finished: false };
  lines.forEach(l => {
    const head = /^\[[\d:]+\] === (.+) \((?:WEB|BATCH|MOBILE) \/ \w+\) 시작$/.exec(l);
    if (head) Object.assign(out, { title: head[1], done: 0, total: 0, current: '', finished: false });
    const todo = /☑ 할일 (\d+)\/(\d+)(?: — 진행중: (.*))?$/.exec(l);
    if (todo && !/^\[[\d:]+\]\s+\[/.test(l)) Object.assign(out, { done: Number(todo[1]), total: Number(todo[2]), current: todo[3] || '' });
    if (l.includes('=== 종료')) out.finished = true;
  });
  return out.title ? out : null;
}

async function getStatus() {
  const task = await getTask();
  const lock = getLock();
  const runs = loadRuns();
  const warnings = [];
  if (lock.exists && !lock.alive) warnings.push('봇이 실행 도중 멈춘 흔적(lock 파일)이 남아 있어요. 다음 실행 때 봇이 스스로 정리해요.');
  if (!OK_RESULTS.includes(task.lastResult)) warnings.push(`마지막 실행이 비정상 종료됐어요. (${task.lastResultText})`);

  let state = 'idle';
  if (lock.alive) state = 'running';
  else if (!task.enabled) state = 'off';
  else if (warnings.length) state = 'attention';

  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const week = { done: 0, blocked: 0, failed: 0 };
  runs.filter(r => Date.parse(r.time) >= weekAgo).forEach(r => {
    if (isDone(r.status)) week.done++;
    else if (r.status === 'blocked') week.blocked++;
    else week.failed++;
  });

  // 티켓별 마지막 실행이 완료가 아니면 사람이 봐야 한다
  const latest = new Map();
  runs.forEach(r => latest.set(r.ticket, r));
  const attention = [...latest.values()].filter(r => !isDone(r.status)).sort((a, b) => b.id - a.id).map(listItem);

  let pending = 0;
  let worklist = [];
  try {
    const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'state.json'), 'utf8'));
    pending = (st.pending || []).length;
    // 작업 목록: 봇이 매 회차 시트(P=O, S=X)를 다시 확인하는 일감
    worklist = Object.entries(st.tickets || {}).map(([no, t]) => ({
      no, releaseId: t.releaseId || '', title: t.title || '', lastStatus: t.lastStatus || '', lastRunAt: t.lastRunAt || '',
      hold: t.hold ? t.hold.status : '', queued: (st.pending || []).includes(no),
    })).sort((a, b) => Number(b.no) - Number(a.no));
  } catch (e) {
    if (e.code !== 'ENOENT') warnings.push('state.json 을 읽지 못했어요.');
  }
  return { state, task, running: lock.alive ? { pid: lock.pid } : null, progress: lock.alive ? readProgress() : null, warnings, week, attention, pending, worklist, usage: usage.get() };
}

// ---------- HTTP ----------
function send(res, code, body, type) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
  });
  res.end(data);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > (limit || 1024)) { reject(new Error('요청이 너무 큽니다')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('JSON 형식이 아닙니다')); }
    });
    req.on('error', reject);
  });
}

function allowedWrite(req) {
  const origins = [].concat(...HOSTS.map(h => [`http://${h}`, `https://${h}`]));
  return origins.includes(req.headers.origin) && req.headers['x-admin-token'] === TOKEN;
}

async function control(action, script, env) {
  try {
    await ps(script, env);
    audit(action, 'ok');
  } catch (e) {
    audit(action, `실패: ${e.message}`);
    throw e;
  } finally {
    taskCache = null;
  }
}

function streamProgress(req, res) {
  const file = path.join(ROOT, 'state', 'progress.log');
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  let offset = 0;
  const push = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const tick = () => {
    let size;
    try { size = fs.statSync(file).size; } catch (e) { return; }
    if (size < offset) { offset = 0; push('reset', ''); } // 새 일감이 시작되면 봇이 파일을 비운다
    if (size === offset) return;
    const fd = fs.openSync(file, 'r');
    try {
      const start = Math.max(offset, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      offset = size;
      push('append', buf.toString('utf8'));
    } finally {
      fs.closeSync(fd);
    }
  };
  tick();
  const timer = setInterval(tick, 1000);
  req.on('close', () => clearInterval(timer));
}

const harness = createHarness({ ROOT, loadRuns, isDone });
const assistant = createAssistant({ loadRuns, isDone, harness });
const usage = createUsage({ RUNS_DIR });
const chat = createChat({ ROOT, botRunning: () => getLock().alive });

// Claude 호출은 파일을 바꾸지 않으므로 봇 실행 중에도 허용한다. 내용은 남기지 않고 호출 사실만 기록한다.
async function askClaude(action, fn) {
  try {
    const value = await fn();
    audit(action, 'ok');
    return value;
  } catch (e) {
    audit(action, `실패: ${e.message}`);
    throw e;
  }
}

// 실행 중에는 하네스를 바꾸지 않는다. 한 일감이 앞뒤 다른 규칙으로 처리되는 것을 막는다.
async function harnessWrite(action, fn) {
  if (getLock().alive) {
    const e = new Error('봇이 일감을 처리하는 중이에요. 끝난 뒤에 바꿔 주세요.');
    e.status = 409;
    throw e;
  }
  try {
    const value = await fn();
    audit(action, 'ok');
    return value;
  } catch (e) {
    audit(action, `실패: ${e.message}`);
    throw e;
  }
}

async function route(req, res) {
  const url = new URL(req.url, `http://${HOSTS[0]}`);
  const p = url.pathname;
  if (!HOSTS.includes(req.headers.host)) return send(res, 403, { error: '허용되지 않은 주소입니다' });

  if (req.method === 'GET' && STATIC[p]) {
    let body = fs.readFileSync(path.join(PUBLIC, STATIC[p][0]));
    if (p === '/') body = body.toString('utf8').replace('__TOKEN__', TOKEN);
    return send(res, 200, body, STATIC[p][1]);
  }
  if (req.method === 'GET' && p === '/api/status') return send(res, 200, await getStatus());
  if (req.method === 'GET' && p === '/api/progress') return streamProgress(req, res);
  if (req.method === 'GET' && p === '/api/runs') return send(res, 200, { runs: loadRuns().reverse().map(listItem) });
  if (req.method === 'GET' && p === '/api/schedule') {
    const t = await getTask();
    return send(res, 200, { intervalMinutes: t.intervalMinutes, options: Object.keys(INTERVALS).map(Number), taskName: t.name, timeLimitMinutes: t.timeLimitMinutes, botDir: ROOT });
  }
  if (req.method === 'GET' && p === '/api/harness') return send(res, 200, harness.overview(getLock().alive));
  const hf = /^\/api\/harness\/file\/([a-z-]{1,32})$/.exec(p);
  if (req.method === 'GET' && hf) return send(res, 200, harness.readFile(hf[1]));
  const m = /^\/api\/runs\/(\d{1,6})$/.exec(p);
  if (req.method === 'GET' && m) {
    const run = loadRuns()[Number(m[1])];
    if (!run) return send(res, 404, { error: '실행 기록을 찾지 못했어요' });
    const folder = runFolder(run.dir);
    const detail = Object.assign({}, run, { hasFolder: !!folder, request: null, log: null, result: null, changedFiles: null, shots: [] });
    delete detail.dir;
    if (folder) {
      detail.request = readOptional(path.join(folder, 'request.md'));
      detail.log = readOptional(path.join(folder, 'claude.log'));
      detail.result = readJson(path.join(folder, 'result.json'));
      detail.changedFiles = readJson(path.join(folder, 'changed-files.json'));
      detail.shots = listShots(folder);
    }
    return send(res, 200, detail);
  }
  const shot = /^\/api\/runs\/(\d{1,6})\/shots\/([^/]+)$/.exec(p);
  if (req.method === 'GET' && shot) {
    const run = loadRuns()[Number(shot[1])];
    const folder = run && runFolder(run.dir);
    const name = decodeURIComponent(shot[2]);
    if (!folder || !SHOT_NAME.test(name)) return send(res, 404, { error: '스크린샷을 찾지 못했어요' });
    const file = path.join(folder, 'screenshots', name);
    if (!fs.existsSync(file)) return send(res, 404, { error: '스크린샷을 찾지 못했어요' });
    return send(res, 200, fs.readFileSync(file), /\.png$/i.test(name) ? 'image/png' : 'image/jpeg');
  }

  if (req.method === 'POST' || req.method === 'PUT') {
    if (!allowedWrite(req)) return send(res, 403, { error: '페이지를 새로고침한 뒤 다시 눌러 주세요.' }); // 서버를 다시 켜면 토큰이 바뀐다
    if (req.method === 'POST' && p === '/api/bot/enable') {
      await control('켜기', TASK_OPEN + '$t.Enabled = $true');
      return send(res, 200, await getStatus());
    }
    if (req.method === 'POST' && p === '/api/bot/disable') {
      await control('끄기', TASK_OPEN + '$t.Enabled = $false');
      return send(res, 200, await getStatus());
    }
    if (req.method === 'POST' && p === '/api/bot/run') {
      if (getLock().alive) return send(res, 409, { error: '지금 일감을 처리하고 있어요. 끝난 뒤에 다시 눌러 주세요.' });
      if (!(await getTask(true)).enabled) return send(res, 409, { error: '봇이 꺼져 있어요. 먼저 켜 주세요.' });
      await control('지금 실행', TASK_OPEN + '[void]$t.Run($null)');
      return send(res, 200, await getStatus());
    }
    if (req.method === 'PUT' && hf) {
      const body = await readBody(req, harness.MAX_BYTES * 4);
      return send(res, 200, await harnessWrite(`하네스 저장 ${hf[1]}`, () => harness.saveFile(hf[1], body)));
    }
    // 오른쪽 대화창: 봇 폴더를 고칠 수 있는 Claude (봇 실행 중에는 읽기 전용). 응답은 이 요청에 NDJSON 으로 흘려보낸다 (내용은 기록하지 않는다)
    if (req.method === 'POST' && p === '/api/chat') {
      const body = await readBody(req, 16 * 1024);
      chat.ask(req, res, body);
      audit('Claude 대화', 'ok');
      return;
    }
    if (req.method === 'POST' && p === '/api/usage/refresh') {
      return send(res, 200, await askClaude('Claude 사용량 확인', () => usage.refresh()));
    }
    if (req.method === 'POST' && p === '/api/harness/ai/diagnose') {
      return send(res, 200, await askClaude('Claude 진단', () => assistant.diagnose()));
    }
    if (req.method === 'POST' && p === '/api/harness/ai/propose') {
      const body = await readBody(req, harness.MAX_BYTES * 4);
      return send(res, 200, await askClaude(`Claude 수정 제안 ${String(body.id).slice(0, 32)}`, () => assistant.propose(body.id, body.request, body.text)));
    }
    if (req.method === 'PUT' && p === '/api/harness/options') {
      const body = await readBody(req);
      return send(res, 200, await harnessWrite(`실행 옵션 변경 ${JSON.stringify(body).slice(0, 120)}`, () => harness.setOptions(body)));
    }
    if (req.method === 'POST' && p === '/api/harness/restore') {
      const body = await readBody(req);
      await harnessWrite(`하네스 되돌리기 ${String(body.backup).slice(0, 60)}`, () => harness.restore(body.backup));
      return send(res, 200, harness.overview(false));
    }
    if (req.method === 'PUT' && p === '/api/schedule') {
      const iso = INTERVALS[(await readBody(req)).intervalMinutes];
      if (!iso) return send(res, 400, { error: '간격은 10, 15, 30, 60분 중에서 골라 주세요.' });
      await control(`간격 변경 ${iso}`,
        TASK_OPEN + '$d = $t.Definition; $d.Triggers.Item(1).Repetition.Interval = $env:ADMIN_INTERVAL; [void]$folder.RegisterTaskDefinition($env:ADMIN_TASK_NAME, $d, 4, $null, $null, $d.Principal.LogonType)',
        { ADMIN_INTERVAL: iso });
      return send(res, 200, { intervalMinutes: (await getTask(true)).intervalMinutes });
    }
  }
  return send(res, 404, { error: '없는 주소입니다' });
}

function handler(req, res) {
  route(req, res).catch(e => {
    if (res.headersSent) { res.end(); return; }
    send(res, e.status || 500, { error: e.message });
  });
}

// 같은 포트에서 http 와 https 를 모두 받는다. Chat 알림의 링크는 https 로만 열려서 https 가 필요하다.
// 인증서: %USERPROFILE%\.pigon-chat\admin-tls\admin.crt / admin.key (이 PC 전용 자체 서명). 없으면 http 만 받는다.
const TLS_DIR = path.join(process.env.USERPROFILE || '', '.pigon-chat', 'admin-tls');
const httpServer = http.createServer(handler);
let httpsServer = null;
try {
  httpsServer = https.createServer({
    key: fs.readFileSync(path.join(TLS_DIR, 'admin.key')),
    cert: fs.readFileSync(path.join(TLS_DIR, 'admin.crt')),
  }, handler);
  httpsServer.on('tlsClientError', () => { /* 인증서를 믿지 않는 브라우저가 끊는 경우 등 */ });
} catch (e) {
  process.stdout.write(`https 인증서를 읽지 못해 http 만 받습니다: ${e.message}\n`);
}

net.createServer(sock => {
  sock.on('error', () => {});
  // 첫 바이트가 0x16(TLS 핸드셰이크)이면 https, 아니면 http 로 넘긴다
  sock.once('data', buf => {
    sock.pause();
    sock.unshift(buf);
    (buf[0] === 0x16 && httpsServer ? httpsServer : httpServer).emit('connection', sock);
    process.nextTick(() => sock.resume());
  });
}).listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`봇 관리 페이지: http(s)://127.0.0.1:${PORT}  (작업: ${TASK}, https ${httpsServer ? '사용' : '꺼짐'})\n`);
});
