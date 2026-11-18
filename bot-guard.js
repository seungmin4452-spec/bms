// 무인 봇 전용 PreToolUse 가드 (프로젝트 guard-bash.js 에 추가로 적용)
// - push 는 "git push [-u] origin <현재 티켓 브랜치>" 만 허용
// - 되돌리기 어려운 git 작업 차단
const { execSync } = require('child_process');

let raw = '';
process.stdin.on('data', c => (raw += c));
process.stdin.on('end', () => {
  const input = JSON.parse(raw || '{}');
  const cmd = (input.tool_input && input.tool_input.command) || '';
  const deny = reason => {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '[봇 가드] ' + reason },
    }));
    process.exit(0);
  };

  const blocked = [
    [/git\s+reset\s+--hard/, 'reset --hard 금지'],
    [/git\s+clean\b/, 'git clean 금지'],
    [/git\s+checkout\s+(--\s|\.\s*$|-f\b)/, '작업 트리 되돌리기 금지'],
    // switch 는 -c(생성)·--track·브랜치명만 허용. 변경 폐기(-f/--discard-changes)·브랜치 리셋(-C)·orphan·merge 전환 차단
    [/git\s+switch\b[^\n;&|]*\s(-[a-zA-Z]*[fCm][a-zA-Z]*|--force|--discard-changes|--force-create|--orphan|--merge)(?=\s|=|$)/, 'switch 강제/리셋 옵션 금지 (-c, --track 만 허용)'],
    [/git\s+restore\b(?![^\n;&|]*--staged)/, '작업 트리 되돌리기 금지 (--staged 만 허용)'],
    [/git\s+commit\b[^\n;&|]*--amend/, 'commit --amend 금지'],
    [/git\s+branch\s+-(D|d)\b/, '브랜치 삭제 금지'],
    [/git\s+stash\s+(drop|clear|pop)\b/, 'stash 삭제/적용 금지 (push 만 허용)'],
    [/git\s+(rebase|cherry-pick|revert)\b/, '이력 변경 작업 금지'],
    [/git\s+merge\b(?![^\n;&|]*--ff-only)/, 'merge 는 --ff-only 만 허용'],
    [/git\s+tag\b/, 'tag 금지'],
    [/\bglab\b|\bgh\s/, 'MR/PR 생성 금지'],
    [/Remove-Item[^\n;&|]*-Recurse|rm\s+-[a-z]*r/i, '재귀 삭제 금지'],
    [/\bsvn\s+(commit|ci|revert|update|up|switch|sw|merge|delete|del|remove|rm|move|mv|rename|ren|copy|cp|import|cleanup|resolve|resolved|relocate|patch|lock|unlock|propset|pset|ps|propdel|pdel|pd|checkout|co)\b/i, 'SVN 은 status/diff/info/log/add 만 허용 (커밋은 개발자가 직접)'],
  ];
  for (const [re, reason] of blocked) if (re.test(cmd)) deny(reason);

  const pushes = cmd.match(/git\s+push\b[^\n;&|]*/g) || [];
  if (pushes.length) {
    let branch = '';
    try {
      branch = execSync('git branch --show-current', { cwd: input.cwd || process.cwd() }).toString().trim();
    } catch (e) { /* 확인 불가 시 차단 */ }
    if (!/^PIGON-\d{8}-R-\d{3}$/.test(branch)) deny(`현재 브랜치(${branch || '확인불가'})가 티켓 브랜치가 아님`);
    for (const p of pushes) {
      const ok = new RegExp(`^git\\s+push(\\s+-u|\\s+--set-upstream)?\\s+origin\\s+(HEAD|"?${branch}"?)\\s*$`).test(p.trim());
      if (!ok) deny(`허용된 push 형태는 "git push -u origin ${branch}" 뿐: ${p.trim()}`);
    }
  }
  process.exit(0);
});
