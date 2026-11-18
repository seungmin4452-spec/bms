'use strict';
(function () {
  const TOKEN = document.querySelector('meta[name="admin-token"]').content;
  const view = document.getElementById('view');
  let timer = null;      // 홈 자동 갱신
  let stream = null;     // 진행 로그 SSE
  let runsCache = null;
  let gen = 0;           // 화면 전환 번호: 늦게 도착한 응답이 다른 화면을 덮어쓰지 않게 한다
  const filter = { status: 'all', q: '' };

  // ---------- 공통 ----------
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(method, url, body) {
    const opt = { method, headers: {} };
    if (method !== 'GET') {
      opt.headers['X-Admin-Token'] = TOKEN;
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body || {});
    }
    const res = await fetch(url, opt);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '요청을 처리하지 못했어요');
    return data;
  }

  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { el.hidden = true; }, 2600);
  }

  function confirmSheet(title, desc, okLabel) {
    return new Promise(resolve => {
      const sheet = document.getElementById('sheet');
      const ok = document.getElementById('sheet-ok');
      const cancel = document.getElementById('sheet-cancel');
      document.getElementById('sheet-title').textContent = title;
      document.getElementById('sheet-desc').textContent = desc;
      ok.textContent = okLabel;
      sheet.hidden = false;
      ok.focus();
      const close = v => {
        sheet.hidden = true;
        ok.onclick = cancel.onclick = sheet.onclick = null;
        document.removeEventListener('keydown', onKey);
        resolve(v);
      };
      const onKey = e => { if (e.key === 'Escape') close(false); };
      ok.onclick = () => close(true);
      cancel.onclick = () => close(false);
      sheet.onclick = e => { if (e.target === sheet) close(false); };
      document.addEventListener('keydown', onKey);
    });
  }

  const pad = n => String(n).padStart(2, '0');
  function when(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    const now = new Date();
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diff = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - day) / 864e5);
    if (diff === 0) return `오늘 ${hm}`;
    if (diff === 1) return `어제 ${hm}`;
    if (diff === -1) return `내일 ${hm}`;
    return `${d.getMonth() + 1}월 ${d.getDate()}일 ${hm}`;
  }

  const STATUS = {
    pushed: ['완료', 'good'], modified: ['완료', 'good'], blocked: ['확인 필요', 'warn'],
    failed: ['실패', 'bad'], 'no-result': ['결과 없음', ''],
  };
  const badge = s => { const [label, cls] = STATUS[s] || [s, '']; return `<span class="badge ${cls}">${esc(label)}</span>`; };
  const modeText = m => (m === 'new' ? '신규 개발' : m === 'feedback' ? '추가요청' : m);

  const runRow = r => `
    <a class="row" href="#/runs/${r.id}">
      ${badge(r.status)}
      <div class="row-main">
        <div class="row-title">${esc(r.title)}</div>
        <div class="row-sub">${esc(r.ticket)} · ${esc(modeText(r.mode))} · ${esc(when(r.time))}${r.questionCount ? ` · 질문 ${r.questionCount}개` : ''}</div>
      </div>
      <span class="row-arrow" aria-hidden="true">›</span>
    </a>`;

  const workRow = w => {
    const state = w.queued ? '<span class="badge">대기열</span>'
      : w.hold === 'blocked' ? '<span class="badge warn">답변 대기</span>'
        : w.hold ? '<span class="badge bad">재시도 중단</span>'
          : w.lastStatus ? badge(w.lastStatus) : '<span class="badge">미실행</span>';
    return `
    <div class="row">
      ${state}
      <div class="row-main">
        <div class="row-title">${esc(w.title || '(제목 없음)')}</div>
        <div class="row-sub">No ${esc(w.no)} · ${esc(w.releaseId || '-')}${w.lastRunAt ? ` · 마지막 실행 ${esc(when(w.lastRunAt))}` : ''}</div>
      </div>
    </div>`;
  };

  function stopLive() {
    clearInterval(timer); timer = null;
    if (stream) { stream.close(); stream = null; }
  }

  // ---------- 홈 ----------
  const HERO = {
    running: ['동작 중', '일감을 처리하고 있어요'],
    idle: ['대기', '다음 확인까지 기다리고 있어요'],
    off: ['꺼짐', '봇이 꺼져 있어요'],
    attention: ['확인 필요', '확인할 게 있어요'],
  };

  function heroSub(s) {
    const t = s.task;
    if (s.state === 'running') return `PID ${s.running.pid} · ${when(t.lastRun)}에 시작`;
    if (s.state === 'off') return `마지막 실행 ${when(t.lastRun)} · 켜면 ${t.intervalMinutes}분마다 일감을 확인해요`;
    return `다음 확인 ${when(t.nextRun)} · ${t.intervalMinutes}분마다`;
  }

  function drawHome(s) {
    const [label, title] = HERO[s.state];
    const on = s.task.enabled;
    view.innerHTML = `
      <section class="card">
        <div class="hero">
          <div>
            <div class="hero-state"><span class="dot ${s.state}"></span>${esc(label)}</div>
            <div class="hero-title">${esc(title)}</div>
            <div class="hero-sub">${esc(heroSub(s))}</div>
          </div>
          <button class="toggle" id="toggle" role="switch" aria-checked="${on}" aria-label="봇 켜기·끄기"></button>
        </div>
        ${s.warnings.map(w => `<div class="notice">${esc(w)}</div>`).join('')}
        <div class="hero-actions">
          <button class="btn soft" id="run" ${on && s.state !== 'running' ? '' : 'disabled'}>지금 실행</button>
        </div>
      </section>
      <div class="stats">
        <div class="stat"><b>${s.week.done}</b><span>최근 7일 완료</span></div>
        <div class="stat"><b>${s.week.blocked}</b><span>확인 필요</span></div>
        <div class="stat"><b>${s.week.failed}</b><span>실패</span></div>
      </div>
      ${usageCard(s.usage)}
      ${s.state === 'running' ? '<section class="card"><h2>진행 로그</h2><pre class="log" id="progress"></pre></section>' : ''}
      <section class="card flush">
        <h2>확인이 필요한 일감</h2>
        ${s.attention.length ? s.attention.map(runRow).join('') : '<div class="empty">지금은 확인할 일감이 없어요</div>'}
      </section>
      ${s.pending ? `<p class="desc pending">대기열에 ${s.pending}건이 남아 있어요.</p>` : ''}
      <section class="card flush">
        <h2>작업 목록 <span class="desc">매 회차 시트에서 P열 O · S열 X 인지 다시 확인해요</span></h2>
        ${(s.worklist || []).length ? s.worklist.map(workRow).join('') : '<div class="empty">아직 알림으로 들어온 일감이 없어요</div>'}
      </section>`;

    document.getElementById('toggle').onclick = () => toggleBot(s);
    document.getElementById('run').onclick = runNow;
    document.getElementById('usage-refresh').onclick = refreshUsage;
    applyMeters();
    if (s.state === 'running') openProgress();
    else if (stream) { stream.close(); stream = null; }
  }

  // ---------- Claude 사용량 ----------
  const USAGE_SOURCE = { bot: '봇 실행 기록', probe: '지금 확인' };
  let usageAutoTried = false; // 기록이 하나도 없을 때만, 페이지당 한 번 자동으로 확인한다

  function usageMeter(label, w) {
    if (!w) return `<div class="meter"><div class="meter-head"><span>${esc(label)}</span><b>-</b></div><div class="meter-bar"><i></i></div><div class="meter-sub">정보 없음</div></div>`;
    // 바는 사용률만큼 채운다: 쓸수록 늘어나고, 한도가 초기화되면 줄어든다
    const used = Math.max(0, Math.min(100, w.usedPercent));
    const left = Math.round((100 - used) * 10) / 10;
    // 폭·색은 applyMeters 가 JS 로 넣는다 (CSP 때문에 HTML 의 style 속성은 무시된다)
    return `
      <div class="meter" data-key="${esc(label)}" data-to="${used}">
        <div class="meter-head"><span>${esc(label)}</span><b>${used}% 사용</b></div>
        <div class="meter-bar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${used}" aria-label="${esc(label)} 사용률"><i></i></div>
        <div class="meter-sub">${left}% 남음 · ${esc(when(w.resetsAt))} 초기화</div>
      </div>`;
  }

  // 사용률 → 색: 0% 초록 → 50% 주황 → 100% 빨강 (테마 색을 섞어 다크 모드에서도 맞게)
  function usageColor(used) {
    if (used <= 50) return `color-mix(in oklab, var(--warn) ${Math.round(used * 2)}%, var(--good))`;
    return `color-mix(in oklab, var(--bad) ${Math.round((used - 50) * 2)}%, var(--warn))`;
  }

  const meterLast = {}; // 라벨별 마지막 사용률. 다시 그릴 때 이전 값에서 새 값으로 움직이게 한다
  function applyMeters() {
    const meters = view.querySelectorAll('.meter[data-to]');
    if (!meters.length) return;
    meters.forEach(m => {
      const from = meterLast[m.dataset.key] || 0;
      m.querySelector('.meter-bar i').style.width = `${from}%`;
      m.style.setProperty('--meter-color', usageColor(from));
    });
    void meters[0].offsetWidth; // 시작 값을 먼저 반영시켜야 transition 이 걸린다
    meters.forEach(m => {
      const to = Number(m.dataset.to);
      m.querySelector('.meter-bar i').style.width = `${to}%`;
      m.style.setProperty('--meter-color', usageColor(to));
      meterLast[m.dataset.key] = to;
    });
  }

  function usageCard(u) {
    const snap = u && u.snapshot;
    const checking = u && u.checking;
    const sub = snap ? `${esc(when(snap.checkedAt))} 기준 · ${esc(USAGE_SOURCE[snap.source] || snap.source)}` : '아직 확인한 기록이 없어요';
    return `
      <section class="card">
        <div class="usage-head">
          <h2>Claude 남은 사용량 <span class="desc">${sub}</span></h2>
          <button class="btn soft" id="usage-refresh" ${checking ? 'disabled' : ''}>${checking ? '확인 중…' : '지금 확인'}</button>
        </div>
        ${snap && snap.status === 'rejected' ? '<div class="notice">사용 한도에 도달했어요. 초기화 시각 전까지 봇이 개발을 진행하지 못해요.</div>' : ''}
        <div class="meters">
          ${usageMeter('5시간 한도', snap && snap.fiveHour)}
          ${usageMeter('7일 한도', snap && snap.sevenDay)}
        </div>
      </section>`;
  }

  async function refreshUsage() {
    const btn = document.getElementById('usage-refresh');
    if (btn) { btn.disabled = true; btn.textContent = '확인 중…'; }
    try {
      await api('POST', '/api/usage/refresh');
      toast('사용량을 확인했어요');
    } catch (e) { toast(e.message); }
    lastHome = '';
    refreshHome();
  }

  function openProgress() {
    const pre = document.getElementById('progress');
    if (stream) stream.close();
    stream = new EventSource('/api/progress');
    stream.addEventListener('reset', () => { pre.textContent = ''; });
    stream.addEventListener('append', e => {
      const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
      pre.textContent += JSON.parse(e.data);
      if (stick) pre.scrollTop = pre.scrollHeight;
    });
  }

  async function toggleBot(s) {
    const on = s.task.enabled;
    const ok = on
      ? await confirmSheet('봇을 끌까요?', '꺼두면 새 일감을 확인하지 않아요. 지금 처리 중인 일감은 끝까지 진행돼요.', '끄기')
      : await confirmSheet('봇을 켤까요?', `${s.task.intervalMinutes}분마다 일감을 확인하고, 조건에 맞는 일감은 자동으로 개발해서 push해요.`, '켜기');
    if (!ok) return;
    const g = gen;
    try {
      const next = await api('POST', on ? '/api/bot/disable' : '/api/bot/enable');
      if (g === gen) { lastHome = ''; drawHome(next); }
      toast(on ? '봇을 껐어요' : '봇을 켰어요');
    } catch (e) { toast(e.message); }
  }

  async function runNow() {
    if (!await confirmSheet('지금 일감을 확인할까요?', '기다리지 않고 바로 한 번 실행해요. 새 일감이 있으면 개발을 시작해요.', '지금 실행')) return;
    try {
      await api('POST', '/api/bot/run');
      toast('실행했어요');
      setTimeout(refreshHome, 1500);
    } catch (e) { toast(e.message); }
  }

  let lastHome = '';
  async function refreshHome() {
    const g = gen;
    try {
      const s = await api('GET', '/api/status');
      if (g !== gen) return;
      const key = JSON.stringify(s);
      if (key === lastHome || !document.getElementById('sheet').hidden) return; // 바뀐 게 없으면 다시 그리지 않는다
      lastHome = key;
      drawHome(s);
      if (!usageAutoTried && s.usage && !s.usage.snapshot && !s.usage.checking) { usageAutoTried = true; refreshUsage(); }
    } catch (e) {
      if (g !== gen) return;
      view.innerHTML = `<section class="card"><div class="hero-title">상태를 불러오지 못했어요</div><p>${esc(e.message)}</p></section>`;
      lastHome = '';
    }
  }

  function home() {
    lastHome = '';
    view.innerHTML = '<section class="card"><div class="empty">봇 상태를 확인하고 있어요</div></section>';
    refreshHome();
    timer = setInterval(refreshHome, 5000);
  }

  // ---------- 내역 ----------
  const FILTERS = [['all', '전체'], ['done', '완료'], ['blocked', '확인 필요'], ['failed', '실패']];
  const groupOf = s => (s === 'pushed' || s === 'modified' ? 'done' : s === 'blocked' ? 'blocked' : 'failed');

  function drawRunList() {
    const q = filter.q.trim().toLowerCase();
    const rows = runsCache.filter(r => (filter.status === 'all' || groupOf(r.status) === filter.status)
      && (!q || r.ticket.toLowerCase().includes(q) || r.title.toLowerCase().includes(q)));
    document.getElementById('list').innerHTML = rows.length ? rows.map(runRow).join('') : '<div class="empty">조건에 맞는 실행이 없어요</div>';
    document.getElementById('count').textContent = `${rows.length}건`;
  }

  async function runs() {
    view.innerHTML = `
      <div class="filters">
        ${FILTERS.map(([k, l]) => `<button class="chip ${filter.status === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}
        <input class="search" id="q" type="search" placeholder="티켓번호나 제목으로 찾기" aria-label="티켓번호나 제목으로 찾기" value="${esc(filter.q)}">
      </div>
      <section class="card flush"><h2>실행 내역 <span class="desc" id="count"></span></h2><div id="list"><div class="empty">불러오는 중이에요</div></div></section>`;
    view.querySelectorAll('.chip').forEach(c => {
      c.onclick = () => {
        filter.status = c.dataset.f;
        view.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === c));
        drawRunList();
      };
    });
    document.getElementById('q').oninput = e => { filter.q = e.target.value; drawRunList(); };
    const g = gen;
    try {
      const data = await api('GET', '/api/runs');
      if (g !== gen) return;
      runsCache = data.runs;
      drawRunList();
    } catch (e) {
      if (g !== gen) return;
      document.getElementById('list').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }

  // ---------- 상세 ----------
  const listCard = (title, items) => (items.length ? `<section class="card"><h2>${title}</h2><ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul></section>` : '');
  const fileCard = (title, f) => (f ? `<section class="card"><h2>${title}</h2>${f.truncated ? '<p class="desc mb8">길어서 뒷부분만 보여줘요.</p>' : ''}<pre class="log">${esc(f.text)}</pre></section>` : '');
  const arr = v => (Array.isArray(v) ? v : []);
  const textCard = (title, v) => (v ? `<section class="card"><h2>${title}</h2><p>${esc(v)}</p></section>` : '');

  // result.json — 예전에 메일로 보내던 내용을 그대로 보여준다
  function resultCards(res, changedFiles) {
    if (!res) return '';
    const rows = (items, fn) => `<ul>${items.map(i => `<li>${fn(i)}</li>`).join('')}</ul>`;
    const card = (title, items, fn) => (items.length ? `<section class="card"><h2>${title}</h2>${rows(items, fn)}</section>` : '');
    const decisions = card('스스로 정한 것', arr(res.decisions), d => `<b>${esc(d.topic)}</b> — ${esc(d.choice)}<div class="desc">근거: ${esc(d.reason)}${d.alternative ? ` · 대안: ${esc(d.alternative)}` : ''}</div>`);
    const changes = card('변경 내용', arr(res.changes), c => `<code>${esc(c.file)}${c.lines ? ':' + esc(c.lines) : ''}</code> ${esc(c.what)}`);
    const files = card('바뀐 파일 (실행 전후 비교)', arr(changedFiles), f => `<code>${esc(f.file)}</code> ${esc(f.status)}${f.preModified ? ' <span class="desc">(실행 전부터 수정돼 있던 파일)</span>' : ''}`);
    const db = arr(res.dbScripts).length ? `<section class="card"><h2>DB 적용 필요 쿼리</h2>${arr(res.dbScripts).map(s => `
      <div class="mb8"><b>${esc(s.kind)}</b> · ${esc(s.target)} — ${esc(s.purpose)}<pre class="log">${esc(s.sql)}</pre><div class="desc">${esc(s.risk)}</div></div>`).join('')}</section>` : '';
    return [
      textCard('실패 단계', res.failedStep),
      decisions, changes, files, db,
      listCard('커밋 전 확인할 것', arr(res.reviewChecklist)),
      listCard('커밋', arr(res.commits)),
      textCard('E2E', res.e2e), textCard('코드리뷰', res.review), textCard('컴파일', res.compile),
    ].join('');
  }

  // E2E 스크린샷 변경 전/후 비교
  function shotCards(id, shots) {
    if (!shots.length) return '';
    const img = (f, label) => (f
      ? `<figure><figcaption>${label}</figcaption><a href="/api/runs/${id}/shots/${encodeURIComponent(f)}" target="_blank" rel="noopener"><img src="/api/runs/${id}/shots/${encodeURIComponent(f)}" alt="${esc(label)} ${esc(f)}" loading="lazy"></a></figure>`
      : `<figure class="none"><figcaption>${label}</figcaption><div class="desc">없음</div></figure>`);
    return `<section class="card"><h2>스크린샷 비교 <span class="desc">${shots.length}개 장면 · 누르면 원본 크기</span></h2>
      ${shots.map(s => `<div class="shot"><div class="shot-name">${esc(s.name)}</div><div class="shot-pair">
        ${s.only ? img(s.only, '스크린샷') : img(s.before, '변경 전') + img(s.after, '변경 후')}
      </div></div>`).join('')}</section>`;
  }

  async function detail(id) {
    view.innerHTML = '<a class="back" href="#/runs">‹ 내역</a><section class="card"><div class="empty">불러오는 중이에요</div></section>';
    const g = gen;
    try {
      const r = await api('GET', `/api/runs/${id}`);
      if (g !== gen) return;
      const mr = /^https?:\/\//.test(r.mr) ? `<section class="card"><h2>MR 만들기</h2><a class="btn soft link" href="${esc(r.mr)}" target="_blank" rel="noopener noreferrer">GitLab에서 열기</a></section>` : '';
      view.innerHTML = `
        <a class="back" href="#/runs">‹ 내역</a>
        <section class="card">
          ${badge(r.status)}
          <div class="detail-title">${esc(r.title)}</div>
          <div class="desc">${esc(r.ticket)} · ${esc(modeText(r.mode))} · ${esc(when(r.time))}</div>
        </section>
        <section class="card"><h2>요약</h2><p>${esc(r.summary || '요약이 없어요')}</p></section>
        ${listCard('답이 필요한 질문', r.questions)}
        ${mr}
        ${shotCards(r.id, r.shots || [])}
        ${resultCards(r.result, r.changedFiles)}
        ${listCard('메모', r.notes)}
        ${r.hasFolder ? fileCard('요청서', r.request) + fileCard('진행 로그', r.log)
          : '<section class="card"><p class="desc">작업폴더가 정리돼서 요청서와 진행 로그는 볼 수 없어요.</p></section>'}`;
    } catch (e) {
      if (g !== gen) return;
      view.innerHTML = `<a class="back" href="#/runs">‹ 내역</a><section class="card"><p>${esc(e.message)}</p></section>`;
    }
  }

  // ---------- 설정 ----------
  async function settings() {
    view.innerHTML = '<section class="card"><div class="empty">불러오는 중이에요</div></section>';
    const g = gen;
    let s;
    try { s = await api('GET', '/api/schedule'); } catch (e) { if (g !== gen) return; view.innerHTML = `<section class="card"><p>${esc(e.message)}</p></section>`; return; }
    if (g !== gen) return;
    let picked = s.intervalMinutes;
    const draw = () => {
      view.innerHTML = `
        <section class="card">
          <h2>일감 확인 간격</h2>
          <p class="desc">봇이 새 일감이 있는지 확인하는 주기예요. 지금은 ${s.intervalMinutes}분이에요.</p>
          <div class="seg mt16">${s.options.map(m => `<button class="chip ${m === picked ? 'on' : ''}" data-m="${m}">${m}분</button>`).join('')}</div>
          <button class="btn main" id="save" ${picked === s.intervalMinutes ? 'disabled' : ''}>변경하기</button>
        </section>
        <section class="card">
          <h2>봇 정보</h2>
          <div class="kv"><span>스케줄 작업</span><b>${esc(s.taskName)}</b></div>
          <div class="kv"><span>한 번 실행 제한</span><b>${s.timeLimitMinutes ? `${s.timeLimitMinutes / 60}시간` : '없음'}</b></div>
          <div class="kv"><span>봇 폴더</span><b>${esc(s.botDir)}</b></div>
        </section>`;
      view.querySelectorAll('.seg .chip').forEach(c => { c.onclick = () => { picked = Number(c.dataset.m); draw(); }; });
      document.getElementById('save').onclick = save;
    };
    const save = async () => {
      if (!await confirmSheet(`${picked}분마다 확인할까요?`, `지금은 ${s.intervalMinutes}분마다 확인하고 있어요.`, '변경하기')) return;
      try {
        s.intervalMinutes = (await api('PUT', '/api/schedule', { intervalMinutes: picked })).intervalMinutes;
        picked = s.intervalMinutes;
        draw();
        toast('간격을 바꿨어요');
      } catch (e) { toast(e.message); }
    };
    draw();
  }

  // ---------- 하네스 ----------
  const pct = r => (r && r.total ? `${Math.round(r.done / r.total * 100)}%` : '-');
  const ACTION = { edit: '수정', restore: '되돌림' };

  function drawHarness(d) {
    const o = d.options;
    const after = d.stats.afterChange;
    const optRow = (key, title, desc) => `
      <div class="opt">
        <div><div class="opt-title">${title}</div><div class="desc">${desc}</div></div>
        <button class="toggle" role="switch" aria-checked="${o[key]}" aria-label="${title}" data-opt="${key}" data-title="${title}"></button>
      </div>`;
    view.innerHTML = `
      <section class="card">
        <div class="hero-title">봇이 일하는 방식을 고쳐요</div>
        <div class="hero-sub">지침, 권한, 가드를 고치면 다음 실행부터 적용돼요. 고치기 전 내용은 변경 기록에 남아요.</div>
        ${d.running ? '<div class="notice">봇이 일감을 처리하는 중이라 지금은 바꿀 수 없어요.</div>' : ''}
      </section>
      <div class="stats two">
        <div class="stat"><b>${pct(d.stats.all)}</b><span>전체 완료율 · ${d.stats.all.total}번 중 ${d.stats.all.done}번</span></div>
        <div class="stat"><b>${pct(after)}</b><span>${after ? `마지막 변경 뒤 · ${after.total}번 중 ${after.done}번` : '아직 변경한 적이 없어요'}</span></div>
      </div>
      <section class="card" id="ai-card"></section>
      <section class="card flush">
        <h2>지침과 규칙</h2>
        ${d.files.map(f => `
          <a class="row" href="#/harness/${f.id}">
            <div class="row-main"><div class="row-title">${esc(f.label)}</div><div class="row-sub wrap-text">${esc(f.desc)}</div><div class="row-sub">${esc(when(f.modified))}에 수정됨</div></div>
            <span class="row-arrow" aria-hidden="true">›</span>
          </a>`).join('')}
      </section>
      <section class="card">
        <h2>실행 옵션</h2>
        ${optRow('dryRun', '연습 모드', '켜면 실제로 개발하지 않고 요청서와 프롬프트만 만들어요.')}
        ${optRow('notifyChat', 'Chat 답글', '끝나면 요청 스레드에 결과를 답글로 남겨요.')}
        ${optRow('notifyMail', '결과 메일', '끝나면 결과를 메일로 보내요.')}
        <div class="opt-title mt16">한 일감 제한 시간</div>
        <div class="seg">${o.timeoutChoices.map(m => `<button class="chip ${m === o.timeoutMinutes ? 'on' : ''}" data-t="${m}">${m / 60}시간</button>`).join('')}</div>
        <div class="kv"><span>웹 일감 프롬프트</span><b class="mono">${esc(o.promptTemplate)}</b></div>
        <div class="kv"><span>실행 명령</span><b class="mono">${esc(o.command)}</b></div>
        <p class="desc">프롬프트와 실행 명령은 여기서 볼 수만 있어요. 바꾸려면 config.json을 직접 고쳐 주세요.</p>
      </section>
      <section class="card flush">
        <h2>변경 기록</h2>
        ${d.history.length ? d.history.map(h => `
          <div class="row">
            <div class="row-main"><div class="row-title">${esc(h.label)} ${esc(ACTION[h.action] || h.action)}</div><div class="row-sub">${esc(when(h.time))}</div></div>
            ${h.canRestore ? `<button class="btn sub small" data-restore="${esc(h.backup)}" data-label="${esc(h.label)}" data-when="${esc(when(h.time))}">이전으로</button>` : ''}
          </div>`).join('') : '<div class="empty">아직 바꾼 적이 없어요</div>'}
      </section>`;

    drawDiagnosis();

    const g = gen;
    const apply = async (title, desc, okLabel, call, done) => {
      if (!await confirmSheet(title, desc, okLabel)) return;
      try {
        await call();
        toast(done);
        if (g === gen) harness();
      } catch (e) { toast(e.message); }
    };
    view.querySelectorAll('[data-opt]').forEach(b => {
      b.onclick = () => {
        const on = b.getAttribute('aria-checked') === 'true';
        apply(`${b.dataset.title}${on ? '를 끌까요?' : '를 켤까요?'}`, '다음 실행부터 적용돼요.', on ? '끄기' : '켜기',
          () => api('PUT', '/api/harness/options', { [b.dataset.opt]: !on }), '바꿨어요');
      };
    });
    view.querySelectorAll('[data-t]').forEach(b => {
      b.onclick = () => {
        const m = Number(b.dataset.t);
        if (m === o.timeoutMinutes) return;
        apply(`제한 시간을 ${m / 60}시간으로 바꿀까요?`, `지금은 ${o.timeoutMinutes / 60}시간이에요. 넘기면 그 일감은 중단돼요.`, '변경하기',
          () => api('PUT', '/api/harness/options', { timeoutMinutes: m }), '바꿨어요');
      };
    });
    view.querySelectorAll('[data-restore]').forEach(b => {
      b.onclick = () => apply(`${b.dataset.label}을 이전으로 되돌릴까요?`, `${b.dataset.when}에 바꾸기 직전 내용으로 돌아가요. 지금 내용도 변경 기록에 남아요.`, '되돌리기',
        () => api('POST', '/api/harness/restore', { backup: b.dataset.restore }), '되돌렸어요');
    });
  }

  // Claude 진단: 탭을 오가도 결과와 진행 상태가 남도록 화면 밖에 둔다
  const ai = { busy: false, result: null, error: '' };
  let handoff = null; // 진단 제안을 편집기로 넘길 때 쓰는 수정 요청문

  function drawDiagnosis() {
    const card = document.getElementById('ai-card');
    if (!card) return;
    const r = ai.result;
    card.innerHTML = `
      <h2>Claude와 함께 고치기</h2>
      <p class="desc">Claude가 최근 실행 기록과 지금 하네스를 읽고, 어디를 고치면 좋을지 알려줘요. 1분쯤 걸려요.</p>
      ${ai.error ? `<div class="notice">${esc(ai.error)}</div>` : ''}
      ${r ? `
        <p class="ai-summary">${esc(r.summary)}</p>
        ${r.suggestions.map((s, i) => `
          <div class="suggest">
            <div class="row-sub">${esc(s.label)}</div>
            <div class="opt-title">${esc(s.title)}</div>
            <p>${esc(s.reason)}</p>
            <button class="btn soft small" data-go="${i}">이 제안으로 고치기</button>
          </div>`).join('') || '<p class="desc">하네스에서 고칠 곳을 찾지 못했어요.</p>'}
        ${r.notHarness.length ? `<div class="opt-title mt16">하네스로는 못 고치는 것</div><ul>${r.notHarness.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
        <p class="desc mt16">${esc(when(r.time))}에 살펴봤어요.</p>` : ''}
      <div class="hero-actions"><button class="btn ${r ? 'sub' : 'main'}" id="diagnose" ${ai.busy ? 'disabled' : ''}>${ai.busy ? 'Claude가 살펴보는 중이에요…' : r ? '다시 살펴보기' : '개선할 곳 찾기'}</button></div>`;
    document.getElementById('diagnose').onclick = async () => {
      ai.busy = true; ai.error = '';
      drawDiagnosis();
      try { ai.result = await api('POST', '/api/harness/ai/diagnose'); } catch (e) { ai.error = e.message; }
      ai.busy = false;
      drawDiagnosis();
      if (!document.getElementById('ai-card')) toast(ai.error || 'Claude가 진단을 끝냈어요');
    };
    card.querySelectorAll('[data-go]').forEach(b => {
      b.onclick = () => {
        const s = r.suggestions[Number(b.dataset.go)];
        handoff = { id: s.file, request: s.request };
        location.hash = `#/harness/${s.file}`;
      };
    });
  }

  // 줄 단위 비교(LCS). 바뀐 줄과 앞뒤 2줄만 돌려준다.
  function diffLines(before, after) {
    const a = before.split('\n'), b = after.split('\n');
    if (a.length * b.length > 4e6) return null; // 너무 크면 비교를 생략한다
    const w = b.length + 1;
    const lcs = new Uint32Array((a.length + 1) * w);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    const ops = [];
    let i = 0, j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
      else if (j < b.length && (i === a.length || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) { ops.push(['+', b[j]]); j++; }
      else { ops.push(['-', a[i]]); i++; }
    }
    const keep = new Set();
    ops.forEach((o, k) => { if (o[0] !== ' ') for (let d = -2; d <= 2; d++) keep.add(k + d); });
    const out = [];
    ops.forEach((o, k) => {
      if (keep.has(k)) out.push(o);
      else if (out.length && out[out.length - 1][0] !== '…') out.push(['…', '']);
    });
    return out;
  }

  async function harness() {
    const g = gen;
    if (!view.querySelector('.stats.two')) view.innerHTML = '<section class="card"><div class="empty">불러오는 중이에요</div></section>';
    try {
      const d = await api('GET', '/api/harness');
      if (g === gen) drawHarness(d);
    } catch (e) {
      if (g === gen) view.innerHTML = `<section class="card"><p>${esc(e.message)}</p></section>`;
    }
  }

  // 줄 단위로 몇 줄이 더해지고 빠졌는지 센다 (순서는 보지 않는다)
  function lineDelta(before, after) {
    const count = new Map();
    before.split('\n').forEach(l => count.set(l, (count.get(l) || 0) + 1));
    let added = 0;
    after.split('\n').forEach(l => {
      const n = count.get(l) || 0;
      if (n) count.set(l, n - 1); else added++;
    });
    let removed = 0;
    count.forEach(n => { removed += n; });
    return { added, removed };
  }

  let dirty = false; // 편집기에 저장하지 않은 내용이 있는지

  async function harnessEdit(id) {
    const g = gen;
    const back = '<a class="back" href="#/harness">‹ 하네스</a>';
    view.innerHTML = `${back}<section class="card"><div class="empty">불러오는 중이에요</div></section>`;
    let f;
    try { f = await api('GET', `/api/harness/file/${id}`); } catch (e) { if (g === gen) view.innerHTML = `${back}<section class="card"><p>${esc(e.message)}</p></section>`; return; }
    if (g !== gen) return;
    let original = f.text.replace(/\r\n/g, '\n');
    view.innerHTML = `
      ${back}
      <section class="card">
        <div class="detail-title">${esc(f.label)}</div>
        <p class="desc">${esc(f.desc)}</p>
        <div class="ask">
          <textarea id="ask" rows="2" maxlength="2000" placeholder="Claude에게 고쳐 달라고 하기. 예: 첨부 파일이 없으면 구현하지 말고 바로 멈추게 해줘" aria-label="Claude에게 보낼 수정 요청"></textarea>
          <button class="btn soft" id="propose">제안받기</button>
        </div>
        <div id="ai-note"></div>
        <textarea class="editor" id="editor" spellcheck="false" aria-label="${esc(f.label)} 내용"></textarea>
        <div class="editor-bar">
          <span class="desc" id="delta">바꾼 내용이 없어요</span>
          <button class="btn main" id="save" disabled>저장하기</button>
        </div>
      </section>
      <section class="card" id="diff-card" hidden><h2>바뀐 부분</h2><pre class="log diff" id="diff"></pre></section>`;
    const ta = document.getElementById('editor');
    const save = document.getElementById('save');
    const delta = document.getElementById('delta');
    const ask = document.getElementById('ask');
    const propose = document.getElementById('propose');
    const note = document.getElementById('ai-note');
    ta.value = original;
    const drawDiff = () => {
      const ops = dirty ? diffLines(original, ta.value) : null;
      document.getElementById('diff-card').hidden = !ops;
      if (!ops) return;
      document.getElementById('diff').innerHTML = ops.map(([t, l]) =>
        (t === '…' ? '<span class="d-skip">⋯</span>' : `<span class="${t === '+' ? 'd-add' : t === '-' ? 'd-del' : ''}">${t} ${esc(l)}</span>`)).join('');
    };
    const sync = () => {
      dirty = ta.value !== original;
      save.disabled = !dirty;
      const d = lineDelta(original, ta.value);
      delta.textContent = dirty ? `${d.added}줄 추가, ${d.removed}줄 삭제` : '바꾼 내용이 없어요';
      clearTimeout(sync.t);
      sync.t = setTimeout(drawDiff, 300);
    };
    ta.oninput = sync;
    propose.onclick = async () => {
      if (!ask.value.trim()) { toast('어떻게 고칠지 적어 주세요'); ask.focus(); return; }
      propose.disabled = true; ask.disabled = true;
      propose.textContent = '고치는 중이에요…';
      note.innerHTML = '<div class="notice info">Claude가 고치고 있어요. 30초쯤 걸려요. 저장은 직접 눌러야 돼요.</div>';
      try {
        const p = await api('POST', '/api/harness/ai/propose', { id, request: ask.value, text: ta.value });
        if (g !== gen) { toast('Claude 제안이 도착했지만 화면을 떠나서 버렸어요'); return; }
        if (p.changed) { ta.value = p.text; sync(); }
        note.innerHTML = `
          <div class="notice ${p.problem ? '' : 'info'}">
            <b>${p.changed ? 'Claude의 제안을 편집기에 넣었어요. 아직 저장하지 않았어요.' : 'Claude가 바꾸지 않았어요.'}</b>
            <p>${esc(p.explanation)}</p>
            ${p.problem ? `<p>이대로는 저장할 수 없어요. ${esc(p.problem)}</p>` : ''}
            ${p.changed ? '<button class="btn sub small" id="undo-ai">원래대로</button>' : ''}
          </div>`;
        const undo = document.getElementById('undo-ai');
        if (undo) undo.onclick = () => { ta.value = original; sync(); note.innerHTML = ''; };
      } catch (e) {
        if (g === gen) note.innerHTML = `<div class="notice">${esc(e.message)}</div>`;
      } finally {
        propose.disabled = false; ask.disabled = false;
        propose.textContent = '제안받기';
      }
    };
    if (handoff && handoff.id === id) { ask.value = handoff.request; handoff = null; }
    ta.onkeydown = e => {
      if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.altKey) return; // Tab 은 들여쓰기로 쓴다
      e.preventDefault();
      ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
      sync();
    };
    save.onclick = async () => {
      const d = lineDelta(original, ta.value);
      if (!await confirmSheet(`${f.label}을 저장할까요?`, `${d.added}줄을 더하고 ${d.removed}줄을 뺐어요. 다음 실행부터 적용되고, 변경 기록에서 되돌릴 수 있어요.`, '저장하기')) return;
      try {
        f = await api('PUT', `/api/harness/file/${id}`, { text: ta.value, baseHash: f.hash });
        original = f.text.replace(/\r\n/g, '\n');
        if (g === gen) { ta.value = original; sync(); }
        toast('저장했어요');
      } catch (e) { toast(e.message); }
    };
  }

  window.addEventListener('beforeunload', e => { if (dirty) e.preventDefault(); });

  // ---------- 라우터 ----------
  let shown = location.hash; // 지금 화면의 주소. 저장 안 한 내용이 있으면 이 주소로 되돌린다

  function route() {
    if (dirty && location.hash !== shown) {
      const target = location.hash;
      history.replaceState(null, '', shown || '#/');
      confirmSheet('저장하지 않고 나갈까요?', '고친 내용이 사라져요.', '나가기').then(ok => {
        if (!ok) return;
        dirty = false;
        location.hash = target;
      });
      return;
    }
    shown = location.hash;
    dirty = false;
    gen++;
    stopLive();
    const h = location.hash.replace(/^#/, '') || '/';
    const m = /^\/runs\/(\d+)$/.exec(h);
    const e = /^\/harness\/([a-z-]+)$/.exec(h);
    const tab = h === '/' ? 'home' : h.startsWith('/runs') ? 'runs' : h.startsWith('/harness') ? 'harness' : 'settings';
    document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
    window.scrollTo(0, 0);
    if (m) detail(m[1]);
    else if (e) harnessEdit(e[1]);
    else if (h === '/runs') runs();
    else if (h === '/harness') harness();
    else if (h === '/settings') settings();
    else home();
  }
  window.addEventListener('hashchange', route);
  route();
})();
