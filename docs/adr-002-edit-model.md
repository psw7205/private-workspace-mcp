# ADR-002 — Edit Model

* Status: Accepted
* Date: 2026-09-23
* Scope: Phase 2 (Safer Editing) 첫 단계

## 1. Context

MVP의 수정 수단은 `write_file`(전체 content 교체) 하나다. 기존 파일의 일부를 바꾸려면 agent가 파일 전체를 다시 보내야 하고, 긴 파일일수록 model이 내용을 누락하거나 잘라낼 위험이 커진다. revision 검사(ADR-001 12절)는 동시 수정은 막지만 content 누락은 막지 못한다.

PRD 16 Phase 2는 "기존 파일 수정은 전체 `write_file`보다 targeted `edit_file`을 우선"하도록 발전시킨다고 정한다. ADR-001 21절은 edit/patch model을 이 ADR로 미뤘다.

## 2. Decision

exact-match 문자열 교체 tool `edit_file` 하나를 추가한다.

입력:

```text
path               workspace 상대 경로 (기존 파일만)
old_string         교체할 원문. 비어 있으면 안 된다
new_string         대체할 문자열
expected_revision  read_file 또는 직전 edit_file/write_file이 준 revision (필수)
replace_all        기본 false
```

동작:

1. 파일은 `read_file`과 같은 규칙으로 읽는다. read limit, binary, non-UTF-8이면 거부한다.
2. `expected_revision`이 현재 revision과 다르면 `REVISION_CONFLICT`.
3. `old_string`이 0번 나오면 `EDIT_NO_MATCH`, 2번 이상 나오는데 `replace_all`이 false면 `EDIT_AMBIGUOUS`. 이때 파일은 바뀌지 않는다.
4. 교체 결과가 `max write bytes`를 넘으면 `FILE_TOO_LARGE`.
5. 결과는 `write_file`의 교체 경로(lock, lock 안에서 revision 재확인, temp file + fsync + rename, mode 보존)로 쓴다.
6. 결과로 새 `revision`과 교체 횟수를 돌려준다. agent는 다시 읽지 않고 다음 `edit_file`을 이어서 호출할 수 있다.

match는 decode된 문자열에 대한 정확한 비교다. 줄바꿈 정규화, 공백 무시, 대소문자 무시는 하지 않는다. CRLF 파일은 `old_string`에도 `\r\n`이 있어야 맞는다.

## 3. 이유

- **exact match가 가장 예측 가능하다.** agent가 방금 읽은 text를 그대로 보내면 되고, 서버는 위치를 추론하지 않는다. 0개·여러 개 match를 오류로 돌려 잘못된 위치를 고치는 일을 막는다.
- **line/range 교체를 넣지 않는다.** line 번호는 revision이 같아도 agent가 잘못 셀 수 있고, 실패해도 서버가 알아챌 방법이 없다. exact match는 틀리면 `EDIT_NO_MATCH`로 드러난다.
- **쓰기 경로를 새로 만들지 않는다.** 교체 결과를 `write_file`과 같은 함수로 쓰면 atomic write, create/replace 규칙, lock이 한 곳에 남는다. 파일을 lock 밖에서 한 번, lock 안에서 한 번 읽지만 read limit 안의 파일이라 비용이 작다.
- **새 error code를 둔다.** `EDIT_NO_MATCH`(다시 읽고 원문 확인)와 `EDIT_AMBIGUOUS`(주변 문맥을 넣어 유일하게 만들거나 `replace_all`)는 agent가 취할 행동이 다르다. `REVISION_CONFLICT`에 섞지 않는다.

## 4. Alternatives Considered

### unified diff / patch 입력

여러 hunk를 한 번에 적용할 수 있지만, model이 만든 diff는 context line과 hunk header가 자주 어긋난다. fuzzy 적용을 넣으면 예측 가능성이 떨어진다. 필요해지면 exact-match를 여러 개 받는 형태부터 검토한다.

### 여러 edit를 한 호출에 (edit 배열)

한 파일 안의 여러 곳을 원자적으로 바꿀 수 있다. 다만 배열 안의 edit가 서로 겹치거나 앞 edit가 뒤 edit의 원문을 바꾸는 경우의 의미를 정해야 한다. v1은 단일 edit로 두고, 결과 revision으로 연속 호출한다. 호출 사이에 사용자가 파일을 바꾸면 다음 호출이 `REVISION_CONFLICT`로 멈춘다.

## 5. Deferred

- line/range 교체
- before/after diff 생성, write preview
- write approval (ADR-003)
- 여러 파일에 걸친 bulk edit transaction
- formatter integration
- file revision history, rollback

## 6. Consequences

### Positive

- 긴 파일의 일부 수정에서 content 누락 위험이 줄어든다.
- 기존 보안 불변식(PathGuard, deny, 기본 read-only, revision 필수, atomic write)을 그대로 따른다.

### Negative

- 한 파일의 여러 곳을 바꾸려면 호출을 여러 번 해야 하고, 그 사이 상태는 중간 결과다.
- 같은 text가 여러 번 나오는 파일에서는 agent가 주변 문맥을 넣어 `old_string`을 유일하게 만들어야 한다.
