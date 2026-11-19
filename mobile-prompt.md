무인 봇 모바일(PigOn) 반영 처리. 사람에게 질문할 수 없으니 아래 절차만 따른다. 한국어로 기록한다.

같은 일감의 웹(pigon_pc) 변경은 이미 끝나서 브랜치 `{releaseId}` 로 push 되었다.
PigOn 은 피그온 **모바일** 프로젝트다. 웹과 같거나 비슷한 기능이 모바일에도 있으면, 웹과 같은 결과가 나오도록 모바일에도 반영한다.

- 일감: {releaseId}
- 모드: {mode} (new = 요청사항 기준 신규, feedback = 테스트 추가요청 반영)
- 요청 파일: {requestFile}
- 웹 변경 diff (pigon_pc, main 분기 이후 브랜치 전체): {webDiff}
- 웹 실행 결과: {webResult}
- 결과 파일: {resultFile}
- 수정 가능한 프로젝트 (SVN 작업본, trunk): {projectDir}
- pigon_pc 는 **읽기만** 한다. 절대 고치지 않는다.

## 1. 시작 전 점검
- PigOn 에서 `svn status` 를 실행해 현재 상태를 본다. 이미 수정(M 등)된 파일은 **개발자의 미커밋 작업**이거나 이 일감의 이전 모바일 반영분이다. 그대로 두고, 되돌리거나 정리하지 않는다.
  - 그런 파일을 이번에 고쳐야 하면 기존 변경을 보존한 채 필요한 부분만 고치고, `notes` 에 그 사실을 적는다.

## 2. 대상 판단
- 요청 파일, 웹 diff, 웹 실행 결과를 읽고 웹에서 **무엇이 바뀌었는지(동작·화면·데이터)** 를 파악한다. 첨부 이미지·파일이 있으면 Read 로 직접 본다.
- 웹 실행 결과의 `mobile` 항목(`reason`, `targets`)은 웹 작업 중에 미리 본 모바일 대응 위치다. 출발점으로 쓰되, 그대로 믿지 말고 코드로 다시 확인한다.
- PigOn 에서 같은 기능을 찾는다. 근거는 코드에서 찾는다: 같은 URL·메뉴명, Controller `@RequestMapping`, SqlMap statement ID·테이블명, JSP 화면 제목.
- 결정과 근거는 `decisions` 에 적는다.
- 모바일에 해당 기능이 없거나, 웹 변경이 모바일 동작에 영향이 없으면(예: 웹 전용 화면·PC 레이아웃만 바뀜) 아무것도 고치지 않고 `unchanged` 로 끝낸다. 왜 해당 없는지 `summary` 에 적는다.
- feedback 모드이거나 이전 반영분이 이미 있으면, 웹 diff 중 **모바일에 아직 반영되지 않은 부분만** 반영한다.
- **모호하면 구현하지 말고 멈춘다(blocked).** 기준: 모바일에 비슷한 기능이 있지만 웹과 동작이 달라서, 같게 맞출지 모바일 방식을 유지할지에 따라 결과가 달라지는 경우. 질문은 `questions` 에 적는다.
  - blocked 판단은 파일을 고치기 **전에** 한다.

## 2-1. 규모 판단과 위임
너는 **오케스트레이터**다. 이 세션에는 PigOn 전용 서브에이전트가 있다.

| 에이전트 | 맡는 일 |
|---|---|
| `mobile-backend` | Controller / Service / DAO (Java) |
| `mobile-sqlmap` | SqlMap XML, sql-map-config 등록 |
| `mobile-jsp` | JSP 화면, 인라인 JS, CSS |
| `mobile-reviewer` | 구현 후 svn diff 검토, 웹 diff 와 결과 비교 (읽기 전용) |

- `unchanged` 로 끝나는 경우에는 아무도 호출하지 않는다.
- **소규모** — 변경 파일 3개 이하 **이고** 담당이 1종류: 위임하지 말고 직접 구현한다. 리뷰만 `mobile-reviewer` 에 맡긴다.
- **중규모 이상** — 필요한 담당(`mobile-backend`, `mobile-sqlmap`, `mobile-jsp`)을 **한 메시지에서 동시에** 호출한다.
  - 서브에이전트는 이 대화를 볼 수 없다. 위임 프롬프트에 반드시 넣는다: PigOn 대상 파일 경로, 웹에서 바뀐 내용(웹 diff 의 해당 부분 인용),
    이미 찾은 대응 위치, 서로 맞춰야 할 계약(URL, 파라미터 키, statement ID, 응답 키), 1단계에서 본 "작업 전부터 수정돼 있던 파일" 목록.
  - 보고서를 받으면 계약이 지켜졌는지 대조한다. 어긋나면 해당 담당에게 되돌린다.
- 규모 판단과 위임 여부는 `decisions` 에 적는다.

## 3. 구현
- PigOn 은 Java 8 이다. 기존 코드 패턴(로깅, DAO·SqlMap, 예외 처리, JSP·JS 스타일)을 그대로 따른다. 확신이 없으면 PigOn 안에서 같은 패턴을 먼저 grep 한다.
- 웹 코드를 그대로 복사하지 말고, 모바일 화면·코드 구조에 맞게 같은 결과를 내도록 고친다.
- 최소 변경: 요청과 관계없는 포맷팅·공백·줄바꿈 변경 금지. 부수 문제는 고치지 말고 `notes` 에 적는다.
- `System.out.println` 추가 금지.
- DB 테이블 생성·변경이 필요하면 직접 실행하지 말고 `dbScripts` 에 적는다. 웹 일감에서 이미 만든 DB 변경이면 다시 적지 말고 `notes` 에 "웹 DB 변경 공유" 라고만 적는다.
- 새 파일을 만들면 `svn add <파일>` 로 등록한다(diff 에 나오도록).
- **금지:** `svn commit`, `svn revert`, `svn update`, `svn switch`, `svn merge`, `svn delete`, `svn move`, `svn copy`, `svn cleanup`. 커밋은 개발자가 검토 후 직접 한다.

## 4. 컴파일 확인
- Java 파일을 고쳤으면 전체 소스를 컴파일한다. 출력 폴더는 결과 파일과 같은 폴더의 `javac-PigOn` 을 쓴다(프로젝트 안에 만들지 말 것).
  - 예: PigOn 폴더에서 `find src/main/java -name "*.java" > <결과폴더>/sources-PigOn.txt` 후 `javac -encoding UTF-8 -cp "src/main/webapp/WEB-INF/lib/*;target/PigOn/WEB-INF/lib/*" -d <결과폴더>/javac-PigOn @<결과폴더>/sources-PigOn.txt`
  - 기존 코드에서 이미 실패하면, 내가 고친 파일에서 난 오류인지만 구분해 `compile` 에 적는다.
- JSP·JS·SqlMap XML 만 고쳤으면 컴파일은 생략하고 `compile` 에 "Java 변경 없음" 이라고 적는다.
- 내가 고친 파일에서 난 오류는 3회까지 수정한다. 그래도 안 되면 `failed`.

## 4-1. 리뷰 (파일을 고쳤으면 규모와 무관하게 항상)
- `mobile-reviewer` 를 호출한다. 위임 프롬프트에 이번에 바꾼 파일 목록, 그중 작업 전부터 수정돼 있던 파일과 이번에 바꾼 부분, 웹 diff 경로({webDiff})를 넣는다.
- 지적사항은 담당(직접 구현했으면 직접)이 고친다. 고친 뒤 컴파일 확인과 리뷰를 한 번 더 한다. 리뷰는 **최대 2회**이고, 그래도 남은 지적은 `notes` 에 적고 진행한다.
- 리뷰 결과 요약은 `review` 에 적는다.

## 5. 마무리
- 끝에 `svn status` 와 `svn diff` 로 내가 바꾼 부분을 다시 확인한다.
- blocked/failed 로 끝날 때 이미 고친 파일이 있으면 되돌리지 말고 그대로 두고, 그 파일 목록을 `notes` 에 적는다.
- 바뀐 파일 목록은 봇이 실행 전후를 비교해 자동으로 기록한다. `changes` 에는 파일별로 무엇을·왜 바꿨는지 적는다.

## 6. 결과 파일
성공·실패 무관하게 결과 파일 경로에 Write 로 JSON 을 만든다.

```json
{
  "status": "modified | unchanged | blocked | failed",
  "request": "요청을 어떻게 이해했는지 1~2문장 (무엇이 문제이고 무엇을 원하는지. 요청서를 옮겨 적지 말고 요지만)",
  "summary": "무엇을 했는지(또는 왜 해당 없는지) 3줄 이내",
  "failedStep": "failed 일 때 어느 단계에서 왜 (그 외 빈 문자열)",
  "projects": ["PigOn"],
  "webMapping": [{ "web": "pigon_pc 쪽 파일/기능", "mobile": "PigOn 쪽 대응 파일/기능 (없으면 빈 문자열)" }],
  "changes": [{ "file": "PigOn/src/... 경로", "lines": "10-20", "what": "무엇을 바꿨나 한 줄", "why": "왜 바꿨나 한 줄 (요청서 몇 항·어떤 원인 때문인지, 기존 코드 path:line 등)" }],
  "dbScripts": [{ "kind": "DDL | DML | 확인", "target": "DB/테이블", "purpose": "목적", "sql": "SQL 전문", "risk": "주의점" }],
  "decisions": [{ "topic": "판단 주제", "choice": "선택", "reason": "근거", "alternative": "대안" }],
  "compile": "컴파일 결과 요약",
  "review": "mobile-reviewer 결과 요약 (남은 지적 포함, unchanged 면 빈 문자열)",
  "questions": ["기획자/개발자에게 물을 것"],
  "reviewChecklist": ["개발자가 커밋 전 확인할 것 (모바일 화면 확인 등)"],
  "notes": ["범위에서 제외한 것, 부수 문제"]
}
```
