// 결과 메일 (Gmail API, 본인 계정 → 본인 계정)
const fs = require('fs');
const path = require('path');

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const STATUS = {
  pushed: { label: '검토 대기', color: '#1a7f37' },
  modified: { label: '검토 대기(SVN 미커밋)', color: '#1a7f37' },
  blocked: { label: '확인 필요', color: '#9a6700' },
  failed: { label: '실패', color: '#cf222e' },
  'no-result': { label: '실패(결과 없음)', color: '#cf222e' },
};

async function myEmail(token) {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + token } });
  const data = await res.json();
  if (!data.email) throw new Error('메일 주소 조회 실패: ' + JSON.stringify(data).slice(0, 200));
  return data.email;
}

function section(title, body, opts = {}) {
  if (!body) return '';
  const border = opts.alert ? 'border-left:4px solid #cf222e;background:#fff5f5;padding:8px 12px;' : '';
  return `<h3 style="margin:20px 0 6px;font-size:15px">${esc(title)}</h3><div style="${border}">${body}</div>`;
}

function list(items) {
  if (!items || !items.length) return '';
  return '<ul style="margin:0;padding-left:20px">' + items.map(i => `<li style="margin:3px 0">${i}</li>`).join('') + '</ul>';
}

function pre(text) {
  return `<pre style="background:#f6f8fa;padding:10px;border-radius:6px;white-space:pre-wrap;font-size:12px;margin:4px 0">${esc(text)}</pre>`;
}

function buildMail(ticket, plan, r, dir) {
  r = r || {};
  const status = r.status || 'no-result';
  const st = STATUS[status] || STATUS.failed;
  const modeLabel = plan.mode === 'new' ? '신규' : '추가요청 반영';
  const db = r.dbScripts || [];
  const dbApply = db.filter(d => d.kind !== '확인');

  const subject = `[피그온봇][${st.label}]${dbApply.length ? '[DB적용필요]' : ''} ${ticket.releaseId} ${ticket.title}`;

  const head = `
    <div style="font-size:13px;color:#57606a">${esc(modeLabel)} · 시트 No ${esc(ticket.no)} · 변경요청 ${esc(ticket.changeId)} · ${esc(ticket.category)} · ${esc(ticket.priority)} · 요청자 ${esc(ticket.requester)}</div>
    ${ticket.service === 'BATCH' ? `<div style="font-size:13px;color:#57606a">BATCH 일감 · 대상 ${esc((r.projects || []).join(', ') || '미정')} · SVN 로컬 수정만 함, 커밋은 직접 (아래 'SVN 커밋 대상' 목록 참고)</div>` : ''}
    ${ticket.branchDerived && ticket.service !== 'BATCH' ? `<div style="font-size:13px;color:#9a6700">릴리즈노트 미작성 → 브랜치 <code>${esc(ticket.releaseId)}</code> 는 변경요청 ID 기준으로 생성. 시트 J열에 같은 ID로 릴리즈노트를 작성하세요.</div>` : ''}
    <h2 style="margin:6px 0 10px;font-size:18px"><span style="color:${st.color}">[${esc(st.label)}]</span> ${esc(ticket.releaseId)} ${esc(ticket.title)}</h2>
    ${r.mrLink ? `<p><a href="${esc(r.mrLink)}" style="background:#0969da;color:#fff;padding:7px 14px;border-radius:6px;text-decoration:none;font-weight:600">MR 만들기 / diff 보기</a></p>` : ''}
    <p style="margin:8px 0">${esc(r.summary || '결과 파일(result.json)이 없습니다. 아래 작업폴더의 claude.log 를 확인하세요.')}</p>
    ${r.failedStep ? `<p style="color:#cf222e"><b>실패 지점:</b> ${esc(r.failedStep)}</p>` : ''}`;

  const dbHtml = db.length
    ? db.map(d => `<div style="margin:8px 0"><b>[${esc(d.kind)} · ${esc(d.target)}]</b> ${esc(d.purpose)}${pre(d.sql)}${d.risk ? `<div style="font-size:12px;color:#9a6700">⚠ ${esc(d.risk)}</div>` : ''}</div>`).join('')
    : '<p style="margin:0;color:#57606a">없음 (SqlMap 변경은 배포로 반영)</p>';

  const decisions = (r.decisions || []).map(d =>
    `<b>${esc(d.topic)}</b> → ${esc(d.choice)}<br><span style="font-size:12px;color:#57606a">근거: ${esc(d.reason)}${d.alternative ? ` / 대안: ${esc(d.alternative)}` : ''}</span>`);

  const changes = (r.changes || []).map(c => `<code>${esc(c.file)}${c.lines ? ':' + esc(c.lines) : ''}</code> — ${esc(c.what)}`);

  const requestText = plan.mode === 'new'
    ? (ticket.doc.request || '(이미지로 작성됨)')
    : plan.blocks.map(b => b.text).join('\n\n');

  const html = `<div style="font-family:'Malgun Gothic',sans-serif;font-size:14px;line-height:1.55;color:#1f2328;max-width:900px">
    ${head}
    ${section(dbApply.length ? '⚠ DB 적용 필요 쿼리' : 'DB 쿼리', dbHtml, { alert: dbApply.length > 0 })}
    ${section('질문 / 확인 필요', list((r.questions || []).map(esc)))}
    ${section('검토 체크리스트', list((r.reviewChecklist || []).map(esc)))}
    ${section('판단 내역 (스스로 정한 것)', list(decisions))}
    ${section('수정 내역', list(changes))}
    ${section('커밋', list((r.commits || []).map(c => `<code>${esc(c)}</code>`)))}
    ${section('테스트 / 리뷰', list([r.scale && `규모: ${esc(r.scale)}`, r.e2e && `E2E: ${esc(r.e2e)}`, r.compile && `컴파일: ${esc(r.compile)}`, r.review && `코드리뷰: ${esc(r.review)}`, r.contract && `계약: ${esc(r.contract)}`].filter(Boolean)))}
    ${section('메모', list((r.notes || []).map(esc)))}
    ${r.batchFiles ? section('SVN 커밋 대상 (이번 일감에서 바뀐 파일)', r.batchFiles.length
      ? list(r.batchFiles.map(f => `<code>${esc(f.file)}</code> — ${esc(f.status)}${f.preModified ? ' <span style="color:#9a6700">(실행 전부터 미커밋 수정이 있던 파일 — 기존 변경과 함께 커밋됨)</span>' : ''}`))
      : '<p style="margin:0;color:#57606a">없음</p>') : ''}
    ${section(plan.mode === 'new' ? '원 요청사항' : '반영한 추가요청', pre(requestText.slice(0, 4000)))}
    <p style="margin-top:24px;font-size:12px;color:#57606a">작업폴더: ${esc(dir)}<br>변경요청 문서: ${esc(ticket.changeDocUrl || '')}</p>
  </div>`;
  return { subject, html };
}

function encodeHeader(s) {
  return '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
}

async function sendResultMail(token, ticket, plan, result, dir) {
  const to = await myEmail(token);
  const { subject, html } = buildMail(ticket, plan, result, dir);
  fs.writeFileSync(path.join(dir, 'mail.html'), html);
  const raw = [
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n'),
  ].join('\r\n');
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: Buffer.from(raw, 'utf8').toString('base64url') }),
  });
  if (!res.ok) throw new Error(`메일 발송 실패 HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

module.exports = { sendResultMail, buildMail };
