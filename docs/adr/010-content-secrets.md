# ADR-010 — Content-based Secret Backstop

* Status: Accepted (2026-09-29)
* Date: 2026-09-28
* Scope: 이름이 평범한 파일 안의 credential이 filesystem tool 응답으로 나가는 경로

## 1. Context

운영 중인 instance가 실제 API key를 반환했다. `search_text(query="API_KEY", include_ignored=true)`가 gitignore된 JSON archive 파일에 match했고, 그 파일 이름은 deny 목록에 없었다. 운영자는 `WORKSPACE_EXTRA_DENY_PATTERNS`를 추가하고 read-only mode로 바꿔 대응했다.

지금 민감 파일 방어는 이름 기준이다(`DEFAULT_DENY_PATTERNS` + `WORKSPACE_EXTRA_DENY_PATTERNS`, M3·M26). `backup.json`, `memo.md`, DB dump, cache처럼 평범한 이름의 파일에 든 secret은 다음 경로로 그대로 나간다.

* `read_file`: 파일 내용 전체(window 단위지만 여러 번 부르면 전체).
* `search_text`: match한 줄의 `text`와 `path`·`line`·`column`.
* `edit_file`·`multi_edit_file`: `dry_run` diff는 match 주변 줄을 보여 준다. dry run이 아니어도 `EDIT_NO_MATCH`/`EDIT_AMBIGUOUS`/성공이 내용에 대한 oracle이다.
* opt-in Git tool: `git_diff`·`git_show` patch와 commit message(ADR-004 6절 잔여 위험에 이미 기록).

`include_ignored`는 편의 기능이지 보안 경계가 아니다(M23). 이번 사고의 원인은 ignore 규칙이 아니라 이름 기준 deny의 한계이므로, ignore를 보안 경계로 바꾸는 방향은 다루지 않는다. 기본값(`include_ignored: false`)으로도 gitignore되지 않은 `notes.md`에 든 key는 똑같이 나간다.

ADR-001 18절대로 tool 결과는 OpenAI 경로를 통과한다. 한 번 나간 secret은 되돌릴 수 없고 rotate해야 한다.

## 2. 선택지

### A. 현상 유지 (이름 deny + 운영자 scope + OS 경계)

코드는 바꾸지 않고 `docs/security.md`에 "deny는 이름만 본다. secret이 든 파일은 workspace 밖에 두거나 `WORKSPACE_EXTRA_DENY_PATTERNS`에 넣는다"를 명시한다.

* 장점: 오탐, 성능 비용, 새 설정이 없다. 경계에 대한 설명이 가장 정직하다(ADR-001 11절).
* 단점: 운영자가 파일마다 이름을 알아야 한다. 이번 사고처럼 archive·dump가 생기는 순간 새 누출 경로가 된다. 사후 대응만 가능하다.

### B. `search_text` snippet redaction만

match한 줄의 `text`에서 credential pattern 부분을 `[REDACTED]`로 바꾼다. 이번 사고의 직접 경로만 막는다. 이 방식은 누출을 닫지 못한다.

1. **같은 파일을 `read_file`로 읽을 수 있다.** `search_text`가 `path`를 알려 주므로 다음 호출 하나로 원문이 나간다. `read_file`은 redaction할 수 없다(아래 2.1).
2. **match 여부 자체가 oracle이다.** `text`를 가려도 `matches`의 유무, `line`, `column`이 남는다. `regex: true`와 `case_sensitive: true`면 `^.{12}a`, `^.{12}b`, ... 처럼 한 글자씩 물어 값을 복원할 수 있다. 40자 key는 문자 집합 크기 × 40번 이하의 호출로 끝나고, 이 호출은 모두 읽기 tool이라 client 승인 없이 자동 실행되기 쉽다(`docs/security.md` client 승인 절). literal query로도 prefix를 늘려 가며 같은 일을 할 수 있다.

따라서 B는 "화면에 덜 보이게" 할 뿐 경계가 아니고, 막았다는 인상만 준다.

### C. 내용 기반 파일 차단

파일 내용에 고신뢰 credential pattern이 하나라도 있으면 그 파일을 deny hit처럼 다룬다. 내용 일부를 가리는 것이 아니라 파일 단위로 응답에서 뺀다. match 전에 파일을 빼므로 B의 oracle도 생기지 않는다.

### 2.1 공통 제약: `read_file` 내용은 redaction하지 않는다

어떤 선택지든 `read_file`이 돌려주는 `content`를 고쳐서 보내지 않는다.

* read-write mode에서 model은 읽은 내용을 고쳐 `write_file`·`edit_file`로 되돌린다. placeholder가 든 내용을 쓰면 원래 secret이 `[REDACTED]`로 바뀌어 파일이 조용히 손상된다. M17(lossy decode 거부)과 같은 이유다.
* `revision`은 원본 byte 기준이다(`src/filesystem/revision.ts`). 가린 내용과 revision이 어긋나 `edit_file`의 `old_string`이 원본과 맞지 않거나, model이 가린 내용을 원본으로 오해한다.

그래서 내용 기반 방어는 "보여 주되 가린다"가 아니라 "파일을 통째로 주지 않는다"여야 한다.

## 3. 결정(제안)

**C를 채택한다.** 이름 deny와 같은 성격의 보조 방어(backstop)로 두고, 경계는 계속 workspace scope + OS 권한이다(ADR-001 11절).

### 3.1 적용 범위

| tool | 동작 |
|------|------|
| `read_file` | 파일 전체를 읽고 UTF-8 decode한 뒤 scan한다. match하면 `PATH_BLOCKED`. `start_line`/`max_lines`와 무관하게 전체를 본다(`readTextFile`은 이미 전체를 읽은 뒤 window를 자른다) |
| `search_text` | decode한 파일을 줄 단위 match 전에 scan한다. match하면 binary·non-UTF-8 파일처럼 조용히 건너뛰고 `files_searched`에 세지 않는다. 결과 전체를 실패시키지 않는다 |
| `edit_file`·`multi_edit_file` | 기존 파일을 decode한 뒤, edit 적용 전에 scan한다. `dry_run`도 같다. match하면 `PATH_BLOCKED` |
| `write_file` | 기존 파일 교체면 revision 비교 전에 현재 내용을 scan한다(`file-writer.ts`는 이미 현재 byte를 읽는다). 새 파일 생성은 검사할 기존 내용이 없다 |
| `list_directory`·`find_files` | scan하지 않는다(3.4) |

순서는 경로 검사(`PathGuard`, 이름 deny) → 크기(`FILE_TOO_LARGE`) → binary·UTF-8(`BINARY_FILE`) → 내용 scan → tool 고유 검사(revision, edit match)다. `FILE_TOO_LARGE`·`BINARY_FILE` 파일은 내용이 나가지 않으므로 scan하지 않는다.

write 경로는 이미 `expected_revision`으로 막혀 있다. model은 revision을 `read_file`로만 얻는데 그 호출이 차단되므로, write 쪽 scan은 belt-and-suspenders다. 그래도 넣는 이유는 edit의 match 결과와 dry run diff가 read 없이도 내용을 드러내기 때문이다. `write_file`·`edit_file`이 쓰는 새 내용은 scan하지 않는다. model이 이미 가진 값이라 누출이 아니다. 쓴 결과가 pattern을 포함하면 이후 read가 막힐 뿐이다.

walker가 읽는 `.gitignore`·`.ignore`(`loadIgnoreScope`)는 client에 내용을 돌려주지 않으므로 scan하지 않는다. scan은 server 밖으로 나가는 내용에만 적용한다. `include_ignored`와 무관하게 적용되므로 M23은 바뀌지 않는다.

### 3.2 Pattern set

고신뢰 pattern만 쓴다. 모두 provider가 정한 고정 prefix와 고정(또는 최소) 길이·문자 집합의 tail로 이루어진다. entropy heuristic과 `api_key = "..."` 같은 keyword-assignment 규칙은 넣지 않는다. 오탐이 많고, 오탐이 곧 read 거부라 일반 코드·설정 파일을 대량으로 막는다.

| id | 형태(개요) |
|----|------------|
| `anthropic` | `sk-ant-` + `[A-Za-z0-9_-]` tail |
| `openai` | `sk-proj-`(및 `sk-svcacct-`, `sk-admin-`) + `[A-Za-z0-9_-]` tail |
| `github` | `ghp_`·`gho_`·`ghu_`·`ghs_`·`ghr_` + `[A-Za-z0-9]{36}`, `github_pat_` + `[A-Za-z0-9_]` tail |
| `gitlab` | `glpat-` + `[A-Za-z0-9_-]{20,}` |
| `slack` | `xox[abp]-` + `[A-Za-z0-9-]` tail |
| `aws_access_key_id` | `(AKIA\|ASIA)[0-9A-Z]{16}` |
| `google_api_key` | `AIza[0-9A-Za-z_-]{35}` |
| `tavily` | `tvly-` + `[A-Za-z0-9_-]` tail |
| `private_key` | `-----BEGIN ` + (`RSA `·`EC `·`DSA `·`OPENSSH `·`ENCRYPTED ` 중 하나 또는 없음) + `PRIVATE KEY-----` |

* 각 pattern 앞에는 `[A-Za-z0-9]`가 오지 않아야 한다(단어 중간의 `...AKIA...` 제외). prefix만으로는 약하므로(`sk-ant-`는 문서 본문에도 나온다) tail 최소 길이를 반드시 둔다.
* unresolved: provider별 tail의 정확한 길이와 문자 집합(Anthropic·OpenAI·Slack·Tavily), 예시 밖에 넣은 prefix(`sk-svcacct-`, `sk-admin-`, `gho_`·`ghu_`·`ghs_`·`ghr_`, `ASIA`)는 이 ADR 시점에 1차 문서로 확인하지 못했다. 구현 시 provider 문서로 최소 길이를 정하고 test에 근거를 남긴다.
* AWS secret access key(40자 base64)는 prefix가 없어 잡지 못한다. 같은 파일의 access key id로 간접적으로 걸리는 경우가 많을 뿐이다.
* pattern은 서버 고정값이고 사용자 입력이 아니다. 중첩 quantifier가 없는 prefix-anchored 식이라 native `RegExp`로 선형 시간에 돈다(implementation notes 3절의 사용자 regex 한 줄 비용과 성격이 다르다). 목록은 `src/policy/content-patterns.ts`에 둔다.

### 3.3 오탐과 opt-out

대표 오탐은 문서화된 예제 값이다. AWS 문서의 예제 access key id(`AKIA` 뒤에 `IOSFODNN7EXAMPLE`)는 `aws_access_key_id`와 정확히 match한다. secret scanner, SDK, 이 repo 자체의 test fixture가 이런 값을 담으면 해당 파일을 이 서버로 읽거나 고칠 수 없게 된다.

* **기본값: 켜짐.** M26과 같은 판단이다. 오탐은 read 거부로 끝나고 운영자가 되돌릴 수 있지만, 누락은 되돌릴 수 없다. v0.1.0 사용자에게는 upgrade 시 동작 변경이지만, M26이 v0.2.0 hardening에서 deny 기본값을 넓힌 것과 같은 방향이다.
* **opt-out: 서버 전체 kill switch 하나**(`WORKSPACE_CONTENT_SCAN=off`, 기본 `on`, 다른 값은 startup에서 거부). 이 layer는 `DEFAULT_DENY_PATTERNS`가 아니므로 끌 수 있게 해도 AGENTS.md 보안 불변식 3을 어기지 않는다. model은 env를 바꿀 수 없다.
* path allowlist, pattern별 끄기, workspace별 설정은 첫 단계에 넣지 않는다(5절). 설정 surface가 커지고, 잘못 넓힌 allowlist가 누락을 만든다. 가장 단순하고 보수적인 쪽을 택한다(AGENTS.md).
* 이 repo에서 구현할 때 test는 예제 key를 source에 literal로 두지 않고 runtime에 이어 붙여 만든다(`'AKIA' + ...`). 그래야 이 repo를 workspace로 둔 agent가 test 파일을 계속 읽을 수 있다.

### 3.4 Listing은 scan하지 않는다

`list_directory`·`find_files`는 파일 내용을 읽지 않는다. 내용 기반으로 항목을 숨기지 않는다.

* scan하면 listing이 reading이 된다. `find_files` 한 번이 최대 `WORKSPACE_MAX_SEARCH_FILES` × `WORKSPACE_MAX_READ_BYTES`(기본 10000 × 1 MiB)를 읽는다.
* 이번에 샌 것은 존재가 아니라 내용이다. 이름이 평범한 파일의 존재는 이름 deny도 숨기지 않던 정보다.
* 숨기면 model이 없는 줄 알고 같은 이름으로 `write_file`을 부르다 "already exists"를 받는 등 동작이 헷갈린다.

M4(deny 항목은 listing에서 생략해 존재를 숨김)와는 일관되지 않는다. 내용 차단 파일은 listing에 보이고 `read_file`만 막힌다. 이 차이는 의도한 것이며 `docs/security.md`에 적는다.

### 3.5 Error code와 audit

* **`PATH_BLOCKED`를 재사용한다.** 새 code(`CONTENT_BLOCKED`)는 "이 파일에 credential이 있다"는 사실을 code로 따로 알려 준다. 재사용해도 이름이 평범한 파일이 막히면 model은 같은 추론을 할 수 있어 1 bit는 어느 쪽이든 남지만, client 계약을 늘리지 않는다. M17·M41처럼 새 code를 만들지 않는 선례를 따른다.
* client message는 기존과 같은 `${relativePath} is blocked by the sensitive file policy`다. match한 값, 줄 번호, pattern 종류, host 경로를 넣지 않는다(불변식 4).
* 기존 `PATH_BLOCKED`는 입력 경로 deny면 파일이 없어도 나온다. 내용 차단은 파일을 연 뒤에만 나오므로 존재를 함의한다. listing에 이미 보이는 파일이라 새로 드러나는 정보는 없다.
* audit은 `error_detail`에 `content:<pattern id>`(예: `content:aws_access_key_id`)만 남긴다. 운영자가 오탐을 진단하는 데 필요하고, 값·줄·위치는 남기지 않는다(불변식 6). `search_text`의 조용한 skip은 audit record 하나에 건너뛴 파일 수만 더한다(경로 목록은 넣지 않는다).

### 3.6 비용

* `readRegularFile`은 이미 파일 전체를 `WORKSPACE_MAX_READ_BYTES` 안에서 buffer로 읽고, `search_text`도 줄로 나누기 전에 전체를 decode한다. scan은 memory에 있는 text를 한 번 더 도는 비용이고 read limit에 비례한다.
* `search_text`는 visit하는 파일마다 scan이 한 번 늘어난다. 상한은 기존 `WORKSPACE_MAX_SEARCH_FILES`·read limit·timeout이 그대로 건다. match가 없는 대부분의 파일에서 prefix-anchored alternation 하나라 줄 단위 match보다 싸다.
* 지금 read 경로에는 streaming이 없다. 나중에 streaming read를 넣으면 chunk 경계에 걸친 pattern을 놓치지 않도록 가장 긴 pattern 길이만큼 겹쳐 읽어야 한다. 그때 이 ADR을 다시 본다.

## 4. 구현 범위 (이 ADR에서는 구현하지 않음)

* `src/policy/content-patterns.ts`(신규): pattern 목록과 `findCredentialPattern(text): string | undefined`(pattern id 반환).
* `src/filesystem/file-reader.ts`(`readTextFile`), `src/filesystem/file-search.ts`(scan 후 skip, skip 수 집계), `src/filesystem/file-editor.ts`, `src/filesystem/file-writer.ts`(기존 파일 경로).
* `src/config/config.ts`(`WORKSPACE_CONTENT_SCAN` 파싱·검증), `src/cli.ts`의 `--check` 출력. `get_workspace_info`는 바꾸지 않는다.
* test(security 영향이므로 red-first): pattern별 match·비 match(tail 길이 경계, 단어 중간 prefix), AWS 예제 값 오탐 case, `read_file` window로 우회 불가, `search_text` literal·`regex: true` 양쪽에서 차단 파일 skip과 oracle 부재(차단 파일에 대한 `^.{n}x` 질의가 match 0), `edit_file`·`multi_edit_file` dry run·실제 edit 거부, `write_file` 교체 거부와 새 파일 허용, listing에는 보임, message와 audit에 값·host 경로 없음(`expectNoHostPath`), kill switch `off` 동작, startup 잘못된 값 거부. `pnpm e2e:tunnel`에 차단 case 하나.
* 문서: `docs/reference.md`(`PATH_BLOCKED` 설명에 내용 차단 추가, 환경 변수 표), `docs/security.md`(방어 계층에 내용 차단과 한계, 3.4의 M4 차이), `docs/implementation-notes.md`(새 M 항목, 3절 잔여 위험), README 특징 요약 확인. 채택 시 이 ADR의 Status를 바꾼다.

## 5. Deferred

* **Git 출력**: `git_diff`·`git_show` patch, `git_log` commit message에 같은 scan을 적용하는 것. Git은 opt-in이고 history 노출은 이미 수용한 잔여 위험이다(ADR-004 6절, implementation notes 3절). patch에서 파일 단위로 뺄지 commit 전체를 뺄지, rename·삭제된 과거 blob을 어떻게 다룰지 따로 정해야 한다.
* path allowlist(`test/fixtures/**` 등), pattern별 끄기, workspace별 설정.
* pattern 추가(Stripe `sk_live_`, npm `npm_`, JWT 등). 추가할 때마다 오탐 case를 test로 남긴다.

## 6. Consequences

### Positive

* 이름이 평범한 파일에 든 알려진 형식의 credential이 `read_file`·`search_text`·edit 응답으로 나가지 않는다. 이번 사고와 같은 형태의 key(prefix가 있는 provider key)는 운영자 설정 없이 막힌다.
* 파일 단위 차단이라 redaction의 파일 손상·revision 불일치·oracle 문제가 없다.
* error code와 output schema가 늘지 않는다.

### Negative

* 오탐 파일은 이 서버로 읽거나 고칠 수 없다. 우회는 kill switch뿐이라 오탐 하나 때문에 전체 방어를 끌 수 있다.
* 모든 read·search·edit에 text 한 번의 scan 비용이 더해진다.
* 내용 차단 파일은 listing에 보이지만 읽히지 않는다(M4와 다른 동작).
* 환경 변수가 하나 늘어난다.

### 잔여 위험

* **prefix 없는 secret**: 비밀번호, DB connection string, prefix 없는 provider token, AWS secret access key, 사내 token은 잡지 못한다. 이번 사고의 `API_KEY` 값이 opaque token이었다면 C로도 막히지 않았다. entropy heuristic을 넣지 않은 대가다.
* **형식을 바꾼 secret**: base64·JSON escape·줄바꿈으로 나뉜 key, 압축·binary 파일 안의 key는 match하지 않는다(binary는 원래 읽히지 않는다).
* **Git history**: 5절대로 Git tool 출력에는 적용하지 않는다.
* **1 bit 노출**: 파일이 막혔다는 사실 자체가 "이 파일에 credential 형식 값이 있다"를 알려 준다.
* pattern matching은 backstop이지 경계가 아니다. 경계는 계속 workspace scope와 OS 권한이다(ADR-001 11절). secret이 든 파일은 workspace 밖에 두는 것이 1차 대응이고, 이 layer는 그 실수를 일부 잡을 뿐이다.

## Amendment (2026-09-29): 채택과 구현 결정

C를 채택해 구현했다. 3절에서 정하지 않았거나 구현하며 좁힌 사항은 implementation notes M71~M75에 있다.

* 3.2절 unresolved였던 tail 길이는 gitleaks 규칙을 기준으로 정했고, Tavily는 1차 문서가 없어 보수적인 최소 길이를 택했다(M71).
* `private_key`는 header만으로 match하지 않는다. header가 줄 끝에 있고 다음 줄에 base64가 이어져야 한다. PEM header 문자열을 다루는 코드가 막히지 않게 하려는 것이다(M71).
* 3.3절과 4절의 AWS 예제 값은 원래 literal로 적혀 있었다. 그래서 이 repo를 workspace로 둔 agent가 이 ADR을 읽을 수 없게 되어, 채택할 때 값을 나눠 적거나 설명으로 바꿨다. 결정 내용은 바뀌지 않는다(M75).

관련 문서: [ADR-001](001-architecture.md), [ADR-004](004-git.md), [implementation notes](../implementation-notes.md), [security](../security.md), [reference](../reference.md).
