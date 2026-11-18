// Claude 구독 사용량(5시간·7일 한도) 확인
// - 구독 사용량은 공개 API가 없어서, Claude Code 가 stream-json 으로 내보내는 rate_limit_event 를 읽는다.
// - 출처 두 가지 중 최신 값을 쓴다.
//   1) 봇 실행 기록: runs/*/claude.stream.jsonl 의 마지막 rate_limit_event (추가 비용 없음)
//   2) 지금 확인: Haiku 로 아주 짧게 한 번 호출해서 받는다 (사용량이 아주 조금 든다)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// 인자는 모두 상수다
const COMMAND = 'claude -p --model haiku --tools "" --disable-slash-commands --strict-mcp-config --no-session-persistence --setting-sources "" --max-turns 1 --output-format stream-json --verbose';
const PROMPT = 'ok 라고만 답해';
const TIMEOUT_MS = 90 * 1000;
const MIN_GAP_MS = 60 * 1000; // 버튼을 연달아 눌러도 1분에 한 번만 호출한다
const TAIL_BYTES = 256 * 1024;

function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const toIso = sec => (Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : null);
const pct = u => (Number.isFinite(u) ? Math.round(u * 1000) / 10 : null); // 0~1 → 0~100 (소수 1자리)

function windowOf(w) {
  if (!w || !Number.isFinite(w.utilization)) return null;
  return { usedPercent: pct(w.utilization), resetsAt: toIso(w.resetsAt), status: w.status || null };
}

// rate_limit_info → 화면용. unifiedWindows 가 없으면 rateLimitType 한 칸만 채운다.
function parseInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const uw = info.unifiedWindows || {};
  const out = { fiveHour: windowOf(uw.five_hour), sevenDay: windowOf(uw.seven_day), status: info.status || null };
  if (!out.fiveHour && info.rateLimitType === 'five_hour') out.fiveHour = windowOf(info);
  if (!out.sevenDay && info.rateLimitType === 'seven_day') out.sevenDay = windowOf(info);
  if (!out.fiveHour && !out.sevenDay) return null;
  return out;
}

function lastEventIn(text) {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].indexOf('"rate_limit_event"') < 0) continue;
    try {
      const ev = JSON.parse(lines[i]);
      const parsed = ev.type === 'rate_limit_event' && parseInfo(ev.rate_limit_info);
      if (parsed) return parsed;
    } catch (e) { /* 잘린 줄 */ }
  }
  return null;
}

function readTail(file) {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = function createUsage({ RUNS_DIR }) {
  let probe = null;   // 마지막 "지금 확인" 결과
  let fromBot = null; // 봇 실행 기록에서 읽은 결과 (파일 수정 시각이 바뀔 때만 다시 읽는다)
  let botKey = '';
  let busy = false;
  let lastProbeAt = 0;

  function latestBotEvent() {
    let newest = null;
    try {
      fs.readdirSync(RUNS_DIR).forEach(name => {
        const file = path.join(RUNS_DIR, name, 'claude.stream.jsonl');
        let st;
        try { st = fs.statSync(file); } catch (e) { return; }
        if (!newest || st.mtimeMs > newest.mtimeMs) newest = { file, mtimeMs: st.mtimeMs };
      });
    } catch (e) {
      return null;
    }
    if (!newest) return null;
    const key = `${newest.file}|${newest.mtimeMs}`;
    if (key !== botKey) {
      botKey = key;
      const parsed = lastEventIn(readTail(newest.file));
      // 이벤트가 없는 실행(드라이런 등)이면 이전 값을 유지한다
      if (parsed) fromBot = Object.assign(parsed, { checkedAt: new Date(newest.mtimeMs).toISOString(), source: 'bot' });
    }
    return fromBot;
  }

  function get() {
    const bot = latestBotEvent();
    const best = [probe, bot].filter(Boolean).sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt))[0] || null;
    return { snapshot: best, checking: busy };
  }

  function runProbe() {
    return new Promise((resolve, reject) => {
      const cwd = path.join(os.tmpdir(), 'pigon-admin-claude'); // 프로젝트 지침(CLAUDE.md)이 섞이지 않게 빈 폴더에서 실행
      fs.mkdirSync(cwd, { recursive: true });
      const env = Object.assign({}, process.env);
      ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'].forEach(k => delete env[k]);
      // 봇(poll.js)과 같은 계정으로 본다: 무인 실행용 장기 토큰이 있으면 쓴다
      const tokenFile = path.join(process.env.USERPROFILE || '', '.pigon-chat', 'claude_token.txt');
      if (fs.existsSync(tokenFile)) env.CLAUDE_CODE_OAUTH_TOKEN = fs.readFileSync(tokenFile, 'utf8').trim();

      const child = spawn(COMMAND, { cwd, env, shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        reject(fail(504, 'Claude 응답이 너무 오래 걸려서 멈췄어요. 다시 시도해 주세요.'));
      }, TIMEOUT_MS);
      child.stdout.on('data', c => { out += c; });
      child.stderr.on('data', c => { err += c; });
      child.on('error', e => { clearTimeout(timer); reject(fail(502, `Claude 를 실행하지 못했어요. ${e.message}`)); });
      child.on('close', () => {
        clearTimeout(timer);
        const parsed = lastEventIn(out);
        if (parsed) return resolve(parsed);
        const first = (err || out).trim().split(/\r?\n/)[0] || '빈 응답';
        reject(fail(502, `사용량 정보를 받지 못했어요. ${first.slice(0, 160)}`));
      });
      child.stdin.end(PROMPT);
    });
  }

  async function refresh() {
    if (busy) throw fail(409, '이미 확인하고 있어요. 잠시만 기다려 주세요.');
    if (probe && Date.now() - lastProbeAt < MIN_GAP_MS) return get();
    busy = true;
    try {
      const parsed = await runProbe();
      probe = Object.assign(parsed, { checkedAt: new Date().toISOString(), source: 'probe' });
      lastProbeAt = Date.now();
    } finally {
      busy = false;
    }
    return get();
  }

  return { get, refresh };
};
