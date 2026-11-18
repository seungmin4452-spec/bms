# 무인 봇 셸 실행 규칙 (반드시 지킬 것)

이 세션은 무인(-p) 실행이라 권한 확인 창이 없다. 아래 규칙을 어긴 명령은 **실행되지 않고 바로 거부**되고, 거부될 때마다 턴과 비용만 쓴다. 처음부터 통과하는 형태로 호출한다.

## 명령 형태
- 한 번 호출에 **명령 하나**만 쓴다. `;` `&&` `||` `|` 로 잇지 않는다. 필요한 명령은 각각 따로 호출하되, 서로 독립적이면 한 응답에서 병렬로 호출한다.
- 쓰지 말 것: `cd`/`Set-Location`(아래 E2E 예외만 허용), `$()`·백틱 치환, 셸 변수(`F=…; $F`), `$'…'` 이스케이프, `2>&1`·`2>/dev/null` 같은 리다이렉트, `git -C <경로>`, PowerShell 안에서 `powershell …` 다시 실행, `New-Object`·`[IO.File]::` 같은 .NET 호출.
- 작업 폴더는 시작 위치(저장소 루트)에 그대로 둔다. 다른 위치의 파일은 **절대경로**로 가리킨다.
- 허용된 셸 명령만 쓴다: `git status/fetch/switch/log/diff/show/branch/rev-parse/ls-remote/grep/add/commit/merge --ff-only/stash push/restore --staged/config --get`, `git push -u origin <티켓 브랜치>`(뒤에 아무것도 붙이지 않음), `npx playwright test …`, `ls` `cat` `head` `tail` `grep` `find` `wc` `sort` `uniq` `file`, 아래 두 도구 스크립트. 그 밖의 명령(`node -e`, `sed -i`, `awk`, 임의 스크립트 실행 등)은 거부된다.

## 파일 작업은 전용 도구로
- 읽기는 Read, 검색은 Grep/Glob, 수정은 Edit/Write 를 쓴다. 셸로 파일을 읽거나 고치지 않는다.
- 인코딩·줄바꿈 확인은 `file <경로>` 또는 `git ls-files --eol <경로>` 하나씩.

## SqlMap statement 통째 교체 (첨부 쿼리로 바꾸는 작업)
Edit 로 수백 줄을 나눠 지우지 말고 이 스크립트를 쓴다. 대상의 여닫는 태그는 유지하고 본문만 바꾸며, CRLF/BOM 과 들여쓰기를 대상 파일에 맞춘다.
```
node C:/Users/SMSHIN/pigon-chat-bot/tools/replace-statement.js <sqlmap.xml> <statementId> <교체파일> --dry-run
node C:/Users/SMSHIN/pigon-chat-bot/tools/replace-statement.js <sqlmap.xml> <statementId> <교체파일>
```
- `<statementId>` 는 id 속성값 그대로(예: `AdRp21_Ft02.selectRp21_Ft020305_03List`).
- 교체 파일은 SQL 본문만 있어도 되고 `<select id=…>…</select>` 전체여도 된다.
- 먼저 `--dry-run` 으로 범위를 확인한 뒤 실행한다. 첨부와 다르게 손볼 부분이 있으면 교체 후 Edit 로 고친다.

## WAS·E2E
- WAS 재기동: **Bash 도구**로 `powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/SMSHIN/pigon-chat-bot/was.ps1 restart` (PowerShell 도구에서는 `& C:/Users/SMSHIN/pigon-chat-bot/was.ps1 restart`).
- E2E(웹, `cd` 예외 허용): Bash 도구로 `cd e2e-local && npx playwright test tests/<브랜치명> --reporter=line` 한 번. playwright 는 e2e-local 안에서만 돈다(node_modules·.env 위치).
  **실행 직후 바로 `cd C:/Users/SMSHIN/IdeaProjects/pigon_pc` 를 단독으로 호출해 저장소 루트로 돌아온다.** (`cd` 는 다음 호출까지 유지돼, 안 돌아오면 이후 git·경로가 꼬인다)

## 서브에이전트
서브에이전트에는 이 규칙이 자동으로 전달되지 않는다. Agent 도구로 작업을 맡길 때 prompt 끝에 다음 한 줄을 넣는다:
`셸 규칙: 한 호출에 명령 하나, cd·파이프·;·&&·$()·변수·리다이렉트·git -C 금지, 파일은 Read/Grep/Edit 도구로. 자세한 내용은 C:/Users/SMSHIN/pigon-chat-bot/bot-shell-rules.md`
