// 하네스(봇이 일하는 방식을 정하는 파일들) 조회·수정·되돌리기
// - 고칠 수 있는 파일은 아래 FILES 목록뿐이다. 경로를 입력으로 받지 않는다.
// - 저장할 때마다 이전 내용을 state/harness-backups/ 에 남기고 state/harness-changes.log 에 기록한다.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const MAX_BYTES = 300 * 1024;
const TIMEOUTS = [60, 120, 180, 240];
const BACKUP_NAME = /^([a-z-]+)\.\d{8}-\d{6}-\d{3}\.bak$/;

function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = function createHarness({ ROOT, loadRuns, isDone }) {
  const BACKUP_DIR = path.join(ROOT, 'state', 'harness-backups');
  const HISTORY = path.join(ROOT, 'state', 'harness-changes.log');
  const CONFIG = path.join(ROOT, 'config.json');
  const readConfig = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8'));

  const FILES = {
    'web-guide': {
      label: '웹 일감 작업 지침', kind: 'md',
      desc: '웹 일감을 받았을 때 따르는 절차예요. 점검, 구현, 테스트, 커밋, push 순서를 정해요.',
      file: () => path.join(readConfig().projectDir, '.claude', 'commands', 'ticket-auto.md'),
    },
    'batch-prompt': {
      label: '배치 일감 프롬프트', kind: 'md',
      desc: '배치 일감을 받았을 때 그대로 전달되는 지시문이에요.',
      required: ['{releaseId}', '{mode}', '{requestFile}', '{resultFile}'],
      file: () => path.join(ROOT, 'batch-prompt.md'),
    },
    permissions: {
      label: '권한과 훅', kind: 'json',
      desc: '허용·금지할 도구와 명령 목록이에요. 실행 전 검사(훅)도 여기서 연결해요.',
      file: () => path.join(ROOT, 'bot-settings.json'),
    },
    guard: {
      label: '명령 가드', kind: 'js',
      desc: '명령을 실행하기 직전에 검사하는 코드예요. 위험한 git 작업과 잘못된 push를 막아요.',
      file: () => path.join(ROOT, 'bot-guard.js'),
    },
  };
  // 실행 옵션(config.json)은 내용에 민감한 값이 있어 편집기로 열지 않는다. 되돌리기 대상으로만 쓴다.
  const OPTIONS = { label: '실행 옵션', kind: 'json', file: () => CONFIG };
  const defOf = id => (id === 'options' ? OPTIONS : FILES[id]);

  const hashOf = text => crypto.createHash('sha1').update(text).digest('hex');

  function stamp() {
    const d = new Date();
    const p = (n, w) => String(n).padStart(w || 2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
  }

  function checkJs(text) {
    return new Promise((resolve, reject) => {
      const tmp = path.join(os.tmpdir(), `harness-check-${process.pid}-${Date.now()}.js`);
      fs.writeFileSync(tmp, text);
      execFile(process.execPath, ['--check', tmp], { windowsHide: true, timeout: 10000 }, (err, stdout, stderr) => {
        fs.rmSync(tmp, { force: true });
        if (!err) return resolve();
        const line = (stderr.split(/\r?\n/).find(l => /Error/.test(l)) || '문법 오류').slice(0, 160);
        reject(fail(400, `코드에 문법 오류가 있어요. ${line}`));
      });
    });
  }

  async function validate(def, text) {
    if (!text.trim()) throw fail(400, '내용이 비어 있어요.');
    if (Buffer.byteLength(text) > MAX_BYTES) throw fail(400, '내용이 너무 길어요.');
    (def.required || []).forEach(k => {
      if (!text.includes(k)) throw fail(400, `${k} 자리표시가 빠졌어요. 봇이 이 자리에 값을 넣어요.`);
    });
    if (def.kind === 'json') {
      let v;
      try { v = JSON.parse(text); } catch (e) { throw fail(400, `JSON 형식이 맞지 않아요. ${e.message.slice(0, 120)}`); }
      if (def === FILES.permissions && !(v && v.permissions && Array.isArray(v.permissions.allow) && Array.isArray(v.permissions.deny))) {
        throw fail(400, 'permissions.allow 와 permissions.deny 목록이 있어야 해요.');
      }
      if (def === OPTIONS && !(v && v.claude && Array.isArray(v.claude.args))) throw fail(400, '실행 옵션 형식이 맞지 않아요.');
    }
    if (def.kind === 'js') await checkJs(text);
  }

  // 이전 내용을 남기고 새 내용으로 바꾼다
  function replaceFile(id, def, current, next, action) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const backup = `${id}.${stamp()}.bak`;
    fs.writeFileSync(path.join(BACKUP_DIR, backup), current);
    const file = def.file();
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, file);
    fs.appendFileSync(HISTORY, JSON.stringify({ time: new Date().toISOString(), id, action, backup }) + '\n');
  }

  function readFile(id) {
    const def = FILES[id];
    if (!def) throw fail(404, '없는 항목이에요.');
    const text = fs.readFileSync(def.file(), 'utf8');
    return { id, label: def.label, desc: def.desc, kind: def.kind, text, hash: hashOf(text) };
  }

  async function saveFile(id, body) {
    const def = FILES[id];
    if (!def) throw fail(404, '없는 항목이에요.');
    if (typeof body.text !== 'string' || typeof body.baseHash !== 'string') throw fail(400, '요청 형식이 맞지 않아요.');
    const current = fs.readFileSync(def.file(), 'utf8');
    if (hashOf(current) !== body.baseHash) throw fail(409, '그사이 파일이 바뀌었어요. 새로고침해서 최신 내용을 확인해 주세요.');
    // 편집기는 줄바꿈을 \n 으로 바꾸므로 원래 파일의 줄바꿈 방식에 맞춘다
    const lf = body.text.replace(/\r\n/g, '\n');
    const next = current.includes('\r\n') ? lf.replace(/\n/g, '\r\n') : lf;
    if (next === current) throw fail(400, '바뀐 내용이 없어요.');
    await validate(def, next);
    replaceFile(id, def, current, next, 'edit');
    return readFile(id);
  }

  function options() {
    const c = readConfig();
    return {
      dryRun: !!c.dryRun, notifyChat: !!c.notifyChat, notifyMail: !!c.notifyMail,
      timeoutMinutes: c.claude.timeoutMinutes, timeoutChoices: TIMEOUTS,
      promptTemplate: c.claude.promptTemplate,
      command: [c.claude.cmd].concat(c.claude.args).join(' '),
    };
  }

  // config.json 은 다시 직렬화하지 않고 해당 값만 바꿔서 나머지 서식을 그대로 둔다
  function setOptions(patch) {
    const current = fs.readFileSync(CONFIG, 'utf8');
    const before = JSON.parse(current);
    let next = current;
    const expected = JSON.parse(current);
    const put = (key, value, apply) => {
      const re = new RegExp(`("${key}"\\s*:\\s*)(true|false|\\d+)`);
      if (!re.test(next)) throw fail(500, `config.json 에서 ${key} 를 찾지 못했어요.`);
      next = next.replace(re, `$1${value}`);
      apply(expected, value);
    };
    ['dryRun', 'notifyChat', 'notifyMail'].forEach(k => {
      if (!(k in patch)) return;
      if (typeof patch[k] !== 'boolean') throw fail(400, '요청 형식이 맞지 않아요.');
      put(k, patch[k], (o, v) => { o[k] = v; });
    });
    if ('timeoutMinutes' in patch) {
      if (!TIMEOUTS.includes(patch.timeoutMinutes)) throw fail(400, `제한 시간은 ${TIMEOUTS.join(', ')}분 중에서 골라 주세요.`);
      put('timeoutMinutes', patch.timeoutMinutes, (o, v) => { o.claude.timeoutMinutes = v; });
    }
    if (JSON.stringify(JSON.parse(next)) !== JSON.stringify(expected)) throw fail(500, 'config.json 을 안전하게 바꾸지 못했어요. 파일을 직접 확인해 주세요.');
    if (JSON.stringify(expected) === JSON.stringify(before)) throw fail(400, '바뀐 내용이 없어요.');
    replaceFile('options', OPTIONS, current, next, 'edit');
    return options();
  }

  async function restore(name) {
    const m = BACKUP_NAME.exec(typeof name === 'string' ? name : '');
    const def = m && defOf(m[1]);
    const file = def && path.join(BACKUP_DIR, name);
    if (!def || !fs.existsSync(file)) throw fail(404, '되돌릴 기록을 찾지 못했어요.');
    const old = fs.readFileSync(file, 'utf8');
    const current = fs.readFileSync(def.file(), 'utf8');
    if (old === current) throw fail(400, '지금 내용과 같아요.');
    await validate(def, old);
    replaceFile(m[1], def, current, old, 'restore');
  }

  function history() {
    let lines = [];
    try {
      lines = fs.readFileSync(HISTORY, 'utf8').split('\n').filter(Boolean);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    return lines.map(l => JSON.parse(l)).reverse().slice(0, 30).map(h => {
      const def = defOf(h.id);
      return { time: h.time, id: h.id, label: def ? def.label : h.id, action: h.action, backup: h.backup, canRestore: fs.existsSync(path.join(BACKUP_DIR, h.backup)) };
    });
  }

  function overview(running) {
    const hist = history();
    const runs = loadRuns();
    const rate = list => ({ done: list.filter(r => isDone(r.status)).length, total: list.length });
    const since = hist.length ? hist[0].time : null;
    return {
      running,
      files: Object.keys(FILES).map(id => {
        const def = FILES[id];
        const st = fs.statSync(def.file());
        return { id, label: def.label, desc: def.desc, modified: st.mtime.toISOString() };
      }),
      options: options(),
      stats: { all: rate(runs), since, afterChange: since ? rate(runs.filter(r => r.time > since)) : null },
      history: hist,
    };
  }

  // 저장하지 않고 내용만 검사한다 (Claude 제안 확인용)
  const check = (id, text) => {
    if (!FILES[id]) throw fail(404, '없는 항목이에요.');
    return validate(FILES[id], text);
  };
  const fileIds = () => Object.keys(FILES);

  return { overview, readFile, saveFile, setOptions, restore, check, fileIds, MAX_BYTES };
};
