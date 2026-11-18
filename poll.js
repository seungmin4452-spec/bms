// Google Chat 일감 알림 폴링 → 작업 목록 → 시트/문서 조회 → 신규/보완 분기 → claude -p 실행
// 흐름:
//   1) Chat 알림(요청단계: 개발 요청)의 번호를 작업 목록(state.tickets)에 넣는다.
//   2) 매 회차 작업 목록 전체를 시트에서 다시 본다. 내 일감 중 P열 알림=O, S열 알림=X 인 것만 처리한다.
//      이미 완료한 일감도 이 상태면 추가 수정사항이 있는 것 → 3. 테스트 칸의 새 블록을 반영한다.
//   3) 신규: 1. 요청사항 + 링크된 파일 / 보완: 3. 테스트 새 블록 + 링크된 파일 → /ticket-auto (E2E·스크린샷까지)
//   4) 모호하면(blocked) Chat 으로 확인 요청, 오류는 Chat 알림. 결과는 관리 웹(127.0.0.1:20020)에서 본다.
//   5) 처리할 일감이 모두 끝나면 Chat 으로 완료 알림.
// 사용법:
//   node poll.js                 1회 폴링 (작업 스케줄러에서 주기 실행)
//   node poll.js --since <ISO>   지정 시각 이후 메시지부터 (테스트용, 상태의 since 무시)
//   node poll.js --no <No>       Chat 없이 특정 일감 1건만 처리 (테스트용)
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const { accessToken, getJson, loadTicket, loadSheetRows, loadDoc } = require('./ticket');
const { sendResultMail } = require('./mail');
const { alert, info } = require('./notify');

const ROOT = __dirname;
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_DIR = path.join(ROOT, 'state');
const STATE_PATH = path.join(STATE_DIR, 'state.json');
const LOCK_PATH = path.join(STATE_DIR, 'poll.lock');
const LOG_DIR = path.join(ROOT, 'logs');
const RUN_DIR = path.join(ROOT, 'runs');
const LOCK_STALE_MS = 8 * 60 * 60 * 1000; // PID 가 살아 있어도 이 시간이 지나면 멈춘 것으로 본다
const PROGRESS_PATH = path.join(STATE_DIR, 'progress.log'); // 지금 실행 중인 일감의 진행 로그 (watch.ps1 로 확인)
let claudeRan = false; // 폴링 1회당 Claude 실행은 1건만 (나머지는 다음 회차로)
const MAX_ATTEMPTS = 2;
const WAS_PORT = 20010; // was.ps1 $HttpPort
const TOMCAT_PID_PATH = path.join(ROOT, 'tomcat-base', 'tomcat.pid');
const ADMIN_URL = 'https://127.0.0.1:20020';
const SCREENSHOT_ROOT = path.join(CONFIG.projectDir, 'e2e-local', 'screenshots'); // ticket.md: screenshots/{브랜치명}/
let staleLock = null; // 이전 폴링이 lock 을 남기고 끝남(강제 종료 등) → 알림용

[STATE_DIR, LOG_DIR, RUN_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  process.stdout.write(line + '\n');
  fs.appendFileSync(path.join(LOG_DIR, `poll-${stamp().slice(0, 8)}.log`), line + '\n');
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return null;
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
}

function saveState(state) {
  state.seenMessages = state.seenMessages.slice(-1000);
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// lock 에 적힌 PID 의 node.exe 가 살아 있으면 실행 중으로 본다 (시간 기준이면 긴 작업 중에 lock 이 풀려 중복 실행됨)
function lockOwnerAlive(pid) {
  if (!/^\d+$/.test(pid)) return false;
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    return /"node\.exe"/i.test(out);
  } catch (e) {
    return true; // 확인 불가 시 안전하게 실행 중으로 본다
  }
}

function acquireLock() {
  if (fs.existsSync(LOCK_PATH)) {
    const pid = fs.readFileSync(LOCK_PATH, 'utf8').trim();
    const age = Date.now() - fs.statSync(LOCK_PATH).mtimeMs;
    const alive = lockOwnerAlive(pid);
    if (alive && age < LOCK_STALE_MS) {
      log(`다른 폴링 실행 중(PID ${pid}, ${Math.round(age / 60000)}분째) → 종료`);
      return false;
    }
    log(`남은 lock 제거 (PID ${pid} 종료됨 또는 ${Math.round(age / 60000)}분 경과)`);
    staleLock = { pid, ageMin: Math.round(age / 60000), alive };
  }
  fs.writeFileSync(LOCK_PATH, String(process.pid));
  return true;
}

// 정상 종료 시 lock 은 finally 에서 지워진다. lock 이 남아 있었다면 이전 폴링이 강제 종료된 것 → 무엇을 하던 중이었는지 알린다
async function alertStaleLock() {
  let lines = [];
  try { lines = fs.readFileSync(PROGRESS_PATH, 'utf8').split(/\r?\n/).filter(Boolean); } catch (e) { /* 없음 */ }
  const started = lines.find(l => /===.*시작$/.test(l));
  const finished = lines.some(l => l.includes('=== 종료'));
  const midRun = started && !finished;
  const how = staleLock.alive ? '프로세스가 8시간 넘게 살아 있어 무시하고 진행' : '프로세스 없음(강제 종료·재부팅 추정)';
  await alert(null, {
    title: '이전 폴링이 정상 종료되지 않음',
    subtitle: `PID ${staleLock.pid} · ${staleLock.ageMin}분 전 시작`,
    fields: [
      ['원인', how],
      ['실행 중이던 일감', midRun ? started.replace(/^\[[^\]]*\]\s*===\s*/, '') : 'Claude 실행 중은 아니었음'],
      ['마지막 진행', midRun ? lines[lines.length - 1].slice(0, 150) : ''],
    ],
    note: midRun ? 'result.json 이 없어서 다음 폴링에서 다시 처리될 수 있어요.' : '',
    link: midRun,
  }, log);
}

// ---------- WEB 실행 전 환경 점검 ----------
// Claude 를 띄우기 전에 사람 작업과 겹치는지 본다. 겹치면 실행하지 않고 대기(시도 횟수에 안 셈).
// (ticket-auto A-1 에서도 점검하지만, 거기까지 가면 Claude 세션 비용이 들고 실패로 기록된다)
function portOwner(port) {
  const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
  const re = new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+:0\\s+\\S+\\s+(\\d+)\\s*$`);
  for (const l of out.split(/\r?\n/)) { const m = l.match(re); if (m) return m[1]; }
  return null;
}

function webEnvProblem() {
  const git = (...a) => execFileSync('git', a, { cwd: CONFIG.projectDir, encoding: 'utf8', windowsHide: true }).trim();
  const branch = () => git('branch', '--show-current') || 'detached';
  const gitDir = path.resolve(CONFIG.projectDir, git('rev-parse', '--git-dir'));
  const ops = { MERGE_HEAD: 'merge', 'rebase-merge': 'rebase', 'rebase-apply': 'rebase', CHERRY_PICK_HEAD: 'cherry-pick', REVERT_HEAD: 'revert' };
  for (const [f, name] of Object.entries(ops)) {
    if (fs.existsSync(path.join(gitDir, f))) return { kind: 'git-op', msg: `git ${name} 진행 중 (브랜치 ${branch()})` };
  }
  const dirty = git('status', '--porcelain', '--untracked-files=no').split(/\r?\n/).filter(Boolean);
  if (dirty.length) {
    const files = dirty.slice(0, 3).map(l => l.slice(3)).join(', ') + (dirty.length > 3 ? ' 외' : '');
    return { kind: 'dirty', msg: `미커밋 변경 ${dirty.length}건 (브랜치 ${branch()}: ${files})` };
  }
  const owner = portOwner(WAS_PORT);
  let botPid = '';
  try { botPid = fs.readFileSync(TOMCAT_PID_PATH, 'utf8').trim(); } catch (e) { /* 봇 Tomcat 미기동 */ }
  if (owner && owner !== botPid) return { kind: 'port', msg: `포트 ${WAS_PORT} 를 봇이 아닌 프로세스(PID ${owner}, IntelliJ Tomcat 등)가 사용 중` };
  return null;
}

// ---------- Chat ----------
async function listNewMessages(token, since) {
  const out = [];
  let pageToken = '';
  do {
    const q = new URLSearchParams({ pageSize: '100', orderBy: 'createTime asc', filter: `createTime > "${since}"` });
    if (pageToken) q.set('pageToken', pageToken);
    const data = await getJson(`https://chat.googleapis.com/v1/spaces/${CONFIG.spaceId}/messages?${q}`, token);
    out.push(...(data.messages || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return out;
}

function parseNotice(text) {
  const stage = ((text || '').match(/요청단계:\s*([^\n]+)/) || [])[1];
  const no = ((text || '').match(/번호:\s*(\d+)/) || [])[1];
  return { stage: stage && stage.trim(), no };
}

async function replyInThread(token, threadName, text) {
  const url = `https://chat.googleapis.com/v1/spaces/${CONFIG.spaceId}/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, thread: { name: threadName } }),
  });
  if (!res.ok) log(`Chat 답글 실패 HTTP ${res.status}`);
}

// ---------- Git ----------
// origin 기준: 봇이 blocked/failed 로 남긴 로컬 전용 브랜치는 "아직 신규 작업 전"으로 본다
function branchExists(branch) {
  const out = execFileSync('git', ['ls-remote', '--heads', 'origin', branch], { cwd: CONFIG.projectDir, encoding: 'utf8' });
  return out.trim().length > 0;
}

// ---------- SVN (BATCH 일감: PIGON_GRP_AGENT_REPL / CONT / API, 모바일: PigOn) ----------
// 작업본에는 개발자의 미커밋 변경이 섞여 있을 수 있다. 실행 전후 svn status + 파일 해시를 비교해
// 이번 일감에서 새로 바뀐 파일만 골라낸다. (실행 전부터 수정돼 있던 파일도 내용이 또 바뀌면 포함)
function svnSnapshot(dirs) {
  const snap = {};
  dirs.forEach(d => {
    const out = execFileSync('svn', ['status'], { cwd: d, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
    out.split(/\r?\n/).filter(Boolean).forEach(l => {
      const rel = l.slice(8).trim();
      const abs = path.join(d, rel);
      let hash = 'DIR';
      try {
        if (fs.statSync(abs).isFile()) hash = require('crypto').createHash('sha1').update(fs.readFileSync(abs)).digest('hex');
      } catch (e) { hash = 'MISSING'; }
      snap[`${path.basename(d)}/${rel.replace(/\\/g, '/')}`] = { code: l.slice(0, 7).trim(), hash };
    });
  });
  return snap;
}

function changedSince(before, after) {
  const label = { M: '수정', A: '추가', D: '삭제', '?': '신규(svn 미등록)', '!': '삭제됨(svn 미반영)' };
  return Object.keys(after)
    .filter(k => !before[k] || before[k].hash !== after[k].hash || before[k].code !== after[k].code)
    .map(k => ({ file: k, status: label[after[k].code[0]] || after[k].code, preModified: !!before[k] && before[k].code !== '?' }));
}

// ---------- 서브에이전트 ----------
// BATCH·모바일용 서브에이전트 정의는 봇 저장소 agents/<kind>/*.md 에 둔다(git 으로 관리).
// Claude 는 실행 폴더(cwd)의 .claude/agents/ 만 읽으므로, 실행 직전에 그곳으로 복사한다. (svnSnapshot 보다 먼저 호출해 변경 파일에 섞이지 않게)
// 같은 이름 파일만 덮어쓰고, 개발자가 따로 둔 에이전트 파일은 건드리지 않는다.
function syncAgents(kind, cwd) {
  const src = path.join(ROOT, 'agents', kind);
  if (!fs.existsSync(src)) return [];
  const dest = path.join(cwd, '.claude', 'agents');
  fs.mkdirSync(dest, { recursive: true });
  return fs.readdirSync(src).filter(f => f.endsWith('.md')).map(f => {
    const body = fs.readFileSync(path.join(src, f));
    const to = path.join(dest, f);
    if (!fs.existsSync(to) || !fs.readFileSync(to).equals(body)) fs.writeFileSync(to, body);
    return f.slice(0, -3);
  });
}

// ---------- 분기 판단 ----------
function decide(ticket, tState, isBatch) {
  const doc = ticket.doc;
  const started = isBatch ? false : branchExists(ticket.releaseId);
  if (!started && !tState.requestDone) {
    // 신규는 1. 요청사항만 본다. 이전 실행이 확인 요청(blocked)으로 끝났다면 그 뒤 3. 테스트 칸에 적힌 블록을 답변으로 함께 넘긴다
    const answers = tState.asked ? doc.testBlocks.filter(b => !tState.processedHashes.includes(b.hash)) : [];
    return { mode: 'new', blocks: answers, images: [...doc.requestImages, ...[].concat(...answers.map(b => b.images))] };
  }
  let fresh = doc.testBlocks.filter(b => !tState.processedHashes.includes(b.hash));
  // 봇 도입 전부터 진행된 일감: 기록이 없으면 마지막 블록만 새 요청으로 본다.
  // 그 앞 블록은 이미 사람이 처리한 이력이므로 처리됨으로 기록한다 (blocked 뒤 재실행 때 다시 끼어들지 않게)
  if (!tState.known) {
    fresh.slice(0, -1).forEach(b => tState.processedHashes.push(b.hash));
    fresh = fresh.slice(-1);
  }
  if (fresh.length === 0) return { mode: 'skip' };
  return { mode: 'feedback', blocks: fresh, images: [].concat(...fresh.map(b => b.images)) };
}

// 확인 요청·재시도 중단 뒤에는 문서가 바뀔 때까지 다시 돌리지 않는다 (매 회차 작업 목록을 다시 보므로 같은 질문 반복 방지)
function docHash(doc) {
  return crypto.createHash('sha1')
    .update(JSON.stringify([doc.request, doc.requestImages, doc.testBlocks.map(b => b.hash)]))
    .digest('hex').slice(0, 12);
}

// ---------- 작업 폴더 ----------
async function downloadImages(ids, urls, dir, token) {
  const files = [];
  for (let i = 0; i < ids.length; i++) {
    const url = urls[ids[i]];
    if (!url) continue;
    let res = await fetch(url);
    if (!res.ok) res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) { log(`이미지 다운로드 실패 ${ids[i]} HTTP ${res.status}`); continue; }
    const type = res.headers.get('content-type') || '';
    const ext = type.includes('jpeg') ? 'jpg' : type.includes('gif') ? 'gif' : 'png';
    const file = path.join(dir, `image-${i + 1}.${ext}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    files.push(file);
  }
  return files;
}

// 요청 본문에 링크된 파일(쿼리·로직 설명 txt/md/sql 등)을 작업 폴더로 내려받는다. 실패해도 결과에 남겨 Claude 가 판단하게 한다.
// - Drive 파일(drive.google.com/file/d/, open?id=): 원본 그대로
// - Google 문서/시트/슬라이드 링크나 Drive 의 Google 형식 파일: 텍스트(txt)·CSV 로 내보내기
const LINK_PATTERNS = [
  /drive\.google\.com\/file\/d\/([\w-]{10,})/g,
  /drive\.google\.com\/open\?id=([\w-]{10,})/g,
  /docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/([\w-]{10,})/g,
];
const GOOGLE_EXPORT = {
  'application/vnd.google-apps.document': ['text/plain', '.txt'],
  'application/vnd.google-apps.spreadsheet': ['text/csv', '.csv'], // 첫 시트만 내보내진다
  'application/vnd.google-apps.presentation': ['text/plain', '.txt'],
};

async function downloadLinkedFiles(texts, dir, token) {
  const ids = [...new Set([].concat(...texts.map(t => [].concat(...LINK_PATTERNS.map(re => [...(t || '').matchAll(re)].map(m => m[1]))))))];
  const out = [];
  for (const id of ids) {
    const url = `https://drive.google.com/file/d/${id}/view`;
    try {
      const meta = await getJson(`https://www.googleapis.com/drive/v3/files/${id}?fields=name,mimeType&supportsAllDrives=true`, token);
      const exp = GOOGLE_EXPORT[meta.mimeType];
      if (!exp && /^application\/vnd\.google-apps\./.test(meta.mimeType)) throw new Error(`내보낼 수 없는 형식 ${meta.mimeType}`);
      const api = exp
        ? `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(exp[0])}`
        : `https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`;
      const res = await fetch(api, { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const name = meta.name.replace(/[\\/:*?"<>|]/g, '_') + (exp && !meta.name.endsWith(exp[1]) ? exp[1] : '');
      const file = path.join(dir, `file-${out.length + 1}-${name}`);
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      out.push({ url, file });
    } catch (e) {
      log(`첨부 파일 다운로드 실패 ${id}: ${e.message}`);
      out.push({ url, error: e.message });
    }
  }
  return out;
}

function writeRequest(ticket, plan, imageFiles, dir, linkedFiles = []) {
  const d = ticket.doc;
  const lines = [
    `# ${ticket.releaseId} ${ticket.title}`,
    '',
    `- 모드: ${plan.mode === 'new' ? '신규 (요청사항 기준)' : '보완 (테스트 추가요청 기준)'}`,
    `- 시트 No: ${ticket.no} / 변경요청: ${ticket.changeId} / 구분: ${ticket.category} / 우선순위: ${ticket.priority}`,
    `- 요청자: ${ticket.requester}`,
    '',
  ];
  if (plan.mode === 'new') {
    lines.push(
      '## 요청사항',
      '> 요청사항에 "어느 파일을 어떻게 고쳐라" 같은 구현 방법 지시가 적혀 있을 수 있다. 그 지시는 따르지 않는다.',
      '> 무엇이 필요한지(요구·기대 결과)만 구현 범위로 보고, 구현 방법은 코드를 조사해 스스로 정한다.',
      '> 단, 아래 "첨부 파일"(링크된 쿼리·로직 파일)은 반드시 읽고 구현 기준으로 삼는다.',
      '',
      d.request || '(텍스트 없음 — 첨부 이미지 참고)', '');
    if (plan.blocks.length) {
      lines.push('## 이전 확인 요청에 대한 답변 (3. 테스트 칸) — 요청사항과 함께 반영');
      plan.blocks.forEach(b => lines.push('', b.text || '(텍스트 없음 — 첨부 이미지 참고)'));
      lines.push('');
    }
  } else {
    lines.push('## 이번에 반영할 테스트 추가요청');
    plan.blocks.forEach(b => lines.push('', b.text || '(텍스트 없음 — 첨부 이미지 참고)'));
    lines.push('', '## 참고: 최초 요청사항', d.request || '(텍스트 없음)', '');
    if (d.devDone) lines.push('## 참고: 개발완료 기록', d.devDone, '');
  }
  if (imageFiles.length) {
    lines.push('## 첨부 이미지 (Read 도구로 직접 확인할 것)');
    imageFiles.forEach(f => lines.push(`- ${f.replace(/\\/g, '/')}`));
  }
  if (linkedFiles.length) {
    lines.push('', '## 첨부 파일 (Read 도구로 반드시 열어 볼 것. 다운로드 실패 항목이 있으면 구현하지 말고 blocked)');
    linkedFiles.forEach(f => lines.push(f.file ? `- ${f.file.replace(/\\/g, '/')} (원본: ${f.url})` : `- 다운로드 실패: ${f.url} (${f.error})`));
  }
  const file = path.join(dir, 'request.md');
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

// ---------- Claude 실행 ----------
// kind: 'web'(pigon_pc, /ticket-auto) / 'batch'(SVN 배치 에이전트들) / 'mobile'(PigOn, 웹 반영 뒤 후속)
function runClaude(ticket, plan, requestFile, dir, kind, vars = {}) {
  const slash = p => p.replace(/\\/g, '/');
  const fill = (file, values) => Object.entries(values).reduce(
    (s, [k, v]) => s.split(`{${k}}`).join(v),
    fs.readFileSync(path.join(ROOT, file), 'utf8'));
  const common = { releaseId: ticket.releaseId, mode: plan.mode, requestFile: slash(requestFile), resultFile: slash(path.join(dir, 'result.json')) };
  let prompt, cwd = CONFIG.projectDir, args = CONFIG.claude.args;
  if (kind === 'batch') {
    const dirs = CONFIG.batch.projectDirs;
    prompt = fill(CONFIG.batch.promptFile, Object.assign(common, {
      projectList: dirs.map(d => `  - ${path.basename(d)}: ${d}`).join('\n'),
    }));
    cwd = dirs[0];
    args = args.concat(...dirs.slice(1).map(d => ['--add-dir', d]));
  } else if (kind === 'mobile') {
    // pigon_pc 는 add-dir 하지 않는다 (읽기는 Read 허용으로 충분, 편집은 막힘)
    prompt = fill(CONFIG.mobile.promptFile, Object.assign(common, { projectDir: CONFIG.mobile.projectDir }, vars));
    cwd = CONFIG.mobile.projectDir;
  } else {
    prompt = CONFIG.claude.promptTemplate
      .replace('{releaseId}', ticket.releaseId)
      .replace('{mode}', plan.mode)
      .replace('{requestFile}', slash(requestFile));
  }
  fs.writeFileSync(path.join(dir, 'prompt.txt'), prompt);
  if (CONFIG.dryRun) {
    log(`[dry-run] claude 실행 생략: ${prompt}`);
    return Promise.resolve({ code: 0, dry: true });
  }
  claudeRan = true;
  // 진행 상황을 보려고 stream-json 으로 받아 사람이 읽는 줄로 바꿔 claude.log 와 state/progress.log 에 쓴다.
  // 원본 이벤트는 claude.stream.jsonl 에 그대로 남긴다.
  args = args.concat(['--output-format', 'stream-json', '--verbose']);
  // 무인 실행은 승인 창이 없어 규칙 밖 셸 명령이 전부 거부되고 턴만 낭비된다 → 셸 규칙을 시스템 프롬프트에 덧붙인다
  const shellRules = path.join(ROOT, 'bot-shell-rules.md');
  if (fs.existsSync(shellRules)) args = args.concat(['--append-system-prompt-file', slash(shellRules)]);
  const raw = fs.openSync(path.join(dir, 'claude.stream.jsonl'), 'a');
  const human = fs.openSync(path.join(dir, 'claude.log'), 'a');
  fs.writeFileSync(PROGRESS_PATH, '');
  const progress = fs.openSync(PROGRESS_PATH, 'a');
  const emit = line => {
    const t = new Date().toTimeString().slice(0, 8);
    const s = `[${t}] ${line}\n`;
    fs.writeSync(human, s);
    fs.writeSync(progress, s);
  };
  emit(`=== ${ticket.releaseId} ${ticket.title} (${kind.toUpperCase()} / ${plan.mode}) 시작`);
  emit(`작업폴더: ${dir}`);

  return new Promise(resolve => {
    // .cmd 는 shell 경유가 필요하고, 프롬프트는 인자 이스케이프 문제를 피하려고 stdin 으로 넘긴다
    // 무인 실행용 장기 토큰(claude setup-token)이 있으면 사용. 없으면 대화형 로그인 세션에 의존(수일 내 만료)
    const env = Object.assign({}, process.env);
    const tokenFile = path.join(process.env.USERPROFILE, '.pigon-chat', 'claude_token.txt');
    if (fs.existsSync(tokenFile)) env.CLAUDE_CODE_OAUTH_TOKEN = fs.readFileSync(tokenFile, 'utf8').trim();
    const child = spawn(CONFIG.claude.cmd, args, {
      cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: true, windowsHide: true, env,
    });
    child.stdin.end(prompt);

    const agents = {}; // Agent 도구 호출 id → 서브에이전트 이름 (서브에이전트 내부 동작 앞에 붙임)
    let buf = '';
    let exitGuard = null;
    child.stdout.on('data', chunk => {
      fs.writeSync(raw, chunk);
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev = null;
        try { ev = JSON.parse(line); } catch (e) { emit(line.slice(0, 300)); continue; }
        describeEvent(ev, agents).forEach(emit);
        // 백그라운드 작업(WAS 재시작 등)을 기다리느라 턴을 끝내면 중간 result 가 나오고, 작업이 끝나면 세션이 이어진다.
        // result 뒤에 다른 이벤트가 오면 아직 일하는 중이므로 강제 종료 예약을 취소한다.
        if (ev.type !== 'result' && exitGuard) { clearTimeout(exitGuard); exitGuard = null; }
        // 결과를 낸 뒤에도 종료되지 않는 경우가 있다(E2E 로 띄운 Tomcat 이 핸들을 잡고 있을 때). 2분 기다린 뒤 강제 종료.
        // 단 봇이 result.json 을 남긴 경우(=작업 마무리)에만. 없으면 중간 result 이므로 전체 시간 제한에 맡긴다.
        if (ev.type === 'result' && !exitGuard && fs.existsSync(path.join(dir, 'result.json'))) {
          exitGuard = setTimeout(() => {
            emit('결과 출력 후 2분 동안 종료되지 않아 강제 종료');
            try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch (e) { /* 이미 종료 */ }
          }, 2 * 60000);
        }
      }
    });
    child.stderr.on('data', chunk => String(chunk).split(/\r?\n/).filter(Boolean).forEach(l => emit(`[stderr] ${l}`)));

    const timer = setTimeout(() => {
      log('claude 시간 초과 → 종료');
      emit('시간 초과 → 강제 종료');
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch (e) { /* 이미 종료 */ }
    }, CONFIG.claude.timeoutMinutes * 60000);
    const finish = r => {
      clearTimeout(timer);
      clearTimeout(exitGuard);
      emit(`=== 종료 (코드 ${r.code})`);
      [raw, human, progress].forEach(fd => { try { fs.closeSync(fd); } catch (e) { /* 이미 닫힘 */ } });
      resolve(r);
    };
    child.on('close', code => finish({ code, result: readResult(dir) }));
    child.on('error', e => { log('claude 실행 오류: ' + e.message); finish({ code: -1 }); });
  });
}

// stream-json 이벤트 1건 → 사람이 읽는 줄 목록
function describeEvent(ev, agents) {
  const cut = (s, n = 160) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
  const rel = p => cut(String(p || '').replace(/\\/g, '/').replace(/^.*?\/IdeaProjects\//, ''), 140);
  const who = ev.parent_tool_use_id ? `  [${agents[ev.parent_tool_use_id] || '서브'}] ` : '';
  const out = [];
  if (ev.type === 'system' && ev.subtype === 'init') out.push(`세션 시작 (모델 ${ev.model || '?'})`);
  if (ev.type === 'assistant' && ev.message) {
    (ev.message.content || []).forEach(c => {
      if (c.type === 'text' && c.text.trim()) out.push(`${who}💬 ${cut(c.text, 300)}`);
      if (c.type !== 'tool_use') return;
      const x = c.input || {};
      let d;
      switch (c.name) {
        case 'Agent': case 'Task':
          agents[c.id] = x.subagent_type || 'agent';
          d = `🤖 서브에이전트 호출: ${x.subagent_type || 'general'} — ${cut(x.description || x.prompt, 120)}`; break;
        case 'Skill': d = `📘 스킬: ${x.skill} ${cut(x.args, 100)}`; break;
        case 'Read': d = `📖 읽기: ${rel(x.file_path)}`; break;
        case 'Edit': case 'MultiEdit': d = `✏️ 수정: ${rel(x.file_path)}`; break;
        case 'Write': d = `📝 작성: ${rel(x.file_path)}`; break;
        case 'Grep': d = `🔎 검색: "${cut(x.pattern, 60)}" ${x.path ? 'in ' + rel(x.path) : ''}`; break;
        case 'Glob': d = `🔎 파일찾기: ${cut(x.pattern, 80)}`; break;
        case 'Bash': case 'PowerShell': d = `▶ 명령: ${cut(x.command, 200)}`; break;
        case 'TodoWrite': {
          const todos = x.todos || [];
          const cur = todos.find(t => t.status === 'in_progress');
          d = `☑ 할일 ${todos.filter(t => t.status === 'completed').length}/${todos.length}${cur ? ' — 진행중: ' + cut(cur.content || cur.activeForm, 80) : ''}`; break;
        }
        default: d = `🔧 ${c.name} ${cut(JSON.stringify(x), 120)}`;
      }
      out.push(who + d);
    });
  }
  if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
    ev.message.content.forEach(c => {
      if (c.type === 'tool_result' && c.is_error) {
        const txt = Array.isArray(c.content) ? c.content.map(p => p.text || '').join(' ') : c.content;
        out.push(`${who}⚠ 도구 오류/거부: ${cut(txt, 200)}`);
      }
    });
  }
  if (ev.type === 'result') {
    const min = ev.duration_ms ? Math.round(ev.duration_ms / 60000) : '?';
    out.push(`완료: ${ev.subtype || ''} · ${min}분 · 턴 ${ev.num_turns || '?'}${ev.total_cost_usd != null ? ' · $' + ev.total_cost_usd.toFixed(2) : ''}`);
    if (ev.result) out.push(`최종 답변: ${cut(ev.result, 500)}`);
  }
  return out;
}

// 티켓 브랜치 최신 커밋 (push 직후라 origin/<브랜치> 가 맞다. 없으면 로컬 브랜치)
function branchHead(branch) {
  for (const ref of [`origin/${branch}`, branch]) {
    try {
      return execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: CONFIG.projectDir, encoding: 'utf8', windowsHide: true }).trim();
    } catch (e) { /* 다음 후보 */ }
  }
  return '';
}

function readResult(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeSummary(ticket, plan, result, dir, startedAt) {
  const r = result || {};
  const lines = [
    `${new Date().toISOString()} | ${r.status || 'no-result'} | ${plan.mode} | ${ticket.releaseId} | ${ticket.title}`,
    startedAt ? `  시작: ${new Date(startedAt).toISOString()}` : '',
    `  요약: ${r.summary || '(result.json 없음 — claude.log 확인)'}`,
    r.mrLink ? `  MR: ${r.mrLink}` : '',
    r.headCommit ? `  커밋: ${r.headCommit}` : '',
    (r.questions || []).length ? `  질문: ${r.questions.join(' / ')}` : '',
    (r.notes || []).length ? `  메모: ${r.notes.join(' / ')}` : '',
    `  작업폴더: ${dir}`,
    '',
  ].filter(Boolean);
  fs.appendFileSync(path.join(ROOT, 'SUMMARY.log'), lines.join('\n') + '\n');
}

// ---------- E2E 스크린샷 보관 ----------
// /ticket-auto 는 pigon_pc/e2e-local/screenshots/<브랜치>/ 에 *_before / *_after 를 남기고, 다음 실행 때 덮어쓴다.
// 실행별로 비교할 수 있게 이번 실행 중에 만들어진 파일만 작업 폴더 screenshots/ 로 복사한다 (관리 웹이 여기서 읽는다).
function collectScreenshots(releaseId, since, dir) {
  const src = path.join(SCREENSHOT_ROOT, releaseId);
  if (!fs.existsSync(src)) return 0;
  const files = fs.readdirSync(src).filter(f => /\.(png|jpe?g)$/i.test(f) && fs.statSync(path.join(src, f)).mtimeMs >= since);
  if (!files.length) return 0;
  const dest = path.join(dir, 'screenshots');
  fs.mkdirSync(dest, { recursive: true });
  files.forEach(f => fs.copyFileSync(path.join(src, f), path.join(dest, f)));
  return files.length;
}

// ---------- 일감 1건 처리 ----------
// 반환값: done(이번 회차 할 일 없음) / queued(Claude 실행 필요, 다음 회차) / retry(실패 재시도) / wait(문서·환경 준비 대기)
async function processTicket(no, threadName, token, state, rows, opts = {}) {
  const ticket = await loadTicket(no, token, { rows, withDoc: false });
  if (!ticket) { log(`No ${no}: 시트에 없음 → 건너뜀`); return 'done'; }
  const tag = `No ${no} [${ticket.releaseId || ticket.changeId}] ${ticket.title}`;
  // WEB → pigon_pc (git, /ticket-auto) 후 다음 회차에 PigOn(모바일, SVN 로컬 수정까지만) 후속 반영
  // BATCH → PIGON_GRP_AGENT_REPL/CONT/API (SVN, 로컬 수정까지만)
  const isBatch = ticket.service === 'BATCH';
  if (ticket.project !== 'PIGON' || !['WEB', 'BATCH'].includes(ticket.service)) { log(`${tag}: ${ticket.project}/${ticket.service} → 대상 아님`); return 'done'; }
  if (!ticket.developer.includes(CONFIG.developerName)) { log(`${tag}: 개발담당자 ${ticket.developer || '(미지정)'} → 대상 아님`); return 'done'; }
  // 내 일감은 작업 목록에 남겨 매 회차 시트 상태를 다시 본다 (완료한 일감도 P=O, S=X 가 되면 추가 수정사항)
  const tState = state.tickets[no] || (state.tickets[no] = { releaseId: ticket.releaseId || null, requestDone: false, processedHashes: [], attempts: 0 });
  tState.title = ticket.title;
  // 웹 반영이 끝나고 모바일 후속 반영이 남아 있으면 그것부터 한다 (시트 알림 체크와 무관)
  if (tState.mobilePending) return runMobile(ticket, tag, tState, threadName, token, state);
  // 시트 P열 알림 체크 O, S열 알림 체크 X 인 일감만 처리
  if (!ticket.alertP || ticket.alertS) {
    if (!opts.quiet) log(`${tag}: 알림 체크 P=${ticket.alertP ? 'O' : 'X'} S=${ticket.alertS ? 'O' : 'X'} (P=O, S=X 만 대상) → 이번 회차 대상 아님`);
    return 'done';
  }
  if (!ticket.releaseId) {
    // 릴리즈노트는 개발자가 결과 메일을 보고 나중에 작성한다. 브랜치명은 변경요청 ID 에 R- 를 끼워 만든다.
    // 예) PIGON-20261113-002 → PIGON-20261113-R-002
    const m = ticket.changeId.match(/^([A-Z]+-\d{8})-(\d{3})$/);
    if (!m) { log(`${tag}: 변경요청 ID 형식 불일치(${ticket.changeId || '빈 값'}) → 다음 폴링에 재시도`); return 'wait'; }
    ticket.releaseId = `${m[1]}-R-${m[2]}`;
    ticket.branchDerived = true;
  }
  tState.releaseId = ticket.releaseId;
  await loadDoc(ticket, token);
  if (!ticket.doc) { log(`${tag}: 변경요청 문서 없음 → 다음 폴링에 재시도`); return 'wait'; }
  const d = ticket.doc;

  // 확인 요청(blocked)·재시도 중단 뒤에는 문서(요청사항·테스트 칸)가 바뀔 때까지 기다린다. --no 로 지정하면 바로 다시 돌린다.
  const hash = docHash(d);
  if (tState.hold) {
    if (tState.hold.hash === hash && !opts.force) {
      if (!opts.quiet) log(`${tag}: ${tState.hold.status === 'blocked' ? '확인 요청' : '재시도 중단'} 후 문서 변경 없음 → 대기`);
      return 'done';
    }
    log(`${tag}: ${opts.force ? '--no 지정' : '변경요청 문서가 바뀜'} → 대기 해제 후 다시 진행`);
    delete tState.hold;
    tState.attempts = 0;
  }

  const plan = decide(ticket, tState, isBatch);
  if (plan.mode === 'skip') { if (!opts.quiet) log(`${tag}: 새 추가요청 없음 → 건너뜀`); tState.known = true; return 'done'; }
  // 알림은 시트 행 생성 시점에 오고, 문서 내용은 나중에 채워진다. 비어 있으면 실행하지 않고 기다린다.
  if (plan.mode === 'new' && !d.request && !d.requestImages.length) {
    log(`${tag}: 변경요청 문서 1. 요청사항 미작성 → 다음 폴링에 재확인`);
    return 'wait';
  }
  // 한 회차에 여러 건을 이어서 돌리면 작업 스케줄러 시간 제한에 걸린다 → 다음 회차로 넘긴다
  if (claudeRan) { log(`${tag}: 이번 회차에 이미 1건 실행함 → 다음 폴링으로 넘김 (${plan.mode})`); return 'queued'; }
  if (!isBatch) {
    const env = webEnvProblem();
    if (env) {
      log(`${tag}: 실행 보류 — ${env.msg} → 다음 폴링에 재확인 (시도 횟수 미포함)`);
      await alert(`env:${env.kind}`, {
        title: 'WEB 일감 실행 보류',
        subtitle: `${ticket.releaseId} ${ticket.title}`,
        fields: [['사유', env.msg]],
        note: '정리되면 다음 폴링에 자동으로 진행해요.',
      }, log);
      return 'wait';
    }
  }

  if (isBatch) log(`${tag}: 서브에이전트 준비 ${syncAgents('batch', CONFIG.batch.projectDirs[0]).join(', ') || '(없음)'}`);
  const before = isBatch ? svnSnapshot(CONFIG.batch.projectDirs) : null;
  const startedAt = Date.now();
  const dir = path.join(RUN_DIR, ticket.releaseId, `${stamp()}-${plan.mode}`);
  fs.mkdirSync(dir, { recursive: true });
  const images = await downloadImages(plan.images, ticket.doc.imageUrls, dir, token);
  const linkTexts = plan.mode === 'new' ? [d.request, ...plan.blocks.map(b => b.text)] : plan.blocks.map(b => b.text);
  const linked = await downloadLinkedFiles(linkTexts, dir, token);
  const requestFile = writeRequest(ticket, plan, images, dir, linked);
  log(`${tag}: 모드=${plan.mode}, 추가요청 블록=${plan.blocks.length}, 이미지=${images.length}, 첨부파일=${linked.length}, 작업폴더=${dir}`);

  const result = await runClaude(ticket, plan, requestFile, dir, isBatch ? 'batch' : 'web');
  if (result.dry) { log(`${tag}: 처리 완료 (dry-run)`); return 'done'; }
  if (isBatch) {
    const files = changedSince(before, svnSnapshot(CONFIG.batch.projectDirs));
    fs.writeFileSync(path.join(dir, 'changed-files.json'), JSON.stringify(files, null, 2));
    result.result = Object.assign(result.result || {}, { batchFiles: files });
  }

  if (!isBatch) {
    const shots = collectScreenshots(ticket.releaseId, startedAt, dir);
    if (shots) log(`${tag}: E2E 스크린샷 ${shots}개 보관 → ${path.join(dir, 'screenshots')}`);
  }

  const status = (result.result && result.result.status) || 'no-result';
  // push 된 티켓 브랜치의 최종 커밋을 git 에서 직접 읽어 result.json 에 남긴다 (Claude 가 적은 commits 와 별개로, 관리 웹·Chat 에 표시)
  if (!isBatch && status === 'pushed') {
    const head = branchHead(ticket.releaseId);
    if (head) {
      result.result.headCommit = head;
      try { fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result.result, null, 2)); } catch (e) { log(`${tag}: result.json 커밋 기록 실패 ${e.message}`); }
    }
  }
  const commitTag = result.result && result.result.headCommit ? ` · 커밋 ${result.result.headCommit.slice(0, 8)}` : '';
  writeSummary(ticket, plan, result.result, dir, startedAt);
  log(`${tag}: claude 종료코드 ${result.code}, 결과 ${status}`);
  tState.lastStatus = status;
  tState.lastRunAt = new Date().toISOString();
  state.batchResults = (state.batchResults || []).concat(`${ticket.releaseId} ${plan.mode === 'new' ? '신규' : '추가요청'} ${STATUS_TEXT[status] || status}${commitTag}`);
  // 결과는 관리 웹에서 본다. 메일은 notifyMail=true 일 때만 (기본 끔)
  if (CONFIG.notifyMail) {
    try {
      // Claude 실행이 1시간을 넘기면 폴링 시작 때 받은 토큰이 만료된다 → 발송 직전에 새로 받는다
      token = await accessToken();
      await sendResultMail(token, ticket, plan, result.result, dir);
      log(`${tag}: 결과 메일 발송`);
    } catch (e) {
      log(`${tag}: ${e.message}`);
      const r = result.result || {};
      await alert(null, {
        title: '결과 메일 발송 실패',
        subtitle: `${ticket.releaseId} ${ticket.title}`,
        fields: [['오류', e.message.slice(0, 150)], ['결과', STATUS_TEXT[status] || status], ['요약', (r.summary || '').slice(0, 300)], ['작업폴더', dir]],
        link: true,
      }, log);
    }
  }

  // pushed: 완료. modified: BATCH 일감 로컬 수정 완료(SVN 커밋은 개발자가 직접)
  // blocked: 모호함 → Chat 으로 확인 요청 후, 변경요청 문서가 바뀔 때까지 대기
  // failed / no-result: 오류 알림. 환경 문제일 수 있어 1회 재시도, 그래도 실패면 문서가 바뀔 때까지 대기
  const ok = status === 'pushed' || status === 'modified';
  const r = result.result || {};
  if (ok) {
    tState.attempts = 0;
    tState.known = true;
    delete tState.asked;
    if (plan.mode === 'new') tState.requestDone = true;
    // 신규 처리 시점에 이미 있던 테스트 블록도 처리된 것으로 본다
    const handled = plan.mode === 'new' ? ticket.doc.testBlocks : plan.blocks;
    handled.forEach(b => tState.processedHashes.push(b.hash));
    if (CONFIG.notifyChat && threadName) {
      await replyInThread(token, threadName, `🤖 ${ticket.releaseId} ${plan.mode === 'new' ? '신규 개발' : '추가요청 반영'} 완료 — ${status === 'pushed' ? `브랜치 push됨${commitTag}` : 'SVN 로컬 수정(미커밋)'}, 개발자 검토 대기`);
    }
    // WEB 실행(/ticket-auto)이 result.mobile 에 모바일(PigOn) 반영 필요 여부를 판단해 둔다.
    // 필요할 때만 다음 회차에 모바일 반영을 돌린다 (폴링 1회당 Claude 1건 원칙). 판단이 없으면 모바일 실행에서 다시 판단한다
    if (!isBatch && CONFIG.mobile) {
      const m = r.mobile;
      if (m && m.needed === false) {
        log(`${tag}: 모바일(PigOn) 반영 불필요 — ${m.reason || '(사유 없음)'}`);
        return 'done';
      }
      tState.mobilePending = { releaseId: ticket.releaseId, mode: plan.mode, webDir: dir, attempts: 0 };
      log(`${tag}: 웹 반영 완료 → 모바일(PigOn) 반영은 다음 폴링에서 (${m ? '필요: ' + (m.reason || '') : '웹 실행 판단 없음'})`);
      return 'queued';
    }
    return 'done';
  }
  if (status === 'blocked') {
    tState.attempts = 0;
    tState.known = true;
    tState.asked = true;
    tState.hold = { hash, status };
    const qs = (r.questions || []).map((q, i) => `${i + 1}. ${q}`);
    await info('❓', {
      title: '개발자 확인 필요 (구현하지 않고 멈춤)',
      subtitle: `${ticket.releaseId} ${ticket.title}`,
      items: qs.length ? qs : [r.summary || '(질문 없음 — 관리 페이지에서 진행 로그 확인)'],
      note: '변경요청 문서 "3. 테스트" 칸에 답을 적으면 다음 폴링에 이어서 진행해요.',
      link: true,
    }, log);
    if (CONFIG.notifyChat && threadName) await replyInThread(token, threadName, `🤖 ${ticket.releaseId} 확인 필요: ${(r.questions || []).join(' / ')}`);
    return 'done';
  }
  tState.attempts++;
  log(`${tag}: 실패 (시도 ${tState.attempts}/${MAX_ATTEMPTS})`);
  const why = `${status}${r.failedStep ? ` — ${r.failedStep.slice(0, 200)}` : ''}`;
  if (tState.attempts < MAX_ATTEMPTS) {
    await alert(null, {
      title: '실행 오류',
      subtitle: `${ticket.releaseId} ${ticket.title}`,
      fields: [['원인', why]],
      note: '다음 폴링에 1회 다시 시도해요.',
      link: true,
    }, log);
    return 'retry';
  }
  tState.hold = { hash, status };
  await alert(null, {
    title: `${MAX_ATTEMPTS}회 실패 — 자동 재시도 중단`,
    subtitle: `${ticket.releaseId} ${ticket.title}`,
    fields: [['원인', why]],
    note: `변경요청 문서가 바뀌면 다시 진행해요. 바로 돌리려면: node poll.js --no ${no}`,
    link: true,
  }, log);
  return 'done';
}

const STATUS_TEXT = { pushed: '완료(push)', modified: '완료(SVN 로컬 수정)', unchanged: '해당 없음(변경 불필요)', blocked: '확인 필요', failed: '실패', 'no-result': '결과 없음' };

// ---------- 모바일(PigOn) 후속 반영 ----------
// 웹(pigon_pc) 브랜치가 push 된 뒤, 같은 기능이 모바일에 있으면 PigOn 작업본에 반영한다 (SVN 로컬 수정까지만).
// 반환값은 processTicket 과 같다. 결과와 관계없이 일감의 웹 처리 상태(requestDone·processedHashes)는 건드리지 않는다.
async function runMobile(ticket, tag, tState, threadName, token, state) {
  const job = tState.mobilePending;
  if (claudeRan) { log(`${tag}: 이번 회차에 이미 1건 실행함 → 모바일(PigOn) 반영은 다음 폴링으로`); return 'queued'; }
  ticket.releaseId = job.releaseId;
  const dirs = [CONFIG.mobile.projectDir];
  log(`${tag}: 서브에이전트 준비 ${syncAgents('mobile', CONFIG.mobile.projectDir).join(', ') || '(없음)'}`);
  const before = svnSnapshot(dirs);
  const startedAt = Date.now();
  const dir = path.join(RUN_DIR, job.releaseId, `${stamp()}-${job.mode}-mobile`);
  fs.mkdirSync(dir, { recursive: true });

  // 웹 변경분: 티켓 브랜치가 main 에서 갈라진 뒤의 전체 diff (feedback 이면 이전 반영분도 포함 → 프롬프트에서 미반영분만 하도록 안내)
  const webDiff = path.join(dir, 'web.diff');
  try {
    fs.writeFileSync(webDiff, execFileSync('git', ['diff', `origin/main...${job.releaseId}`], { cwd: CONFIG.projectDir, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }));
  } catch (e) {
    log(`${tag}: 웹 diff 생성 실패 ${e.message}`);
    fs.writeFileSync(webDiff, `(웹 diff 생성 실패: ${e.message}\npigon_pc 에서 git diff origin/main...${job.releaseId} 로 직접 확인할 것)\n`);
  }
  const slash = p => p.replace(/\\/g, '/');
  const requestFile = path.join(job.webDir, 'request.md');
  log(`${tag}: 모바일(PigOn) 반영 시작 (${job.mode}), 작업폴더=${dir}`);
  const result = await runClaude(ticket, { mode: job.mode }, requestFile, dir, 'mobile', {
    webDiff: slash(webDiff),
    webResult: slash(path.join(job.webDir, 'result.json')),
  });
  if (result.dry) { delete tState.mobilePending; return 'done'; }
  const files = changedSince(before, svnSnapshot(dirs));
  fs.writeFileSync(path.join(dir, 'changed-files.json'), JSON.stringify(files, null, 2));
  const r = Object.assign(result.result || {}, { batchFiles: files });
  const status = r.status || 'no-result';
  writeSummary(ticket, { mode: 'mobile' }, r, dir, startedAt);
  log(`${tag}: 모바일 claude 종료코드 ${result.code}, 결과 ${status}`);
  state.batchResults = (state.batchResults || []).concat(`${job.releaseId} 모바일 ${STATUS_TEXT[status] || status}`);

  if (status === 'modified' || status === 'unchanged') {
    delete tState.mobilePending;
    if (CONFIG.notifyChat && threadName) {
      await replyInThread(token, threadName, `🤖 ${job.releaseId} 모바일(PigOn) ${status === 'modified' ? 'SVN 로컬 수정(미커밋), 개발자 검토 대기' : '반영 불필요 — ' + (r.summary || '')}`);
    }
    return 'done';
  }
  if (status === 'blocked') {
    // 웹은 이미 끝났으므로 모바일 질문은 알리기만 하고, 모바일 반영은 개발자가 판단한다
    delete tState.mobilePending;
    const qs = (r.questions || []).map((q, i) => `${i + 1}. ${q}`);
    await info('❓', {
      title: '모바일(PigOn) 반영 확인 필요 (구현하지 않고 멈춤)',
      subtitle: `${job.releaseId} ${ticket.title}`,
      items: qs.length ? qs : [r.summary || '(질문 없음 — 관리 페이지에서 진행 로그 확인)'],
      note: '웹(pigon_pc)은 반영 완료됐어요. 모바일은 직접 반영하거나, 다시 돌리려면 웹 추가요청과 함께 요청하세요.',
      link: true,
    }, log);
    return 'done';
  }
  job.attempts++;
  const why = `${status}${r.failedStep ? ` — ${r.failedStep.slice(0, 200)}` : ''}`;
  if (job.attempts < MAX_ATTEMPTS) {
    await alert(null, {
      title: '모바일(PigOn) 반영 오류',
      subtitle: `${job.releaseId} ${ticket.title}`,
      fields: [['원인', why]],
      note: '다음 폴링에 1회 다시 시도해요.',
      link: true,
    }, log);
    return 'retry';
  }
  delete tState.mobilePending;
  await alert(null, {
    title: `모바일(PigOn) 반영 ${MAX_ATTEMPTS}회 실패 — 중단`,
    subtitle: `${job.releaseId} ${ticket.title}`,
    fields: [['원인', why]],
    note: '웹(pigon_pc)은 반영 완료됐어요. 모바일은 직접 반영해 주세요.',
    link: true,
  }, log);
  return 'done';
}

// ---------- main ----------
(async () => {
  if (!acquireLock()) return;
  try {
    if (staleLock) await alertStaleLock();
    const args = process.argv.slice(2);
    const argOf = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
    const token = await accessToken();
    let state = loadState();
    if (!state) {
      // 최초 실행: 지금 이후 알림부터 처리 (과거 알림 일괄 처리 방지)
      state = { since: new Date().toISOString(), seenMessages: [], pending: [], tickets: {} };
      log(`상태 초기화: ${state.since} 이후 알림부터 처리`);
    }

    // 처리 대상 수집: { no → threadName }
    // 순서: 지난 회차 대기분 → 새 알림 → 작업 목록 전체(완료 건 포함, 추가 수정사항 확인용)
    const targets = new Map();
    const fromList = new Set(); // 작업 목록에서만 온 번호 (해당 없을 때 로그를 줄인다)
    state.pending.forEach(no => targets.set(no, null));

    const onlyNo = argOf('--no');
    if (onlyNo) {
      targets.clear();
      targets.set(onlyNo, null);
    } else {
      const since = argOf('--since') || state.since;
      const msgs = await listNewMessages(token, since);
      log(`새 메시지 ${msgs.length}건 (since ${since})`);
      msgs.forEach(m => {
        if (state.seenMessages.includes(m.name)) return;
        state.seenMessages.push(m.name);
        if (m.createTime > state.since) state.since = m.createTime;
        const { stage, no } = parseNotice(m.text);
        if (!no || stage !== '개발 요청') return;
        targets.set(no, m.thread && m.thread.name);
      });
      Object.keys(state.tickets).forEach(no => {
        if (!targets.has(no)) { targets.set(no, null); fromList.add(no); }
      });
    }
    log(`확인 대상 ${targets.size}건 (작업 목록 ${Object.keys(state.tickets).length}건)`);

    const rows = await loadSheetRows(token); // 시트는 회차당 한 번만 읽는다
    const pending = [];
    const outcome = {};
    for (const [no, thread] of targets) {
      try {
        const r = await processTicket(no, thread, token, state, rows, { force: !!onlyNo, quiet: fromList.has(no) });
        outcome[r] = (outcome[r] || 0) + 1;
        if (r !== 'done') pending.push(no);
      } catch (e) {
        log(`No ${no}: 오류 ${e.message} → 다음 폴링에 재시도`);
        await alert(`ticket-error:${no}`, {
          title: '일감 처리 중 오류',
          subtitle: `No ${no}`,
          fields: [['오류', e.message.slice(0, 200)]],
          note: '다음 폴링마다 다시 시도해요. (같은 알림은 6시간에 한 번)',
        }, log);
        outcome.retry = (outcome.retry || 0) + 1;
        pending.push(no);
      }
      saveState(Object.assign(state, { pending: onlyNo ? state.pending : pending }));
    }
    if (!onlyNo) state.pending = pending;

    // 이번 회차에 Claude 를 돌렸고 더 돌릴 일감(queued/retry)이 없으면 전체 완료 알림.
    // 남아 있으면 다음 회차에 이어서 처리하고, 마지막 회차에서 그동안의 결과를 모아 한 번에 알린다.
    if (claudeRan) {
      const left = (outcome.queued || 0) + (outcome.retry || 0);
      if (!left) {
        const results = state.batchResults || [];
        await info('✅', {
          title: `모든 일감 처리 끝 (${results.length}건)`,
          items: results.map(s => `• ${s}`),
          note: outcome.wait ? `문서·환경 준비를 기다리는 일감이 ${outcome.wait}건 있어요.` : '',
          link: { text: '결과·스크린샷 보기' },
        }, log);
        state.batchResults = [];
      } else {
        log(`남은 일감 ${left}건 → 다음 회차에 이어서 처리 (완료 알림은 전부 끝난 뒤)`);
      }
    }
    saveState(state);
  } finally {
    fs.rmSync(LOCK_PATH, { force: true });
  }
})().catch(async e => {
  log('치명적 오류: ' + e.message);
  // 토큰 만료·갱신 실패도 여기로 온다. 웹훅은 OAuth 와 무관하게 발송된다
  await alert(`fatal:${e.message.slice(0, 60)}`, {
    title: '폴링 전체 실패',
    fields: [['오류', e.message.slice(0, 300)]],
    note: '해결 전까지 일감 처리가 멈춰요. (6시간마다 다시 알려요)',
  }, log);
  process.exit(1);
});
