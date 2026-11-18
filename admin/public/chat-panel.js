'use strict';
// 오른쪽 Claude 대화창. 서버(/api/chat)가 피그온봇 폴더에서 Claude Code 를 띄우고(봇 폴더 편집 가능, 봇 실행 중엔 읽기 전용) 답을 한 줄씩 흘려보낸다.
// - 넓은 화면(1600px 이상)에서는 오른쪽 여백에 붙어 있고, 좁으면 위쪽 바 버튼으로 여닫는 서랍이 된다.
// - 대화는 이 브라우저에만 저장한다(새로고침해도 이어짐). 서버 쪽 이어가기는 Claude 세션 ID(--resume)로 한다.
(function () {
  const TOKEN = document.querySelector('meta[name="admin-token"]').content;
  const STORE = 'pigon-chat';
  const panel = document.getElementById('chat');
  const toggle = document.getElementById('chat-toggle');
  const log = document.getElementById('chat-log');
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');
  const send = document.getElementById('chat-send');
  const warn = document.getElementById('chat-warn');
  const modeLabel = panel.querySelector('.chat-title span');
  const wide = matchMedia('(min-width: 1600px)');
  const SUGGEST = ['최근 실패한 일감의 원인을 정리해 줘', 'poll.js 가 처리할 일감을 고르는 조건은?', '이번 주 실행 결과를 요약해 줘'];

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const load = () => { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) { return {}; } };
  const state = Object.assign({ sessionId: '', messages: [], open: null }, load());
  const save = () => {
    try { localStorage.setItem(STORE, JSON.stringify({ sessionId: state.sessionId, messages: state.messages.slice(-60), open: state.open })); } catch (e) { /* 저장 못 해도 대화는 된다 */ }
  };
  let controller = null; // 답을 받는 중이면 멈춤용

  // ---------- 열기·닫기 ----------
  // 넓은 화면은 기본으로 열려 있고(닫으면 기억), 좁은 화면은 버튼으로 연다
  function layout() {
    const open = wide.matches ? state.open !== false : panel.dataset.drawer === 'open';
    panel.hidden = !open;
    document.documentElement.classList.toggle('chat-docked', open && wide.matches);
    panel.classList.toggle('drawer', !wide.matches);
    toggle.setAttribute('aria-expanded', String(open));
  }
  function setOpen(open) {
    if (wide.matches) state.open = open;
    panel.dataset.drawer = open ? 'open' : '';
    save();
    layout();
    if (open) { refreshUsage(); input.focus(); } else toggle.focus();
  }
  toggle.onclick = () => setOpen(panel.hidden);
  document.getElementById('chat-close').onclick = () => setOpen(false);
  wide.addEventListener('change', layout);
  panel.addEventListener('keydown', e => { if (e.key === 'Escape' && !wide.matches) setOpen(false); });

  // ---------- 사용량 경고 (5시간 한도 80% 이상이면 알려만 준다) ----------
  async function refreshUsage() {
    try {
      const s = await (await fetch('/api/status')).json();
      const w = s.usage && s.usage.snapshot && s.usage.snapshot.fiveHour;
      const used = w ? Math.round(w.usedPercent) : 0;
      warn.hidden = used < 80;
      warn.textContent = used >= 80 ? `Claude 5시간 한도를 ${used}% 썼어요. 대화도 같은 한도를 써서, 많이 쓰면 봇이 개발하다 멈출 수 있어요.` : '';
    } catch (e) { /* 경고만 못 띄울 뿐 */ }
  }

  // ---------- 답 렌더링: 짧은 마크다운만 (먼저 이스케이프하고 꾸민다) ----------
  function md(src) {
    return String(src).replace(/\n{3,}/g, '\n\n').split(/```[^\n]*\n?/).map((part, i) => {
      if (i % 2) return `<pre class="log"><code>${esc(part.replace(/\n$/, ''))}</code></pre>`;
      return esc(part.replace(/^\n+|\n+$/g, ''))
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
        .replace(/^#{1,4} (.+)$/gm, '<b class="md-h">$1</b>')
        .replace(/^\s*[-*] (.+)$/gm, '<span class="md-li">$1</span>')
        .replace(/\n/g, '<br>');
    }).join('');
  }

  function bubble(m) {
    if (m.role === 'user') return `<div class="msg user"><div class="msg-body">${esc(m.text).replace(/\n/g, '<br>')}</div></div>`;
    const tools = (m.tools || []).map(t => `<span class="tool-chip">${esc(t)}</span>`).join('');
    const body = m.text ? md(m.text) : m.pending ? '<span class="typing" aria-label="생각하는 중"><i></i><i></i><i></i></span>' : '';
    return `<div class="msg bot">
      ${tools ? `<div class="tool-row">${tools}</div>` : ''}
      ${body ? `<div class="msg-body">${body}</div>` : ''}
      ${m.error ? `<div class="msg-error">${esc(m.error)}</div>` : ''}
    </div>`;
  }

  function render() {
    if (!state.messages.length) {
      log.innerHTML = `<div class="chat-empty">
        <p>피그온봇 폴더와 pigon_pc 를 읽고 답해요.<br>부탁하면 피그온봇 폴더의 파일을 고쳐요. pigon_pc 는 읽기만 해요.</p>
        <div class="chat-suggest">${SUGGEST.map(s => `<button type="button" class="chip" data-s="${esc(s)}">${esc(s)}</button>`).join('')}</div>
      </div>`;
      log.querySelectorAll('[data-s]').forEach(b => { b.onclick = () => { input.value = b.dataset.s; ask(); }; });
      return;
    }
    log.innerHTML = state.messages.map(bubble).join('');
    log.scrollTop = log.scrollHeight;
  }

  // 답이 오는 동안에는 마지막 말풍선만 다시 그린다 (프레임당 한 번)
  let raf = 0;
  function renderLast() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 40;
      const last = log.lastElementChild;
      const html = bubble(state.messages[state.messages.length - 1]);
      if (last && last.classList.contains('bot')) last.outerHTML = html; else render();
      if (stick) log.scrollTop = log.scrollHeight;
    });
  }

  function busy(on) {
    panel.classList.toggle('busy', on);
    send.setAttribute('aria-label', on ? '멈추기' : '보내기');
    input.disabled = on;
    if (!on) input.focus();
  }

  // ---------- 보내기: NDJSON 스트림을 한 줄씩 읽는다 ----------
  async function ask() {
    const text = input.value.trim();
    if (!text || controller) return;
    input.value = '';
    autosize();
    state.messages.push({ role: 'user', text });
    const reply = { role: 'bot', text: '', tools: [], pending: true };
    state.messages.push(reply);
    render();
    busy(true);
    controller = new AbortController();
    let breakNext = false;
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Token': TOKEN },
        body: JSON.stringify({ message: text, sessionId: state.sessionId }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '요청을 처리하지 못했어요');
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === 'session') state.sessionId = ev.id;
          if (ev.type === 'mode') {
            modeLabel.textContent = ev.edit ? '피그온봇 폴더 · 편집 가능' : '봇 실행 중 · 읽기 전용';
            if (!ev.edit) reply.tools.push('봇 실행 중이라 읽기 전용');
          }
          if (ev.type === 'text') {
            if (breakNext && reply.text) reply.text += '\n\n';
            breakNext = false;
            reply.text += ev.text;
          }
          if (ev.type === 'tool') { reply.tools.push(ev.text); breakNext = true; } // 도구를 쓴 뒤 다시 말하면 문단을 나눈다
          if (ev.type === 'error') reply.error = ev.text;
          if (ev.type === 'done') {
            if (ev.session) state.sessionId = ev.session;
            if (ev.error) reply.error = ev.error;
          }
          renderLast();
        }
      }
    } catch (e) {
      reply.error = e.name === 'AbortError' ? '멈췄어요.' : e.message;
    } finally {
      reply.pending = false;
      if (!reply.text && !reply.error) reply.error = '답을 받지 못했어요.';
      controller = null;
      busy(false);
      save();
      render();
      const live = document.getElementById('announce');
      if (live) { live.textContent = ''; setTimeout(() => { live.textContent = reply.error ? `Claude 오류: ${reply.error}` : 'Claude가 답을 마쳤어요'; }, 50); }
    }
  }

  form.onsubmit = e => {
    e.preventDefault();
    if (controller) controller.abort(); else ask();
  };
  // Enter 보내기, Shift+Enter 줄바꿈. 한글 조합 중 Enter 는 글자 확정이라 보내지 않는다
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); ask(); }
  });
  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }
  input.addEventListener('input', autosize);

  document.getElementById('chat-new').onclick = () => {
    if (controller) controller.abort();
    state.sessionId = '';
    state.messages = [];
    save();
    render();
    input.focus();
  };

  // 지난번에 답을 받다 끊긴 말풍선은 끝난 것으로 정리한다
  state.messages.forEach(m => { if (m.pending) { m.pending = false; if (!m.text) m.error = '답을 받다가 끊겼어요.'; } });
  render();
  layout();
  if (!panel.hidden) refreshUsage();
})();
