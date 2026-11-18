// 봇 이상 상황 알림 (Google Chat 수신 웹훅)
// - OAuth 토큰과 무관하게 동작해야 토큰 오류도 알릴 수 있어서 웹훅을 쓴다.
// - 웹훅 메시지는 앱 이름으로 올라와 본인에게도 알림이 온다(본인 OAuth 로 보내면 내 메시지라 알림이 안 옴).
// 설정: %USERPROFILE%\.pigon-chat\alert_webhook.txt 에 웹훅 URL 한 줄 (본인만 있는 스페이스에서 만든 웹훅)
const fs = require('fs');
const path = require('path');

const WEBHOOK_FILE = path.join(process.env.USERPROFILE, '.pigon-chat', 'alert_webhook.txt');
const SENT_PATH = path.join(__dirname, 'state', 'alerts.json');
const DEDUPE_MS = 6 * 60 * 60 * 1000; // 같은 key 는 6시간 안에 다시 보내지 않는다 (30분마다 같은 알림 반복 방지)

function webhookUrl() {
  try { return fs.readFileSync(WEBHOOK_FILE, 'utf8').trim(); } catch (e) { return ''; }
}

// Chat 에서 링크를 누르면 http 도 https 로 열린다 → 관리 서버가 같은 포트에서 https 도 받는다 (admin/server.js)
const ADMIN_URL = 'https://127.0.0.1:20020';
const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 알림을 카드로 만든다. 한 줄 텍스트보다 제목·항목·안내가 나뉘어 읽기 쉽다.
// msg: 문자열(제목만) 또는 {
//   title: 한 줄 제목, subtitle: 일감 번호·제목 등,
//   fields: [[라벨, 값], ...]  값이 비면 생략,
//   items: [문자열, ...]       목록(질문, 처리 결과 등),
//   note: 다음에 어떻게 되는지 안내 (회색),
//   link: true 또는 { text, path }  관리 페이지 버튼 (기본 경로 /#/runs)
// }
function buildMessage(icon, msg) {
  const m = typeof msg === 'string' ? { title: msg } : msg;
  const widgets = [];
  (m.fields || []).forEach(([label, value]) => {
    if (value == null || value === '') return;
    widgets.push({ decoratedText: { topLabel: label, text: escHtml(value), wrapText: true } });
  });
  if (m.items && m.items.length) widgets.push({ textParagraph: { text: m.items.map(escHtml).join('<br>') } });
  if (m.note) widgets.push({ textParagraph: { text: `<font color="#8B95A1">${escHtml(m.note)}</font>` } });
  if (m.link) {
    const link = m.link === true ? {} : m.link;
    widgets.push({ buttonList: { buttons: [{ text: link.text || '관리 페이지 열기', onClick: { openLink: { url: ADMIN_URL + (link.path || '/#/runs') } } }] } });
  }
  const card = { header: { title: `${icon} ${m.title}`, subtitle: m.subtitle || '피그온봇' } };
  if (widgets.length) card.sections = [{ widgets }];
  return {
    // 휴대폰·데스크톱 알림에 뜨는 글
    fallbackText: `🤖 피그온봇 ${icon} ${m.title}${m.subtitle ? ` — ${m.subtitle}` : ''}`,
    cardsV2: [{ cardId: 'pigon-bot', card }],
  };
}

// key: 중복 억제용 (null 이면 항상 발송). 실패해도 예외를 던지지 않는다.
// icon: 카드 제목 앞 표시 (기본 ⚠ = 문제 알림, info() 는 ✅/❓ 등 일반 안내용)
async function alert(key, msg, log = () => {}, icon = '⚠') {
  const text = typeof msg === 'string' ? msg : [msg.title, msg.subtitle].filter(Boolean).join(' — ');
  let sent = {};
  try { sent = JSON.parse(fs.readFileSync(SENT_PATH, 'utf8')); } catch (e) { /* 처음 */ }
  const now = Date.now();
  if (key && sent[key] && now - sent[key] < DEDUPE_MS) return false;

  const url = webhookUrl();
  if (!url) { log(`[알림 생략: 웹훅 미설정] ${text}`); return false; }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(buildMessage(icon, msg)),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) { log(`알림 발송 실패 HTTP ${res.status}: ${text}`); return false; }
  } catch (e) {
    log(`알림 발송 실패 ${e.message}: ${text}`);
    return false;
  }
  log(`알림 발송: ${text.slice(0, 120)}`);
  if (key) {
    sent[key] = now;
    Object.keys(sent).forEach(k => { if (now - sent[k] > DEDUPE_MS) delete sent[k]; });
    try { fs.writeFileSync(SENT_PATH, JSON.stringify(sent, null, 2)); } catch (e) { /* 다음에 중복 발송될 뿐 */ }
  }
  return true;
}

// 문제가 아닌 안내(확인 요청, 처리 완료). 중복 억제 없이 항상 보낸다
const info = (icon, text, log) => alert(null, text, log, icon);

module.exports = { alert, info, buildMessage };

if (require.main === module) {
  // 웹훅 설정 확인용: node notify.js
  alert(null, { title: '테스트 알림', items: ['이 카드가 보이면 웹훅 설정 완료입니다.'], link: { path: '/' } }, console.log)
    .then(ok => { if (!ok) process.exit(1); });
}
