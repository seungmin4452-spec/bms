// iBatis SqlMap statement 본문 통째 교체 (무인 봇 전용 도구)
// 사용: node C:/Users/SMSHIN/pigon-chat-bot/tools/replace-statement.js <sqlmap.xml> <statementId> <교체파일> [--dry-run] [--keep-indent]
// - <statementId>: id 속성값 그대로 (예: AdRp21_Ft02.selectRp21_Ft020305_03List)
// - <교체파일>: SQL 본문만 있거나, <select id=...> ... </select> 전체가 있어도 됨 (전체면 안쪽만 사용)
// - 대상의 여닫는 태그는 그대로 두고 그 사이 본문만 바꾼다
// - 대상 파일의 줄바꿈(CRLF/LF)·BOM 유지. 교체 본문의 공통 들여쓰기를 걷어내고 기존 본문 들여쓰기로 맞춘다(--keep-indent 면 그대로)
const fs = require('fs');

const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));
const [target, id, srcFile] = argv.filter(a => !a.startsWith('--'));
const die = msg => { process.stderr.write('replace-statement: ' + msg + '\n'); process.exit(1); };
if (!target || !id || !srcFile) die('사용법: replace-statement.js <sqlmap.xml> <statementId> <교체파일> [--dry-run] [--keep-indent]');
for (const f of [target, srcFile]) if (!fs.existsSync(f)) die('파일 없음: ' + f);

const TAGS = 'select|insert|update|delete|statement|procedure|sql';
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const openRe = new RegExp(`<(${TAGS})\\b[^>]*\\bid\\s*=\\s*"${esc(id)}"[^>]*>`);

const read = f => {
  let t = fs.readFileSync(f, 'utf8');
  const bom = t.charCodeAt(0) === 0xfeff;
  if (bom) t = t.slice(1);
  return { bom, eol: t.includes('\r\n') ? '\r\n' : '\n', lines: t.split(/\r?\n/) };
};

// ---- 대상 파일에서 statement 위치 찾기 ----
const T = read(target);
const hits = T.lines.map((l, i) => (openRe.test(l) ? i : -1)).filter(i => i >= 0);
if (hits.length !== 1) die(`대상에서 id="${id}" 여는 태그가 ${hits.length}개 (정확히 1개여야 함)`);
const open = hits[0];
const tag = T.lines[open].match(openRe)[1];
if (new RegExp(`</${tag}\\s*>`).test(T.lines[open])) die('여는 태그와 닫는 태그가 같은 줄에 있어 처리 불가');
const closeRe = new RegExp(`^\\s*</${tag}\\s*>\\s*$`);
let close = -1;
for (let i = open + 1; i < T.lines.length; i++) {
  if (closeRe.test(T.lines[i])) { close = i; break; }
  if (new RegExp(`<(${TAGS})\\b[^>]*\\bid\\s*=`).test(T.lines[i])) die(`${i + 1}행에서 다음 statement 가 먼저 나옴 (닫는 </${tag}> 를 못 찾음)`);
}
if (close < 0) die(`닫는 </${tag}> 를 못 찾음`);

// ---- 교체 본문 준비 ----
const S = read(srcFile);
let body = S.lines.slice();
while (body.length && !body[body.length - 1].trim()) body.pop();
while (body.length && !body[0].trim()) body.shift();
const warn = [];
const srcOpen = body.findIndex(l => openRe.test(l));
if (srcOpen >= 0) {
  const srcTag = body[srcOpen].match(openRe)[1];
  const srcClose = body.findIndex((l, i) => i > srcOpen && new RegExp(`^\\s*</${srcTag}\\s*>\\s*$`).test(l));
  if (srcClose < 0) die(`교체 파일에 </${srcTag}> 닫는 태그가 없음`);
  if (body[srcOpen].trim() !== T.lines[open].trim()) warn.push('여는 태그가 대상과 다름 (대상 태그 유지):\n  대상: ' + T.lines[open].trim() + '\n  교체: ' + body[srcOpen].trim());
  body = body.slice(srcOpen + 1, srcClose);
} else if (new RegExp(`<(${TAGS})\\b[^>]*\\bid\\s*=`).test(S.lines.join('\n'))) {
  die(`교체 파일에 다른 id 의 statement 가 있음 (id="${id}" 아님)`);
}
if (!body.some(l => l.trim())) die('교체 본문이 비어 있음');

if (!flags.has('--keep-indent')) {
  const nonblank = l => l.trim().length > 0;
  const lead = l => l.match(/^[ \t]*/)[0];
  const oldFirst = T.lines.slice(open + 1, close).find(nonblank);
  const prefix = oldFirst !== undefined ? lead(oldFirst) : lead(T.lines[open]) + '\t';
  let common = null;
  for (const l of body.filter(nonblank)) {
    const p = lead(l);
    if (common === null) common = p;
    else { let k = 0; while (k < common.length && k < p.length && common[k] === p[k]) k++; common = common.slice(0, k); }
  }
  body = body.map(l => (nonblank(l) ? prefix + l.slice(common.length) : ''));
}
body = body.map(l => l.replace(/[ \t]+$/, '')); // 줄 끝 공백 제거

const oldCount = close - open - 1;
const out = T.lines.slice(0, open + 1).concat(body, T.lines.slice(close));
const summary = `${target}\n  <${tag} id="${id}"> ${open + 1}~${close + 1}행: 본문 ${oldCount}줄 → ${body.length}줄 (교체 후 ${open + 1}~${open + body.length + 2}행, EOL=${T.eol === '\r\n' ? 'CRLF' : 'LF'}${T.bom ? ', BOM' : ''})`;
warn.forEach(w => process.stdout.write('경고: ' + w + '\n'));
if (flags.has('--dry-run')) { process.stdout.write('[dry-run] ' + summary + '\n'); process.exit(0); }
fs.writeFileSync(target, (T.bom ? '\ufeff' : '') + out.join(T.eol), 'utf8');
process.stdout.write('교체 완료: ' + summary + '\n');
