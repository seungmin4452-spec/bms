// 시트 No → 일감 행 + 변경요청 문서(요청사항/개발완료/테스트/기타사항) 조회
// 사용법: node ticket.js <No>
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SECRET_DIR = path.join(process.env.USERPROFILE, '.pigon-chat');
const SHEET_ID = '1OV9N6NujTDxsEvHnNBKFZPl0Fcnb-2dEliJj_KI4QmA';
const TAB = '이력관리';

async function accessToken() {
  const c = JSON.parse(fs.readFileSync(path.join(SECRET_DIR, 'client_secret.json'), 'utf8')).installed;
  const { refresh_token } = JSON.parse(fs.readFileSync(path.join(SECRET_DIR, 'token.json'), 'utf8'));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ refresh_token, client_id: c.client_id, client_secret: c.client_secret, grant_type: 'refresh_token' }),
  });
  const tok = await res.json();
  if (!tok.access_token) throw new Error('토큰 갱신 실패: ' + JSON.stringify(tok));
  return tok.access_token;
}

async function getJson(url, token) {
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const data = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

function cellText(v) {
  return (v && v.formattedValue) || '';
}

function cellLink(v) {
  if (!v) return null;
  if (v.hyperlink) return v.hyperlink;
  const chip = (v.chipRuns || []).find(r => r.chip && r.chip.richLinkProperties);
  return chip ? chip.chip.richLinkProperties.uri : null;
}

// 문단 목록 → [{text, images}] (중첩 표는 행 단위로 펼침)
function paragraphs(content, out) {
  (content || []).forEach(el => {
    if (el.paragraph) {
      let text = '';
      const images = [];
      const links = [];
      el.paragraph.elements.forEach(e => {
        if (e.textRun) {
          text += e.textRun.content;
          // 하이퍼링크 글자는 URL 이 textStyle 에만 있어서 따로 챙기지 않으면 버려진다
          const link = e.textRun.textStyle && e.textRun.textStyle.link;
          if (link && link.url) links.push(link.url);
        }
        // 스마트 칩(Drive 파일 등)은 textRun 이 아니라 richLink 요소다
        if (e.richLink) {
          const p = e.richLink.richLinkProperties || {};
          text += p.title || '';
          if (p.uri) links.push(p.uri);
        }
        if (e.inlineObjectElement) images.push(e.inlineObjectElement.inlineObjectId);
      });
      text = text.replace(/\n$/, '');
      [...new Set(links)].forEach(u => { if (!text.includes(u)) text += ` (${u})`; });
      out.push({ text: (el.paragraph.bullet ? '- ' : '') + text, images });
    } else if (el.table) {
      el.table.tableRows.forEach(r => {
        const cells = r.tableCells.map(c => paragraphs(c.content, []).map(p => p.text.trim()).filter(Boolean).join(' '));
        out.push({ text: '| ' + cells.join(' | ') + ' |', images: [] });
      });
    }
  });
  return out;
}

function joinText(paras) {
  return paras.map(p => p.text).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// 변경요청 문서의 4단 표를 섹션으로 분리
function parseChangeDoc(doc) {
  const sections = { request: [], devDone: [], test: [], etc: [] };
  const keyOf = label => {
    if (/요청사항/.test(label)) return 'request';
    if (/개발완료/.test(label)) return 'devDone';
    if (/테스트/.test(label)) return 'test';
    if (/기타/.test(label)) return 'etc';
    return null;
  };
  const tabs = doc.tabs ? doc.tabs : [{ documentTab: { body: doc.body } }];
  tabs.forEach(t => (t.documentTab.body.content || []).forEach(el => {
    if (!el.table) return;
    el.table.tableRows.forEach(r => {
      if (r.tableCells.length < 2) return;
      const label = joinText(paragraphs(r.tableCells[0].content, []));
      const key = keyOf(label);
      if (key) sections[key].push(...paragraphs(r.tableCells[1].content, []));
    });
  }));

  const result = {};
  ['request', 'devDone', 'etc'].forEach(k => {
    result[k] = joinText(sections[k]);
    result[k + 'Images'] = [].concat(...sections[k].map(p => p.images));
  });

  // 테스트 칸: "작성일 :" 문단마다 블록 분리
  const blocks = [];
  sections.test.forEach(p => {
    if (/^\s*작성일\s*:/.test(p.text) || blocks.length === 0) blocks.push([]);
    blocks[blocks.length - 1].push(p);
  });
  result.testBlocks = blocks
    .map(b => {
      const text = joinText(b);
      const date = (text.match(/작성일\s*:\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
      const images = [].concat(...b.map(p => p.images));
      // 해시는 본문 기준: 공백 차이로 재처리되지 않게 정규화
      const hash = crypto.createHash('sha1').update(text.replace(/\s+/g, ' ')).digest('hex').slice(0, 12);
      return { date, text, images, hash };
    })
    .filter(b => b.text || b.images.length);

  // 이미지 id → 다운로드 URL (탭별 inlineObjects 병합)
  result.imageUrls = {};
  tabs.forEach(t => Object.entries(t.documentTab.inlineObjects || {}).forEach(([id, o]) => {
    const p = o.inlineObjectProperties && o.inlineObjectProperties.embeddedObject;
    if (p && p.imageProperties) result.imageUrls[id] = p.imageProperties.contentUri;
  }));
  return result;
}

// 시트 전체 행. 폴링 1회에 작업 목록 전체를 확인하므로 한 번만 읽어 loadTicket 에 넘긴다
async function loadSheetRows(token) {
  const range = encodeURIComponent(`${TAB}!A1:S2100`);
  const fields = encodeURIComponent('sheets.data.rowData.values(formattedValue,hyperlink,chipRuns)');
  const data = await getJson(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?ranges=${range}&fields=${fields}`, token);
  return data.sheets[0].data[0].rowData || [];
}

// 변경요청 문서를 읽어 ticket.doc 에 넣는다 (시트 조건을 통과한 일감만 읽어 Docs API 호출을 줄인다)
async function loadDoc(ticket, token) {
  const m = ticket.changeDocUrl && ticket.changeDocUrl.match(/\/document\/d\/([^/]+)/);
  if (m) {
    const doc = await getJson(`https://docs.googleapis.com/v1/documents/${m[1]}?includeTabsContent=true`, token);
    ticket.doc = parseChangeDoc(doc);
  }
  return ticket;
}

// opts.rows: 미리 읽은 시트 행 / opts.withDoc=false: 문서는 읽지 않는다
async function loadTicket(no, token, opts = {}) {
  const rows = opts.rows || await loadSheetRows(token);
  const row = rows.find(r => r.values && cellText(r.values[0]) === String(no));
  if (!row) return null;
  const v = row.values;
  const ticket = {
    no: cellText(v[0]), project: cellText(v[1]), service: cellText(v[2]), status: cellText(v[3]),
    requester: cellText(v[6]), title: cellText(v[7]),
    changeId: cellText(v[8]), changeDocUrl: cellLink(v[8]),
    releaseId: cellText(v[9]), releaseDocUrl: cellLink(v[9]),
    category: cellText(v[10]), priority: cellText(v[11]), developer: cellText(v[17]),
    // P열·S열 "알림 >" 체크박스 (formattedValue 가 "TRUE"/"FALSE", 미입력은 빈 값)
    alertP: cellText(v[15]) === 'TRUE', alertS: cellText(v[18]) === 'TRUE',
  };
  if (opts.withDoc === false) return ticket;
  return loadDoc(ticket, token);
}

module.exports = { accessToken, getJson, loadTicket, loadSheetRows, loadDoc };

if (require.main === module) {
  (async () => {
    const token = await accessToken();
    const t = await loadTicket(process.argv[2], token);
    if (!t) { console.log('해당 No 없음'); return; }
    const { doc, ...meta } = t;
    console.log(JSON.stringify(meta, null, 2));
    if (!doc) { console.log('(변경요청 문서 없음)'); return; }
    console.log(`--- 요청사항 (${doc.request.length}자, 이미지 ${doc.requestImages.length})\n${doc.request.slice(0, 300)}`);
    console.log(`--- 개발완료 (${doc.devDone.length}자)`);
    console.log(`--- 기타사항 (${doc.etc.length}자)`);
    doc.testBlocks.forEach((b, i) => console.log(`--- 테스트 블록 ${i} date=${b.date} hash=${b.hash} ${b.text.length}자 이미지 ${b.images.length}\n${b.text.slice(0, 150)}`));
    console.log(`--- 이미지 URL ${Object.keys(doc.imageUrls).length}개`);
  })().catch(e => { console.error(e.message); process.exit(1); });
}
