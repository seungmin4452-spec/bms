무인 봇 BATCH 일감 처리. 사람에게 질문할 수 없으니 아래 절차만 따른다. 한국어로 기록한다.

- 일감: {releaseId}
- 모드: {mode} (new = 요청사항 기준 신규, feedback = 테스트 추가요청 반영)
- 요청 파일: {requestFile}
- 결과 파일: {resultFile}
- 수정 가능한 프로젝트 (모두 SVN 작업본, trunk):
{projectList}

## 1. 시작 전 점검
- 각 프로젝트에서 `svn status` 를 실행해 현재 상태를 본다. 이미 수정(M 등)된 파일은 **개발자의 미커밋 작업**이다. 그대로 두고, 되돌리거나 정리하지 않는다.
  - 그런 파일을 이번 요청 때문에 고쳐야 하면 기존 변경을 보존한 채 필요한 부분만 고치고, `notes` 에 그 사실을 적는다.

## 2. 요청 파악
- 요청 파일을 읽고, 첨부 이미지가 있으면 Read 로 직접 본다.
- "첨부 파일" 항목의 파일도 Read 로 반드시 본다. 요청서가 지목한 수정 쿼리·소스 파일이 없거나 다운로드 실패이면 직접 작성하지 말고 blocked 로 끝내고 파일을 요청한다.
- 어느 프로젝트를 고칠지 스스로 정한다. 근거는 코드에서 찾는다: `src/Config.properties`(스케줄 cron), `src/com/sunjin/agent/controller/MainController.java`(배치 등록), 배치 서비스명(`SchdGRP_*`), 관련 Controller/SQL.
  - 여러 프로젝트에 걸리면 모두 고친다. 결정과 근거는 `decisions` 에 적는다.
- **모호하면 구현하지 말고 멈춘다(blocked).** 기준: 같은 문장을 두 가지 이상으로 구현할 수 있고 그 차이가 데이터·스케줄 결과를 바꾸는 경우. 질문은 `questions` 에 적는다.
  - blocked 판단은 파일을 고치기 **전에** 한다.

## 3. 구현
- 고칠 프로젝트의 Java 버전을 `.iml`/`.classpath` 로 확인하고, 그 버전과 기존 코드 패턴(로깅, DB 접근, 예외 처리, 설정 키 이름)을 그대로 따른다. 확신이 없으면 같은 프로젝트에서 같은 패턴을 먼저 grep 한다.
- 최소 변경: 요청과 관계없는 포맷팅·공백·줄바꿈 변경 금지. 부수 문제는 고치지 말고 `notes` 에 적는다.
- `System.out.println` 추가 금지.
- DB 테이블 생성·변경이 필요하면 직접 실행하지 말고 `dbScripts` 에 적는다. FK 제약은 만들지 않는다.
- 새 파일을 만들면 `svn add <파일>` 로 등록한다(diff 에 나오도록).
- **금지:** `svn commit`, `svn revert`, `svn update`, `svn switch`, `svn merge`, `svn delete`, `svn move`, `svn copy`, `svn cleanup`. 커밋은 개발자가 검토 후 직접 한다.

## 4. 컴파일 확인
- 고친 프로젝트마다 전체 소스를 컴파일한다. 출력 폴더는 결과 파일과 같은 폴더의 `javac-<프로젝트명>` 을 쓴다(프로젝트 안에 만들지 말 것).
  - 예: 프로젝트 폴더에서 `find src -name "*.java" > <결과폴더>/sources-<프로젝트명>.txt` 후 `javac -encoding UTF-8 -cp "lib/*" -d <결과폴더>/javac-<프로젝트명> @<결과폴더>/sources-<프로젝트명>.txt`
  - 이 PC 의 javac 는 Java 8 이다. 프로젝트가 더 높은 버전 문법을 이미 쓰고 있어 기존 코드에서 실패하면, 내가 고친 파일에서 난 오류인지만 구분해 `compile` 에 적는다.
- 내가 고친 파일에서 난 오류는 3회까지 수정한다. 그래도 안 되면 `failed`.

## 5. 마무리
- 끝에 `svn status` 와 `svn diff` 로 내가 바꾼 부분을 다시 확인한다.
- blocked/failed 로 끝날 때 이미 고친 파일이 있으면 되돌리지 말고 그대로 두고, 그 파일 목록을 `notes` 에 적는다.
- 바뀐 파일 목록은 봇이 실행 전후를 비교해 메일에 자동으로 넣는다. `changes` 에는 파일별로 무엇을 바꿨는지만 적으면 된다.

## 6. 결과 파일
성공·실패 무관하게 결과 파일 경로에 Write 로 JSON 을 만든다.

```json
{
  "status": "modified | blocked | failed",
  "summary": "무엇을 했는지 3줄 이내",
  "failedStep": "failed 일 때 어느 단계에서 왜 (그 외 빈 문자열)",
  "projects": ["수정한 프로젝트명"],
  "changes": [{ "file": "프로젝트명/src/... 경로", "lines": "10-20", "what": "무엇을 바꿨는지" }],
  "dbScripts": [{ "kind": "DDL | DML | 확인", "target": "DB/테이블", "purpose": "목적", "sql": "SQL 전문", "risk": "주의점" }],
  "decisions": [{ "topic": "판단 주제", "choice": "선택", "reason": "근거", "alternative": "대안" }],
  "compile": "컴파일 결과 요약",
  "questions": ["기획자/개발자에게 물을 것"],
  "reviewChecklist": ["개발자가 커밋 전 확인할 것 (스케줄 시간, 운영 DB 영향 등)"],
  "notes": ["범위에서 제외한 것, 부수 문제"]
}
```
