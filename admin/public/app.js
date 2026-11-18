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

  // 토스트: popover="manual" 로 띄우고, 화면 읽기 프로그램에는 ariaNotify(없으면 숨긴 live 영역)로 알린다
  const toastEl = document.getElementById('toast');
  const sheet = document.getElementById('sheet');
  let pendingToast = null; // 확인 시트가 열려 있는 동안 온 알림은 시트가 닫힌 뒤에 보여준다
  function toast(msg) {
    if (sheet.open) { pendingToast = msg; return; }
    toastEl.textContent = msg;
    if (!toastEl.matches(':popover-open')) toastEl.showPopover();
    if (typeof document.ariaNotify === 'function') document.ariaNotify(msg);
    else { const live = document.getElementById('announce'); live.textContent = ''; setTimeout(() => { live.textContent = msg; }, 50); }
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { if (toastEl.matches(':popover-open')) toastEl.hidePopover(); }, 2600);
  }

  // 확인 시트: 네이티브 <dialog>. Esc · 뒤로가기 · 바깥 누르기(closedby="any")로 닫히고, 포커스는 브라우저가 돌려준다
  let sheetResolve = null;
  sheet.addEventListener('close', () => {
    const ok = sheet.returnValue === 'ok';
    sheet.returnValue = ''; // Esc 로 닫으면 값이 안 바뀌어서 이전 값이 남을 수 있다
    const r = sheetResolve; sheetResolve = null;
    if (r) r(ok);
    if (pendingToast) { const m = pendingToast; pendingToast = null; toast(m); }
  });
  // closedby 를 모르는 브라우저(Safari)용: 누르고 뗀 곳이 모두 시트 바깥이면 닫는다
  if (!('closedBy' in HTMLDialogElement.prototype)) {
    const outside = e => { const r = sheet.getBoundingClientRect(); return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom; };
    let pressedOutside = false;
    sheet.addEventListener('pointerdown', e => { pressedOutside = outside(e); });
    sheet.addEventListener('pointerup', e => { if (pressedOutside && outside(e)) sheet.close(); });
  }

  function confirmSheet(title, desc, okLabel) {
    // 이미 열려 있던 질문은 '아니오'로 끝내고 같은 시트에 새 질문을 띄운다 (close 이벤트는 나중에 오므로 직접 끝낸다)
    if (sheetResolve) { const r = sheetResolve; sheetResolve = null; r(false); }
    return new Promise(resolve => {
      document.getElementById('sheet-title').textContent = title;
      document.getElementById('sheet-desc').textContent = desc;
      document.getElementById('sheet-ok').textContent = okLabel;
      sheet.returnValue = '';
      sheetResolve = resolve;
      if (!sheet.open) sheet.showModal();
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
    pushed: ['완료', 'good'], modified: ['완료', 'good'], unchanged: ['해당 없음', 'good'], blocked: ['확인 필요', 'warn'],
    failed: ['실패', 'bad'], 'no-result': ['결과 없음', ''],
  };
  const badge = s => { const [label, cls] = STATUS[s] || [s, '']; return `<span class="badge ${cls}">${esc(label)}</span>`; };
  const modeText = m => (m === 'new' ? '신규 개발' : m === 'feedback' ? '추가요청' : m === 'mobile' ? '모바일 반영' : m);

  const runRow = r => `
    <a class="row" href="#/runs/${r.id}">
      ${badge(r.status)}
      <div class="row-main">
        <div class="row-title">${esc(r.title)}</div>
        <div class="row-sub">${esc(r.ticket)} · ${esc(modeText(r.mode))} · ${esc(when(r.time))}${r.questionCount ? ` · 질문 ${r.questionCount}개` : ''}</div>
      </div>
      ${ICON_NEXT}
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

  // ---------- 테마 (기본 다크 · 라이트 · 시스템) ----------
  // <meta name="color-scheme"> 값이 곧 테마다. 저장값이 없으면 다크. theme.js 가 첫 화면 전에 같은 값을 넣는다.
  const SCHEME_KEY = 'color-scheme';
  const schemeMeta = document.querySelector('meta[name="color-scheme"]');
  const sysDark = matchMedia('(prefers-color-scheme: dark)');
  const savedScheme = () => { try { return localStorage.getItem(SCHEME_KEY); } catch (e) { return null; } };
  const schemeMode = () => (schemeMeta.content === 'light' ? 'light' : schemeMeta.content === 'light dark' ? 'system' : 'dark');
  const renderedScheme = () => { const m = schemeMode(); return m === 'system' ? (sysDark.matches ? 'dark' : 'light') : m; };
  function setScheme(mode) { // 'dark' | 'light' | 'system'
    const v = mode === 'light' ? 'light' : mode === 'system' ? 'light dark' : null;
    try { if (v) localStorage.setItem(SCHEME_KEY, v); else localStorage.removeItem(SCHEME_KEY); } catch (e) { /* 저장 못 해도 화면엔 적용 */ }
    // 테마 바꿀 때 화면 전체를 부드럽게 교차 페이드 (지원 브라우저만, 모션 줄이기면 바로 바꾼다)
    const apply = () => { schemeMeta.content = v || 'dark'; if (location.hash === '#/settings') drawThemeCard(); };
    if (document.startViewTransition && !reduceMotion.matches) document.startViewTransition(apply);
    else apply();
  }
  // 메뉴를 누르면 펼친 패널을 접는다. 마우스가 메뉴 밖으로 나가면 다시 펼칠 수 있게 풀어 준다
  const rail = document.getElementById('tabs');
  rail.addEventListener('click', e => { if (e.target.closest('a')) rail.classList.add('rail-hold'); });
  rail.addEventListener('pointerleave', () => rail.classList.remove('rail-hold'));
  rail.addEventListener('keydown', () => rail.classList.remove('rail-hold'));

  document.getElementById('theme-toggle').onclick =() => setScheme(renderedScheme() === 'dark' ? 'light' : 'dark');
  window.addEventListener('storage', e => {
    if (e.key !== SCHEME_KEY) return;
    schemeMeta.content = e.newValue === 'light' || e.newValue === 'light dark' ? e.newValue : 'dark';
    if (location.hash === '#/settings') drawThemeCard();
  });
  sysDark.addEventListener('change', () => { if (location.hash === '#/settings') drawThemeCard(); });

  // ---------- 상태 칩 (위쪽 바) ----------
  function setChip(state) {
    const chip = document.getElementById('status-chip');
    const [label] = HERO[state] || ['확인 중'];
    chip.innerHTML = `<span class="dot ${esc(state)}"></span><span>봇 ${esc(label)}</span>`;
  }
  async function refreshChip() {
    if (location.hash === '' || location.hash === '#/') return; // 홈은 refreshHome 이 같이 갱신한다
    try { setChip((await api('GET', '/api/status')).state); } catch (e) { /* 다음에 다시 */ }
  }
  setInterval(refreshChip, 15000);

  // ---------- 위쪽 검색: 실행 내역을 찾는다 ----------
  document.getElementById('top-search').onsubmit = e => {
    e.preventDefault();
    filter.q = document.getElementById('top-q').value;
    if (location.hash === '#/runs') runs(); else location.hash = '#/runs';
  };

  // ---------- 날짜 · 실행 집계 ----------
  const DAY = 864e5;
  const dayKey = d => { const x = new Date(d); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
  const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const toneOf = s => (s === 'pushed' || s === 'modified' || s === 'unchanged' ? 'good' : s === 'blocked' ? 'warn' : s === 'failed' ? 'bad' : 'none');
  const durMs = r => (r.start ? Date.parse(r.time) - Date.parse(r.start) : null);
  function durText(ms) {
    if (ms == null || !(ms >= 0)) return '';
    const m = Math.max(1, Math.round(ms / 60000));
    return m >= 60 ? `${Math.floor(m / 60)}시간${m % 60 ? ` ${m % 60}분` : ''}` : `${m}분`;
  }
  // 오늘까지 n일 동안 하루별로 조건에 맞는 실행 수
  function perDay(runsList, n, pick) {
    const today = startOfDay(Date.now()).getTime();
    const out = new Array(n).fill(0);
    runsList.forEach(r => {
      if (!pick(r)) return;
      const i = n - 1 - Math.round((today - startOfDay(r.time).getTime()) / DAY);
      if (i >= 0 && i < n) out[i]++;
    });
    return out;
  }
  // 최근 n주(월요일 시작) 주별 실행 수
  function perWeek(runsList, n) {
    const monday = startOfDay(Date.now());
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const starts = Array.from({ length: n }, (_, i) => { const d = new Date(monday); d.setDate(d.getDate() - (n - 1 - i) * 7); return d; });
    const counts = new Array(n).fill(0);
    runsList.forEach(r => {
      const t = Date.parse(r.time);
      for (let i = n - 1; i >= 0; i--) if (t >= starts[i].getTime()) { if (i < n - 1 || t < starts[i].getTime() + 7 * DAY) counts[i]++; break; }
    });
    return { counts, labels: starts.map(d => `${d.getMonth() + 1}/${d.getDate()}`) };
  }

  // ---------- 차트 (SVG). 색은 CSS class 로 받아서 테마를 따라간다 ----------
  const niceMax = v => { if (v <= 4) return 4; const p = 10 ** Math.floor(Math.log10(v)); return Math.ceil(v / p * 2) / 2 * p; };

  // 차트 애니메이션 (참고 영상): 선은 왼쪽부터 그려지고, 막대·막대사탕은 아래에서 자라고, 게이지·링은 이전 값에서 채워진다.
  // 순서용 data-i 는 playEnter 가 --i 로 옮긴다 (CSP 때문에 style 속성은 못 쓴다)
  function sparkline(vals, label, tone = '') {
    const max = Math.max(1, ...vals);
    const pts = vals.map((v, i) => [vals.length > 1 ? i / (vals.length - 1) * 156 + 2 : 80, 46 - v / max * 38]);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
    const last = pts[pts.length - 1];
    return `<svg viewBox="0 0 160 52" role="img" aria-label="${esc(label)}">
      <path d="${line}" pathLength="1" class="c-line ${tone}"/>
      <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3.2" class="c-point ${tone}"/>
    </svg>`;
  }

  function lollipop(vals, label) {
    const max = Math.max(...vals);
    const step = 152 / Math.max(1, vals.length - 1);
    return `<svg viewBox="0 0 160 52" role="img" aria-label="${esc(label)}">${vals.map((v, i) => {
      const x = (4 + i * step).toFixed(1);
      if (!v) return `<circle cx="${x}" cy="47" r="2" class="c-zero"/>`;
      const y = (46 - v / Math.max(1, max) * 34).toFixed(1);
      const hi = v === max ? ' hi' : '';
      return `<line x1="${x}" y1="48" x2="${x}" y2="${y}" class="c-stick${hi}" data-i="${i}"/><circle cx="${x}" cy="${y}" r="3.4" class="c-knob${hi}" data-i="${i}"/>`;
    }).join('')}</svg>`;
  }

  // 비율 표시: 큰 숫자 + 가로 막대. key 가 있으면 다시 그릴 때 이전 값에서 움직인다 (applyGauges)
  function gauge(pct, key, label, big, small, count) {
    const p = pct == null ? 0 : Math.max(0, Math.min(100, pct));
    const num = count != null ? `<b data-count="${count}" data-suffix="%" data-key="${esc(key)}">${esc(big)}</b>` : `<b>${esc(big)}</b>`;
    return `<div class="meter">
      <div class="meter-num">${num}${small ? `<span>${esc(small)}</span>` : ''}</div>
      <div class="meter-track" role="img" aria-label="${esc(label)} ${pct == null ? '정보 없음' : `${Math.round(p)}%`}"><i class="meter-fill c-anim" data-key="${esc(key)}" data-to="${p}"></i></div>
    </div>`;
  }

  // data-to 를 가진 막대(비율 막대·결과 막대)를 이전 값에서 새 값으로 늘리거나 줄인다
  const gaugeLast = {}; // key 별 마지막 값
  function applyGauges() {
    const arcs = view.querySelectorAll('.c-anim[data-to]');
    if (!arcs.length) return;
    arcs.forEach(a => { a.style.width = `${gaugeLast[a.dataset.key] || 0}%`; });
    void arcs[0].getBoundingClientRect(); // 시작 값을 먼저 반영해야 transition 이 걸린다
    arcs.forEach(a => {
      const to = Number(a.dataset.to);
      a.style.width = `${to}%`;
      gaugeLast[a.dataset.key] = to;
    });
  }

  // 숫자 카운트업 (참고 영상: 0% → 68%, 23.8 → 24.1). 이전 값에서 새 값까지 올라가거나 내려간다
  const countLast = {};
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  function countUp() {
    view.querySelectorAll('[data-count]').forEach(el => {
      const to = Number(el.dataset.count);
      const key = el.dataset.key;
      const from = key in countLast ? countLast[key] : 0;
      countLast[key] = to;
      const suffix = el.dataset.suffix || '';
      if (from === to || reduceMotion.matches) { el.textContent = `${to}${suffix}`; return; }
      const t0 = performance.now();
      const dur = 900;
      el.textContent = `${from}${suffix}`;
      const tick = now => {
        if (!el.isConnected) return;
        const k = Math.min(1, (now - t0) / dur);
        const e = 1 - (1 - k) ** 3; // ease-out
        el.textContent = `${Math.round(from + (to - from) * e)}${suffix}`;
        if (k < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  // 결과 비율: 한 줄 누적 막대 (완료 · 확인 필요 · 실패)
  function mixBar(parts, total) {
    return `<div class="stack" aria-hidden="true">${total ? parts.filter(p => p.n).map(p =>
      `<i class="sw-${p.tone} c-anim" data-key="mix-${p.tone}" data-to="${(p.n / total * 100).toFixed(1)}"></i>`).join('') : ''}</div>`;
  }

  // 주별 막대 (참고: Harvest Forecast) — 이번 주만 강조색, 마우스를 올리면 그 막대가 강조색으로 바뀌고 값 말풍선이 뜬다
  function bars(vals, labels, label) {
    const W = 340, H = 180, L = 26, B = 22, T = 6;
    const max = niceMax(Math.max(1, ...vals));
    const slot = (W - L) / vals.length;
    const bw = Math.min(16, slot * 0.46);
    const y = v => T + (H - T - B) * (1 - v / max);
    const grid = [0, max / 2, max].map(v => `<text x="${L - 8}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" class="c-axis">${Math.round(v * 10) / 10}</text>`).join('');
    const body = vals.map((v, i) => {
      const x = L + slot * i + (slot - bw) / 2;
      const cur = i === vals.length - 1;
      const top = y(v);
      const h = Math.max(bw, H - B - top);
      const tip = `${labels[i]}주 · ${v}건`;
      const tw = tip.length * 5.6 + 14;
      const tx = Math.min(W - tw, Math.max(0, x + bw / 2 - tw / 2));
      const ty = Math.max(0, (v ? H - B - h : H - B) - 28);
      const rect = cls => `<rect x="${x.toFixed(1)}" y="${(H - B - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="${(bw / 2).toFixed(1)}" class="${cls}" data-i="${i}"`;
      return `<g class="bar-g${cur ? ' cur' : ''}">
        <rect x="${(L + slot * i).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${H - B}" class="c-hit"/>
        <rect x="${x.toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${(H - B - T).toFixed(1)}" rx="${(bw / 2).toFixed(1)}" class="c-bar-bg"/>
        ${v ? `${rect('c-bar-v')}/>${rect('c-bar-v c-bar-hi')}/>` : ''}
        ${(vals.length - 1 - i) % 2 === 0 ? `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="c-axis">${esc(labels[i])}</text>` : ''}
        <g class="c-tip"><rect x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" width="${tw.toFixed(1)}" height="20" rx="10"/><text x="${(tx + tw / 2).toFixed(1)}" y="${(ty + 13.5).toFixed(1)}" text-anchor="middle">${esc(tip)}</text></g>
      </g>`;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${grid}${body}</svg>`;
  }

  // 화면에 처음 들어올 때만 카드·목록·차트가 차례로 들어온다 (5초 갱신 때는 다시 하지 않는다)
  let pendingEnter = false;
  function playEnter() {
    view.querySelectorAll('[data-i]').forEach(el => el.style.setProperty('--i', el.dataset.i));
    if (!pendingEnter) return;
    pendingEnter = false;
    // 화면 위치 순서(위→아래, 왼→오)로 번호를 매긴다. HTML 순서대로면 오른쪽 위 카드가 왼쪽 아래보다 늦게 떠서 어색하다
    const blocks = [...view.querySelectorAll('.card, .filters, .back')].map(el => ({ el, r: el.getBoundingClientRect() }));
    blocks.sort((a, b) => (Math.round(a.r.top / 60) - Math.round(b.r.top / 60)) || (a.r.left - b.r.left));
    blocks.forEach((b, n) => b.el.style.setProperty('--i', Math.min(n, 8)));
    view.querySelectorAll('.scroll-list, #list, .pins').forEach(list => {
      [...list.children].forEach((el, i) => el.style.setProperty('--j', Math.min(i, 10)));
    });
    view.querySelectorAll('.tl').forEach(tl => tl.querySelectorAll('.tl-bar').forEach((el, i) => el.style.setProperty('--j', Math.min(i, 16))));
    view.classList.add('enter');
    clearTimeout(playEnter.t);
    playEnter.t = setTimeout(() => view.classList.remove('enter'), 2400);
  }

  const ICON_OUT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 16 16 8M9 8h7v7"/></svg>';
  const ICON_NEXT = '<svg class="row-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6"/></svg>';
  const ICON_BACK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg>';
  // 아바타 글자: 티켓 번호 끝 두 자리 (R-2026-0113 → 13)
  const initials = s => (String(s || '').replace(/[^A-Za-z0-9가-힣]/g, '').slice(-2).toUpperCase() || '?');

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

  function drawHome(s, runList) {
    const [label, title] = HERO[s.state];
    const on = s.task.enabled;
    setChip(s.state);
    const all = runList || [];
    const isDoneRun = r => toneOf(r.status) === 'good';
    const today = perDay(all, 1, isDoneRun)[0];
    const done14 = perDay(all, 14, isDoneRun);
    const blocked7 = perDay(all, 7, r => r.status === 'blocked');
    const failed14 = perDay(all, 14, r => toneOf(r.status) === 'bad' || r.status === 'no-result');
    const since30 = Date.now() - 30 * DAY;
    const last30 = all.filter(r => Date.parse(r.time) >= since30);
    const done30 = last30.filter(isDoneRun).length;
    const rate = last30.length ? Math.round(done30 / last30.length * 100) : null;
    const parts = [
      { name: '완료', tone: 'good', n: done30 },
      { name: '확인 필요', tone: 'warn', n: last30.filter(r => r.status === 'blocked').length },
      { name: '실패', tone: 'bad', n: last30.filter(r => toneOf(r.status) === 'bad' || r.status === 'no-result').length },
    ];
    const weeks = perWeek(all, 12);
    const work = s.worklist || [];
    const pinOf = w => {
      const tone = w.queued ? '' : w.hold === 'blocked' ? 'warn' : w.hold ? 'bad' : toneOf(w.lastStatus);
      const state = w.queued ? '대기열' : w.hold === 'blocked' ? '답변 대기' : w.hold ? '재시도 중단' : w.lastStatus ? STATUS[w.lastStatus] ? STATUS[w.lastStatus][0] : w.lastStatus : '미실행';
      return `<span class="pin ${w.queued ? 'hot' : ''}"><span class="dot ${tone}"></span>${esc(w.releaseId || `No ${w.no}`)}<span class="pin-sub">· ${esc(state)}</span></span>`;
    };

    view.innerHTML = `
      <div class="bento home">
        <!-- 1줄: 지금 상태 + 진행 중/마지막 실행 -->
        <section class="card hero-panel h-hero">
          <div class="hero">
            <div class="hero-state"><span class="dot ${s.state}"></span>${esc(label)}</div>
            <button class="toggle" id="toggle" role="switch" aria-checked="${on}" aria-label="봇 켜기·끄기"></button>
          </div>
          <div class="hero-title">${esc(title)}</div>
          <div class="hero-sub">${esc(heroSub(s))}</div>
          ${s.warnings.map(w => `<div class="notice">${esc(w)}</div>`).join('')}
          <div class="hero-actions">
            <button class="btn main" id="run" ${on && s.state !== 'running' ? '' : 'disabled'}>지금 실행</button>
            <a class="btn sub link" href="#/runs">실행 내역</a>
          </div>
          <div class="hero-foot">
            <div class="foot-label">작업 목록 ${work.length}건${s.pending ? ` · 대기열 ${s.pending}건` : ''}</div>
            ${work.length ? `<div class="pins">${work.slice(0, 8).map(pinOf).join('')}${work.length > 8 ? `<span class="pin"><span class="pin-sub">외 ${work.length - 8}건</span></span>` : ''}</div>`
              : '<p class="desc mt8">아직 알림으로 들어온 일감이 없어요</p>'}
          </div>
        </section>
        <section class="card h-now" id="order-card">${orderCard(s, all)}</section>
        ${s.state === 'running' ? '<section class="card h-full"><h2>진행 로그</h2><pre class="log" id="progress"></pre></section>' : ''}

        <!-- 2줄: 지표 -->
        <section class="card h-full">
          <div class="card-head"><h2>봇 개요</h2><a class="round-link" href="#/runs" aria-label="실행 내역 보기">${ICON_OUT}</a></div>
          <div class="tiles tiles-row">
            <a class="tile" href="#/runs" data-f="done">
              <div class="tile-label">최근 7일 완료</div>
              <div class="tile-value"><b data-count="${s.week.done}" data-key="k-done">${s.week.done}</b><small>건</small>${today ? `<span class="tile-tag good">오늘 ${today}</span>` : ''}</div>
              <div class="tile-chart">${sparkline(done14, `최근 14일 하루별 완료 ${done14.join(', ')}`)}</div>
            </a>
            <a class="tile" href="#/runs" data-f="blocked">
              <div class="tile-label">확인 필요</div>
              <div class="tile-value"><b data-count="${s.attention.length}" data-key="k-att">${s.attention.length}</b><small>건</small>${s.week.blocked ? `<span class="tile-tag warn">7일 ${s.week.blocked}</span>` : ''}</div>
              <div class="tile-chart">${lollipop(blocked7, `최근 7일 하루별 확인 필요 ${blocked7.join(', ')}`)}</div>
            </a>
            <a class="tile" href="#/runs" data-f="failed">
              <div class="tile-label">실패 · 7일</div>
              <div class="tile-value"><b data-count="${s.week.failed}" data-key="k-fail">${s.week.failed}</b><small>건</small>${s.week.failed ? '<span class="tile-tag bad">확인</span>' : '<span class="tile-tag good">없음</span>'}</div>
              <div class="tile-chart">${sparkline(failed14, `최근 14일 하루별 실패 ${failed14.join(', ')}`, 'bad')}</div>
            </a>
            <div class="tile">
              <div class="tile-label">완료율 · 30일</div>
              ${gauge(rate, 'rate30', '최근 30일 완료율', rate == null ? '-' : `${rate}%`, `${done30}/${last30.length}`, rate)}
            </div>
          </div>
        </section>

        <!-- 3줄: 처리할 일 -->
        <section class="card flush h-half">
          <div class="card-head"><div><h2>확인이 필요한 일감</h2></div>${s.attention.length ? '<a class="desc" href="#/runs" data-f="blocked">모두 보기</a>' : ''}</div>
          <div class="scroll-list">
          ${s.attention.length ? s.attention.map(r => `
            <a class="row" href="#/runs/${r.id}">
              <span class="avatar ${toneOf(r.status)}" aria-hidden="true">${esc(initials(r.ticket))}</span>
              <div class="row-main">
                <div class="row-title">${esc(r.title)}</div>
                <div class="row-sub">${esc(r.ticket)} · ${esc(STATUS[r.status] ? STATUS[r.status][0] : r.status)}${r.questionCount ? ` · 질문 ${r.questionCount}개` : ''}</div>
              </div>
              <span class="row-time">${esc(when(r.time))}</span>
            </a>`).join('') : '<div class="empty">지금은 확인할 일감이 없어요</div>'}
          </div>
        </section>

        <section class="card flush h-half">
          <div class="card-head"><div><h2>작업 목록</h2><span class="desc">매 회차 시트에서 P열 O · S열 X 인지 다시 확인해요</span></div></div>
          <div class="scroll-list">
          ${work.length ? work.map(workRow).join('') : '<div class="empty">아직 알림으로 들어온 일감이 없어요</div>'}
          </div>
        </section>

        <!-- 4줄: 통계 -->
        <section class="card h-third">
          <div class="card-head"><div><h2>결과 비율</h2><span class="desc">최근 30일 실행 결과</span></div></div>
          <div class="mix">
            <div class="mix-total"><b data-count="${last30.length}" data-key="k-runs">${last30.length}</b><span>번 실행</span></div>
            ${mixBar(parts, last30.length)}
            <ul class="legend">${parts.map(p => `
              <li><div class="l-name"><i class="sw-${p.tone}"></i>${p.name}</div>
              <div class="l-val"><span data-count="${last30.length ? Math.round(p.n / last30.length * 100) : 0}" data-suffix="%" data-key="mix-${p.tone}">${last30.length ? Math.round(p.n / last30.length * 100) : 0}%</span><small>${p.n}건</small></div></li>`).join('')}
            </ul>
          </div>
        </section>

        <section class="card h-third">
          <div class="card-head"><div><h2>주간 처리량</h2><span class="desc">주별 실행 수, 이번 주 강조</span></div><span class="pill-label">최근 12주</span></div>
          <div class="bars">${bars(weeks.counts, weeks.labels, `최근 12주 주별 실행 수 ${weeks.counts.join(', ')}`)}</div>
        </section>

        ${usageCard(s.usage, 'h-third')}
      </div>`;

    document.getElementById('toggle').onclick = () => toggleBot(s);
    document.getElementById('run').onclick = runNow;
    document.getElementById('usage-refresh').onclick = refreshUsage;
    view.querySelectorAll('[data-f]').forEach(a => { a.onclick = () => { filter.status = a.dataset.f; }; });
    applyUsageColors();
    applyGauges();
    countUp();
    playEnter();
    if (s.state === 'running') openProgress();
    else if (stream) { stream.close(); stream = null; }
  }

  // 지금 하는 일 (참고: Harvest order 카드). 실행 중이면 할일 진행, 아니면 마지막 실행
  const segLast = { title: '', done: 0 }; // 진행 칸: 이미 채워진 칸은 다시 움직이지 않는다
  function orderCard(s, all) {
    const p = s.progress;
    if (s.state === 'running') {
      if (!p) return `<h2>진행 중인 일감</h2><div class="order-title">일감을 준비하고 있어요</div><p class="desc mt8">요청서를 만들고 Claude를 띄우는 중이에요.</p>`;
      const total = p.total;
      const n = Math.min(total, 12);
      const doneSeg = total ? Math.floor(p.done / total * n) : 0;
      const prev = segLast.title === p.title ? segLast.done : 0;
      segLast.title = p.title; segLast.done = doneSeg;
      const segs = Array.from({ length: n }, (_, i) => `<i class="${i < doneSeg ? `on${i >= prev ? ' fresh' : ''}` : i === doneSeg ? 'now' : ''}" data-i="${Math.max(0, i - prev)}"></i>`).join('');
      return `
        <div class="order-top">
          <div><h2>진행 중인 일감</h2><div class="order-title">${esc(p.title)}</div></div>
          <span class="avatar" aria-hidden="true">봇</span>
        </div>
        ${total ? `
          <div class="seg-head"><span>할일 ${p.done}/${total}</span><span data-count="${Math.round(p.done / total * 100)}" data-suffix="%" data-key="seg-pct">${Math.round(p.done / total * 100)}%</span></div>
          <div class="segbar" role="progressbar" aria-label="할일 진행" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${p.done}">${segs}</div>
          ${p.current ? `<div class="order-now">진행 중: ${esc(p.current)}</div>` : ''}`
          : '<p class="desc mt8">Claude가 할일 목록을 아직 만들지 않았어요.</p>'}`;
    }
    const last = all[all.length - 1];
    if (!last) return '<h2>마지막 실행</h2><div class="empty">아직 실행한 적이 없어요</div>';
    const d = durText(durMs(last));
    return `
      <div class="order-top">
        <div><h2>마지막 실행</h2><div class="order-title">${esc(last.title)}</div></div>
        <a class="round-link" href="#/runs/${last.id}" aria-label="마지막 실행 자세히 보기">${ICON_OUT}</a>
      </div>
      <div class="meta-row">${badge(last.status)}<span class="desc">${esc(last.ticket)} · ${esc(when(last.time))}${d ? ` · ${esc(d)} 걸림` : ''}</span></div>`;
  }

  // ---------- Claude 사용량 ----------
  const USAGE_SOURCE = { bot: '봇 실행 기록', probe: '지금 확인' };
  let usageAutoTried = false; // 기록이 하나도 없을 때만, 페이지당 한 번 자동으로 확인한다

  function usageGauge(label, key, w) {
    if (!w) return `<div class="gauge-box"><div class="gauge-label">${esc(label)}</div>${gauge(null, key, label, '-', '사용')}<div class="meter-sub">정보 없음</div></div>`;
    // 사용률만큼 채운다: 쓸수록 늘어나고, 한도가 초기화되면 줄어든다
    const used = Math.max(0, Math.min(100, w.usedPercent));
    const left = Math.round((100 - used) * 10) / 10;
    return `
      <div class="gauge-box" data-used="${used}">
        <div class="gauge-label">${esc(label)}</div>
        ${gauge(used, key, `${label} 사용률`, `${Math.round(used)}%`, '사용', Math.round(used))}
        <div class="meter-sub">${left}% 남음 · ${esc(when(w.resetsAt))} 초기화</div>
      </div>`;
  }

  // 사용률 → 색: 0% 초록 → 50% 주황 → 100% 빨강 (테마 색을 섞어 라이트·다크 모두 맞게)
  function usageColor(used) {
    if (used <= 50) return `color-mix(in oklab, var(--warn) ${Math.round(used * 2)}%, var(--good))`;
    return `color-mix(in oklab, var(--bad) ${Math.round((used - 50) * 2)}%, var(--warn))`;
  }
  // CSP 때문에 HTML 의 style 속성은 무시된다 → JS 로 넣는다
  function applyUsageColors() {
    view.querySelectorAll('.gauge-box[data-used]').forEach(b => b.style.setProperty('--g-color', usageColor(Number(b.dataset.used))));
  }

  function usageCard(u, place = 'span-4') {
    const snap = u && u.snapshot;
    const checking = u && u.checking;
    const sub = snap ? `${esc(when(snap.checkedAt))} 기준 · ${esc(USAGE_SOURCE[snap.source] || snap.source)}` : '아직 확인한 기록이 없어요';
    return `
      <section class="card ${place}">
        <div class="card-head">
          <div><h2>Claude 남은 사용량</h2><span class="desc">${sub}</span></div>
          <button class="btn soft small" id="usage-refresh" ${checking ? 'disabled' : ''}>${checking ? '확인 중…' : '지금 확인'}</button>
        </div>
        ${snap && snap.status === 'rejected' ? '<div class="notice mb8">사용 한도에 도달했어요. 초기화 시각 전까지 봇이 개발을 진행하지 못해요.</div>' : ''}
        <div class="gauges">
          ${usageGauge('5시간 한도', 'u5h', snap && snap.fiveHour)}
          ${usageGauge('7일 한도', 'u7d', snap && snap.sevenDay)}
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
      const [s, rl] = await Promise.all([api('GET', '/api/status'), api('GET', '/api/runs')]);
      if (g !== gen) return;
      const list = rl.runs.slice().reverse(); // 오래된 것 → 최신
      // 진행 상황만 바뀌었으면 그 카드만 다시 그린다 (진행 로그 스크롤이 튀지 않게)
      const key = JSON.stringify(Object.assign({}, s, { progress: null })) + list.length + (list.length ? list[list.length - 1].time : '');
      if (sheet.open) return;
      if (key === lastHome) {
        const card = document.getElementById('order-card');
        if (card) { card.innerHTML = orderCard(s, list); playEnter(); countUp(); }
        return;
      }
      lastHome = key;
      drawHome(s, list);
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
  const groupOf = s => (s === 'pushed' || s === 'modified' || s === 'unchanged' ? 'done' : s === 'blocked' ? 'blocked' : 'failed');
  const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];
  let weekShift = 0; // 0 = 오늘까지 7일, -1 = 그 전 7일 …

  function filteredRuns() {
    const q = filter.q.trim().toLowerCase();
    return runsCache.filter(r => (filter.status === 'all' || groupOf(r.status) === filter.status)
      && (!q || r.ticket.toLowerCase().includes(q) || r.title.toLowerCase().includes(q)));
  }

  // 실행 타임라인 (참고: Maren 예약 간트). 줄 = 일감, 칸 = 날짜, 막대 = 실행 1회
  function drawTimeline(rows) {
    const end = startOfDay(Date.now());
    end.setDate(end.getDate() + weekShift * 7);
    const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(end); d.setDate(d.getDate() - 6 + i); return d; });
    const keys = days.map(dayKey);
    const todayKey = dayKey(Date.now());
    const inWeek = rows.filter(r => keys.includes(dayKey(r.time)));
    const byTicket = new Map();
    inWeek.slice().sort((a, b) => b.id - a.id).forEach(r => {
      if (!byTicket.has(r.ticket)) byTicket.set(r.ticket, { title: r.title, runs: [] });
      byTicket.get(r.ticket).runs.push(r);
    });
    const range = `${days[0].getMonth() + 1}월 ${days[0].getDate()}일 – ${days[6].getMonth() + 1}월 ${days[6].getDate()}일`;
    document.getElementById('tl-range').textContent = `${range} · 일감 ${byTicket.size}개 · 실행 ${inWeek.length}번`;
    document.getElementById('tl-next').disabled = weekShift >= 0;
    const head = `<div></div>${days.map((d, i) => `<div class="tl-day ${keys[i] === todayKey ? 'today' : ''}">${WEEKDAY[d.getDay()]}<b>${d.getDate()}</b></div>`).join('')}`;
    const body = [...byTicket.entries()].map(([ticket, t]) => `
      <div class="tl-name"><span class="avatar ${toneOf(t.runs[0].status)}" aria-hidden="true">${esc(initials(ticket))}</span><div><b>${esc(ticket)}</b><span>${esc(t.title)}</span></div></div>
      ${keys.map(k => `<div class="tl-cell ${k === todayKey ? 'today' : ''}">${t.runs.filter(r => dayKey(r.time) === k).reverse().map(r => {
        const d = durText(durMs(r));
        const label = STATUS[r.status] ? STATUS[r.status][0] : r.status;
        const t0 = new Date(r.start || r.time);
        const text = d || `${pad(t0.getHours())}:${pad(t0.getMinutes())}`;
        return `<a class="tl-bar ${toneOf(r.status)}" href="#/runs/${r.id}" title="${esc(`${r.title} · ${label}${d ? ` · ${d}` : ''}`)}" aria-label="${esc(`${ticket} ${label}, ${when(r.time)}${d ? `, ${d} 걸림` : ''}`)}">${esc(text)}</a>`;
      }).join('')}</div>`).join('')}`).join('');
    document.getElementById('tl').innerHTML = head + (body || '<div class="tl-empty empty">이 기간에는 실행이 없어요</div>');
  }

  function drawRunList() {
    const rows = filteredRuns();
    document.getElementById('list').innerHTML = rows.length ? rows.map(runRow).join('') : '<div class="empty">조건에 맞는 실행이 없어요</div>';
    document.getElementById('count').textContent = `${rows.length}건`;
    drawTimeline(rows);
  }

  async function runs() {
    document.getElementById('top-q').value = filter.q;
    view.innerHTML = `
      <section class="card">
        <div class="card-head">
          <div><h2>실행 타임라인</h2><span class="desc" id="tl-range"></span></div>
          <div class="tl-tools">
            <div class="tl-legend" aria-hidden="true"><span><i class="sw-good"></i>완료</span><span><i class="sw-warn"></i>확인 필요</span><span><i class="sw-bad"></i>실패</span></div>
            <button class="round-link" id="tl-prev" aria-label="이전 7일"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg></button>
            <button class="round-link" id="tl-next" aria-label="다음 7일"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6"/></svg></button>
          </div>
        </div>
        <div class="tl-wrap"><div class="tl" id="tl"><div class="tl-empty empty">불러오는 중이에요</div></div></div>
      </section>
      <div class="filters mt16">
        ${FILTERS.map(([k, l]) => `<button class="chip ${filter.status === k ? 'on' : ''}" data-f="${k}" aria-pressed="${filter.status === k}">${l}</button>`).join('')}
        <input class="search" id="q" type="search" placeholder="티켓번호나 제목으로 찾기" aria-label="티켓번호나 제목으로 찾기" value="${esc(filter.q)}">
      </div>
      <section class="card flush mt16"><div class="card-head"><h2>실행 내역 <span class="desc" id="count"></span></h2></div><div id="list"><div class="empty">불러오는 중이에요</div></div></section>`;
    view.querySelectorAll('.chip').forEach(c => {
      c.onclick = () => {
        filter.status = c.dataset.f;
        view.querySelectorAll('.chip').forEach(x => { x.classList.toggle('on', x === c); x.setAttribute('aria-pressed', x === c); });
        drawRunList();
      };
    });
    document.getElementById('q').oninput = e => { filter.q = e.target.value; document.getElementById('top-q').value = filter.q; drawRunList(); };
    document.getElementById('tl-prev').onclick = () => { weekShift--; drawTimeline(filteredRuns()); };
    document.getElementById('tl-next').onclick = () => { if (weekShift < 0) { weekShift++; drawTimeline(filteredRuns()); } };
    const g = gen;
    try {
      const data = await api('GET', '/api/runs');
      if (g !== gen) return;
      runsCache = data.runs;
      drawRunList();
      playEnter();
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
    view.innerHTML = `<a class="back" href="#/runs">${ICON_BACK}내역</a><section class="card"><div class="empty">불러오는 중이에요</div></section>`;
    const g = gen;
    try {
      const r = await api('GET', `/api/runs/${id}`);
      if (g !== gen) return;
      const mr = /^https?:\/\//.test(r.mr) ? `<section class="card"><h2>MR 만들기</h2><a class="btn soft link" href="${esc(r.mr)}" target="_blank" rel="noopener noreferrer">GitLab에서 열기</a></section>` : '';
      view.innerHTML = `
        <a class="back" href="#/runs">${ICON_BACK}내역</a>
        <section class="card">
          ${badge(r.status)}
          <div class="detail-title">${esc(r.title)}</div>
          <div class="desc">${esc(r.ticket)} · ${esc(modeText(r.mode))}</div>
          <div class="meta-row">
            ${r.start ? `<span class="pill-label">시작 ${esc(when(r.start))}</span>` : ''}
            <span class="pill-label">${r.start ? '종료' : '기록'} ${esc(when(r.time))}</span>
            ${durText(durMs(r)) ? `<span class="pill-label">${esc(durText(durMs(r)))} 걸림</span>` : ''}
          </div>
        </section>
        <section class="card"><h2>요약</h2><p>${esc(r.summary || '요약이 없어요')}</p></section>
        ${listCard('답이 필요한 질문', r.questions)}
        ${mr}
        ${shotCards(r.id, r.shots || [])}
        ${resultCards(r.result, r.changedFiles)}
        ${listCard('메모', r.notes)}
        ${r.hasFolder ? fileCard('요청서', r.request) + fileCard('진행 로그', r.log)
          : '<section class="card"><p class="desc">작업폴더가 정리돼서 요청서와 진행 로그는 볼 수 없어요.</p></section>'}`;
      playEnter();
    } catch (e) {
      if (g !== gen) return;
      view.innerHTML = `<a class="back" href="#/runs">${ICON_BACK}내역</a><section class="card"><p>${esc(e.message)}</p></section>`;
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
        <section class="card" id="theme-card"></section>
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
      view.querySelectorAll('[data-m]').forEach(c => { c.onclick = () => { picked = Number(c.dataset.m); draw(); }; });
      document.getElementById('save').onclick = save;
      drawThemeCard();
      playEnter();
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

  // 화면 테마 (설정): 다크(기본) · 라이트 · 시스템
  function drawThemeCard() {
    const card = document.getElementById('theme-card');
    if (!card) return;
    const mode = schemeMode();
    const opts = [['dark', '다크 (기본)'], ['light', '라이트'], ['system', `시스템 (지금 ${sysDark.matches ? '다크' : '라이트'})`]];
    card.innerHTML = `
      <h2>화면 테마</h2>
      <p class="desc">이 브라우저에만 저장돼요. 위쪽 해·달 버튼으로도 바로 바꿀 수 있어요.</p>
      <div class="seg theme-seg mt16" role="radiogroup" aria-label="화면 테마">${opts.map(([k, l]) =>
        `<button class="chip ${k === mode ? 'on' : ''}" role="radio" aria-checked="${k === mode}" data-scheme="${k}">${esc(l)}</button>`).join('')}</div>`;
    card.querySelectorAll('[data-scheme]').forEach(b => { b.onclick = () => setScheme(b.dataset.scheme); });
  }

  // ---------- 동작 원리 ----------
  // poll.js 한 회차가 하는 일을 그림으로 보여준다. 내용은 코드 기준으로 손으로 적은 것이라,
  // poll.js 흐름(대상 조건·분기·결과 처리)을 바꾸면 여기도 같이 고친다.
  async function flow() {
    const g = gen;
    let every = '정해진 간격';
    try { every = `${(await api('GET', '/api/schedule')).intervalMinutes}분`; } catch (e) { /* 간격 없이 그린다 */ }
    if (g !== gen) return;
    const li = xs => `<ul class="fx-list">${xs.map(x => `<li>${x}</li>`).join('')}</ul>`;
    const steps = [
      ['깨어나기', `작업 스케줄러가 <b>${esc(every)}마다</b> <code>poll.js</code> 실행`, ['lock 으로 중복 실행 막기', '이전 실행이 강제 종료됐으면 알림']],
      ['일감 모으기', 'Google Chat 알림 + 작업 목록', ['요청단계 <b>개발 요청</b> 알림의 번호', '지난 회차에 남은 일감', '처리했던 일감 전체 (추가요청 확인용)']],
      ['대상 고르기', '시트 <b>이력관리</b> 행을 다시 읽음', ['PIGON · WEB 또는 BATCH', '개발담당자가 나', 'P열 알림 <b>O</b> · S열 알림 <b>X</b>']],
      ['신규 / 보완 판단', '변경요청 문서를 읽고 모드 결정', ['브랜치 없음 → <b>신규</b>', '3. 테스트에 새 블록 → <b>보완</b>', '새 내용 없음 → 건너뜀']],
      ['요청서 만들기', '<code>runs/&lt;브랜치&gt;/&lt;시각&gt;-&lt;모드&gt;/</code>', ['첨부 이미지 내려받기', '링크된 Drive·문서 파일 내려받기', '<code>request.md</code> 작성']],
      ['Claude 실행', '<code>claude -p</code> 오케스트레이터', ['작으면 직접, 크면 담당 에이전트에 <b>병렬 위임</b>', '리뷰 에이전트는 항상', '회차당 <b>1건</b>만, 최대 3시간']],
      ['결과 처리', '<code>result.json</code> 상태로 다음 행동 결정', ['스크린샷·변경 파일 보관', 'Chat 으로 알림', '모두 끝나면 완료 알림']],
    ];
    const lanes = [
      ['WEB', 'accent', [['프로젝트', 'pigon_pc (git)'], ['지침', '<code>/ticket-auto</code>'], ['에이전트', 'backend · dba · jsp · e2e · ozreport · reviewer'], ['검증', '빌드 · Tomcat · E2E 스크린샷'], ['끝', '티켓 브랜치 <b>push</b>']], '모바일에도 필요하면 다음 회차에 ↓'],
      ['MOBILE', 'good', [['프로젝트', 'PigOn (SVN)'], ['지침', '<code>mobile-prompt.md</code>'], ['에이전트', 'mobile-backend · sqlmap · jsp · reviewer'], ['입력', '웹 diff + 웹 실행 결과'], ['끝', '로컬 수정까지 (커밋은 개발자)']], 'WEB 반영이 끝난 뒤에만'],
      ['BATCH', 'warn', [['프로젝트', 'AGENT_REPL · CONT · API (SVN)'], ['지침', '<code>batch-prompt.md</code>'], ['에이전트', 'batch-java · sqlmap · reviewer'], ['검증', '컴파일 확인'], ['끝', '로컬 수정까지 (커밋은 개발자)']], '고칠 프로젝트는 Claude 가 코드로 판단'],
    ];
    const results = [
      ['good', '완료', 'pushed · modified', '처리한 블록을 기록하고 끝. WEB 이면 모바일 반영 여부 확인'],
      ['', '해당 없음', 'unchanged', '모바일에 같은 기능이 없거나 영향 없음'],
      ['warn', '확인 필요', 'blocked', '구현 전에 멈추고 질문을 Chat 으로 보냄 → 문서 3. 테스트에 답하면 이어서'],
      ['bad', '실패', 'failed · no-result', '다음 회차에 1번 더. 2번 실패하면 문서가 바뀔 때까지 대기'],
    ];
    const guards = [
      ['중복 실행 방지', 'lock 파일의 PID 가 살아 있으면 이번 회차는 쉼. 8시간 넘으면 멈춘 것으로 봄'],
      ['사람 작업과 안 겹치게', 'WEB 은 실행 전 git merge·rebase 중, 미커밋 변경, 20010 포트 사용 중이면 보류'],
      ['위험한 명령 차단', '<code>bot-guard.js</code>: reset --hard·rebase·브랜치 삭제·svn commit 등 금지, push 는 티켓 브랜치만'],
      ['같은 질문 반복 안 함', '확인 요청·실패 뒤에는 변경요청 문서가 바뀔 때까지 기다림'],
      ['시간 제한', 'Claude 실행 최대 3시간, 결과를 낸 뒤 2분 안에 안 끝나면 강제 종료'],
      ['알림 폭주 방지', '같은 오류 알림은 6시간에 한 번만'],
    ];
    const files = [
      ['poll.js', '폴링 · 분기 · 실행 · 결과 처리 (중심)'],
      ['ticket.js', '시트 행 · 변경요청 문서 읽기'],
      ['notify.js', 'Chat 웹훅 알림 카드'],
      ['bot-guard.js', '명령 차단 훅'],
      ['batch-prompt.md', 'BATCH 작업 지침'],
      ['mobile-prompt.md', '모바일 반영 지침'],
      ['agents/', 'BATCH·모바일 서브에이전트 (실행 전 프로젝트로 복사)'],
      ['was.ps1', '봇 전용 Tomcat 빌드·기동'],
      ['admin/', '지금 보고 있는 관리 웹'],
    ];
    view.innerHTML = `
      <section class="card">
        <div class="card-head"><div><h2>한 번의 폴링</h2><span class="desc">${esc(every)}마다 아래 순서를 한 번 돌아요. 일감마다 2~7을 반복해요.</span></div></div>
        <ol class="fx-steps">${steps.map(([t, s, xs], i) => `
          <li class="fx-step">
            <span class="fx-num" aria-hidden="true">${i + 1}</span>
            <h3>${t}</h3>
            <p class="fx-sub">${s}</p>
            ${li(xs)}
          </li>`).join('')}</ol>
      </section>
      <div class="bento mt16">
        <section class="card span-12">
          <div class="card-head"><div><h2>일감 종류별 경로</h2><span class="desc">시트의 서비스 구분(WEB · BATCH)에 따라 다른 프로젝트와 지침을 써요. 경로마다 그 프로젝트 전용 에이전트가 있어요.</span></div></div>
          <div class="fx-lanes">${lanes.map(([name, tone, rows, foot]) => `
            <div class="fx-lane fx-${tone}">
              <div class="fx-lane-name">${name}</div>
              ${rows.map(([k, v]) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`).join('')}
              <p class="fx-lane-foot">${foot}</p>
            </div>`).join('')}</div>
        </section>
        <section class="card span-6 stretch">
          <h2>신규인지 보완인지</h2>
          <div class="fx-tree">
            <div class="fx-q">티켓 브랜치가 origin 에 있거나, 이미 신규를 끝냈나?</div>
            <div class="fx-branches">
              <div class="fx-a"><span class="badge">아니오</span><b>신규</b><p>1. 요청사항 + 링크 파일 기준으로 구현. 앞서 질문했다면 3. 테스트의 답도 함께 넘김</p></div>
              <div class="fx-a"><span class="badge">예</span><b>보완</b><p>3. 테스트 칸에서 아직 처리 안 한 블록만 반영. 없으면 건너뜀</p></div>
            </div>
            <p class="desc mt8">블록마다 내용 해시를 저장해서 같은 요청을 두 번 처리하지 않아요. BATCH 는 브랜치가 없어서 기록만 봐요.</p>
          </div>
        </section>
        <section class="card span-6 stretch">
          <h2>결과에 따라</h2>
          <div class="fx-results">${results.map(([tone, label, code, desc]) => `
            <div class="fx-result">
              <span class="badge ${tone}">${label}</span>
              <div><code>${code}</code><p>${desc}</p></div>
            </div>`).join('')}</div>
        </section>
        <section class="card span-8">
          <h2>안전장치</h2>
          <div class="fx-guards">${guards.map(([t, d]) => `<div class="fx-guard"><b>${t}</b><p>${d}</p></div>`).join('')}</div>
        </section>
        <section class="card span-4 fx-files">
          <h2>파일 지도</h2>
          ${files.map(([f, d]) => `<div class="kv"><span><code>${f}</code></span><b>${d}</b></div>`).join('')}
        </section>
      </div>`;
    playEnter();
  }

  // ---------- 하네스 ----------
  const pctNum = r => (r && r.total ? Math.round(r.done / r.total * 100) : null);
  const pct = r => (pctNum(r) == null ? '-' : `${pctNum(r)}%`);
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
      <section class="card harness-stats">
        <h2>완료율</h2>
        <div class="gauges harness-gauges">
          <div class="gauge-box">
            <div class="gauge-label">전체</div>
            ${gauge(pctNum(d.stats.all), 'h-all', '전체 완료율', pct(d.stats.all), '완료', pctNum(d.stats.all))}
            <div class="meter-sub">${d.stats.all.total}번 중 ${d.stats.all.done}번</div>
          </div>
          <div class="gauge-box">
            <div class="gauge-label">마지막 변경 뒤</div>
            ${gauge(pctNum(after), 'h-after', '마지막 변경 뒤 완료율', pct(after), '완료', pctNum(after))}
            <div class="meter-sub">${after ? `${after.total}번 중 ${after.done}번` : '아직 변경한 적이 없어요'}</div>
          </div>
        </div>
      </section>
      <section class="card" id="ai-card"></section>
      <section class="card flush">
        <h2>지침과 규칙</h2>
        ${d.files.map(f => `
          <a class="row" href="#/harness/${f.id}">
            <div class="row-main"><div class="row-title">${esc(f.label)}</div><div class="row-sub wrap-text">${esc(f.desc)}</div><div class="row-sub">${esc(when(f.modified))}에 수정됨</div></div>
            ${ICON_NEXT}
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
    applyGauges();
    countUp();
    playEnter();

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
    if (!view.querySelector('.harness-stats')) view.innerHTML = '<section class="card"><div class="empty">불러오는 중이에요</div></section>';
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
    const back = `<a class="back" href="#/harness">${ICON_BACK}하네스</a>`;
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
    playEnter();
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
    const tab = h === '/' ? 'home' : h.startsWith('/runs') ? 'runs' : h.startsWith('/harness') ? 'harness' : h === '/flow' ? 'flow' : 'settings';
    document.querySelectorAll('#tabs a[data-tab]').forEach(a => {
      if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    view.classList.toggle('narrow', tab === 'settings' || tab === 'harness' || !!m);
    window.scrollTo(0, 0);
    pendingEnter = true;
    if (m) detail(m[1]);
    else if (e) harnessEdit(e[1]);
    else if (h === '/runs') runs();
    else if (h === '/harness') harness();
    else if (h === '/settings') settings();
    else if (h === '/flow') flow();
    else home();
  }
  window.addEventListener('hashchange', route);
  refreshChip();
  route();
})();
