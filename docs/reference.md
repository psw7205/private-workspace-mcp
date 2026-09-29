# Reference

tool 인자와 동작, error code, 환경 변수 전체 목록이다. 처음 연결하는 절차는 [`getting-started.md`](getting-started.md), 보안 설계는 [`security.md`](security.md)에 있다.

- [공통 규칙](#공통-규칙)
- [Filesystem tools](#filesystem-tools)
- [Git tools (opt-in)](#git-tools-opt-in)
- [Error codes](#error-codes)
- [환경 변수](#환경-변수)
- [Git 운영 메모](#git-운영-메모)

## 공통 규칙

- 모든 path는 workspace root 기준 상대 경로이고 `/`로 구분한다.
- `WORKSPACE_ROOTS`로 띄우면 `get_workspace_info`를 뺀 7개 tool이 필수 인자 `workspace`(설정한 이름의 enum)를 받고, path는 그 workspace root 기준이다(ADR-008). Git tool 4개도 같다. repository가 아닌 workspace는 `NOT_A_REPOSITORY`를 받는다.
- 실패는 `isError: true` tool result로 오며 본문은 `{"error":{"code":"…","message":"…"}}` 형태다. message에는 host 절대 경로가 들어가지 않는다.

## Filesystem tools

| tool | 설명 |
|------|------|
| `get_workspace_info` | workspace 이름과 mode(`WORKSPACE_ROOTS`면 `workspaces: [{ name, mode }]` 목록), platform, limits, `server_version`(실행 중인 서버 version. 배포된 release 확인용). host 절대 경로는 반환하지 않음 |
| `list_directory` | `path`(기본 `.`), `depth`(기본 1), `limit`. 이름순, depth-first. symlink는 따라가지 않고 민감 파일과 특수 파일은 생략 |
| `read_file` | UTF-8 텍스트 파일. `start_line`/`max_lines`로 line pagination. 파일 전체 기준 `revision`(`sha256:…`) 반환 |
| `write_file` | 파일 생성 또는 전체 교체. 기존 파일은 `expected_revision` 필수, 새 파일은 생략. read limit을 넘는 기존 파일은 교체 불가. 없는 parent directory는 생성 |
| `find_files` | `path`(기본 `.`) 아래를 depth 제한 없이 glob으로 검색. 패턴은 `path` 기준 상대 경로에 적용(`**/*.ts`). `*`, `?`, `**`, `{a,b}`만 특수 문자(패턴 256자까지)이고 대소문자를 구분. `.`으로 시작하는 이름은 패턴에 명시해야 맞음. `.gitignore`/`.ignore` 대상은 `include_ignored: true`가 아니면 제외. 결과는 파일 경로와 크기 |
| `search_text` | `path` 아래 UTF-8 텍스트 파일에서 literal 문자열 검색. `regex: true`면 `query`를 RE2 문법 regex로 검색(선형 시간 엔진 `re2js`, backreference·lookaround 없음, `\d`·`\w`·`\b`는 ASCII, 줄 단위라 `^`·`$`는 줄 경계, 256자 이하, 너무 복잡한 패턴은 `INVALID_PATH`). 줄마다 첫 match의 경로·줄·열·줄 내용 반환. `glob`, `case_sensitive`(기본 false), `include_ignored`, `limit`. binary·non-UTF-8·read limit 초과 파일과 내용 검사에 걸린 파일은 건너뜀 |
| `edit_file` | 기존 파일의 exact-match 문자열 교체(ADR-002). `old_string`은 한 번만 나와야 하고 여러 번이면 `replace_all`. `expected_revision` 필수, 새 `revision` 반환. `dry_run: true`면 모든 검사만 하고 쓰지 않은 채 적용 시의 `revision`과 unified `diff`(context 3줄, 64 KiB에서 자르고 `diff_truncated`)를 반환 |
| `multi_edit_file` | 한 파일에 `edits` 배열(최대 100개, 각 항목은 `edit_file`과 같은 `old_string`/`new_string`/`replace_all`)을 순서대로 적용하고 한 번에 쓴다. 뒤 edit는 앞 edit의 결과에 match한다. 하나라도 실패하면 파일은 바뀌지 않고 오류 message가 `edits[i]`로 실패한 edit를 가리킴. 전체·edit별 교체 횟수와 새 `revision` 반환. `dry_run`은 `edit_file`과 같음 |

쓰기 tool(`write_file`, `edit_file`, `multi_edit_file`)은 read-write workspace에서만 동작한다. 나머지는 mode와 무관하다.

내용 검사(ADR-010): 파일 이름이 deny 목록에 없어도 내용에 알려진 형식의 credential(Anthropic·OpenAI·GitHub·GitLab·Slack·Tavily key, Google API key, AWS access key id, PEM·OpenSSH private key)이 있으면 deny 이름과 같게 다룬다. `read_file`, `edit_file`·`multi_edit_file`(`dry_run` 포함), 기존 파일을 교체하는 `write_file`은 `PATH_BLOCKED`를 받고, `search_text`는 그 파일을 건너뛴다. `list_directory`·`find_files`에는 그대로 보인다. binary·non-UTF-8·read limit 초과 파일과 새로 쓰는 content는 검사하지 않는다. `WORKSPACE_CONTENT_SCAN=off`로 끌 수 있다.

## Git tools (opt-in)

`WORKSPACE_GIT=read-only`면 다음 4개가 추가된다(ADR-004). 모두 `readOnlyHint: true`, `destructiveHint: false`이고 `WORKSPACE_MODE`와 무관하게 동작한다.

- workspace root가 repository toplevel이고 `<root>/.git`이 실제 directory일 때만 동작한다. 하위 directory·gitfile(linked worktree, submodule)·symlink `.git`은 `NOT_A_REPOSITORY`다. `objects/info/alternates`·`http-alternates`가 있거나(`git clone --reference`·`--shared`) `.git/objects`가 symlink인 repo도 `NOT_A_REPOSITORY`다.
- rev는 `HEAD`, commit id(hex 4~64자), branch·tag·remote-tracking branch 이름에 `~N`·`^N`만 붙일 수 있다. range, reflog(`@{…}`), `rev:path`, `stash`, notes는 `INVALID_REVISION`이다.

| tool | 설명 |
|------|------|
| `git_status` | 현재 branch(detached면 `null`), HEAD `oid`, `upstream`과 다른지 여부(`upstream_differs`, 개수는 세지 않음), 변경 entry(`path`, `orig_path`, porcelain v2 `index`/`worktree` 상태 글자, untracked는 파일 단위 `?`) |
| `git_diff` | 변경 파일 목록과 unified patch. 기본은 worktree↔index, `staged: true`면 index↔`HEAD`, `base`(와 `head`, 기본 `HEAD`)면 두 commit 사이. `path`로 파일·directory를 제한(지운 파일도 가능). untracked 파일은 없음 |
| `git_log` | `rev`(기본 `HEAD`)부터 commit 목록(`oid`, `parents`, author·committer 이름·email·시각, message). `path`로 그 경로를 바꾼 commit만, `max_count` 기본 20·최대 200. 변경 파일 목록은 없음 |
| `git_show` | commit 1개의 metadata와 first parent 대비 파일 목록·patch(root commit은 빈 tree 대비) |

- deny 대상 파일은 status·diff·show 결과에서 존재 여부도 드러내지 않고 빠진다(과거 commit의 `.env` 포함).
- git 명령 하나의 출력이 `WORKSPACE_MAX_READ_BYTES`를 넘으면 잘리고 `truncated: true`가 된다. patch는 마지막 완전한 파일 section까지 남는다.
- rename detection은 하지 않고 binary 파일은 `Binary files … differ` 한 줄이다.

## Error codes

| code | 의미 |
|------|------|
| `PATH_OUTSIDE_WORKSPACE` | 절대 경로, `..`, symlink 등으로 workspace 밖을 가리킴 |
| `PATH_BLOCKED` | 민감 파일 deny pattern에 걸림, 또는 파일 내용에 credential 형식 값이 있음(내용 검사). message는 같고 audit `error_detail`만 `content:<pattern id>`로 구별된다 |
| `INVALID_PATH` | 경로 문법 오류, 잘못되거나 상한을 넘는 glob·regex 패턴(`find_files`·`search_text`), symlink 대상에 쓰기, 깨진 symlink 아래에 쓰기 |
| `FILE_NOT_FOUND` / `NOT_A_FILE` / `NOT_A_DIRECTORY` | 대상 상태 불일치 |
| `FILE_TOO_LARGE` / `BINARY_FILE` | read/write limit 초과, binary 또는 UTF-8이 아닌 파일, lone surrogate가 든 write content나 `old_string`/`new_string` |
| `READ_ONLY` | read-only workspace에 write 시도(`write_file`·`edit_file`·`multi_edit_file`, `dry_run` 포함) |
| `REVISION_CONFLICT` | 읽은 뒤 파일이 바뀜, 이미 존재하는 파일을 revision 없이 생성 시도 |
| `EDIT_NO_MATCH` / `EDIT_AMBIGUOUS` | `edit_file`·`multi_edit_file`의 `old_string`이 없음, 여러 번 나오는데 `replace_all`이 아님 |
| `NOT_A_REPOSITORY` | Git tool: workspace root가 `.git` directory를 가진 repository toplevel이 아님 |
| `UNSAFE_GIT_CONFIG` | Git tool: repo config가 workspace 안(`.git` 밖) 파일을 include하거나 path 값으로 가리킴, `hook.*` key가 있음. 어떤 key인지는 audit log에만 |
| `INVALID_REVISION` | Git tool: 받지 않는 rev 형식·namespace, 없는 commit, `head`만 주거나 `staged`와 `base`를 함께 줌 |
| `GIT_FAILED` | Git tool: git이 비정상 종료. git stderr는 보내지 않고 audit에 exit code만 남김 |
| `PERMISSION_DENIED` / `TIMEOUT` / `INTERNAL_ERROR` | OS 권한, 시간 초과, 기타 (상세는 audit log에만) |

## 환경 변수

| env | 기본값 | 설명 |
|-----|--------|------|
| `WORKSPACE_ROOT` | (이것 또는 `WORKSPACE_ROOTS` 필수) | 절대 경로. startup 시 realpath로 고정 |
| `WORKSPACE_ROOTS` | (없음) | `name=/abs/path,name2=/abs/path`. workspace 여러 개(ADR-008). 이름은 소문자·숫자·`-`·`_`(64자 이하), 각 항목은 첫 `=`에서 나누며 경로에 `,`는 쓸 수 없음. root끼리 겹치면 거부. `WORKSPACE_ROOT`·`WORKSPACE_NAME`과 함께 쓸 수 없음 |
| `WORKSPACE_MODE` | `read-only` | `read-only` \| `read-write`. `WORKSPACE_ROOTS`에서 `WORKSPACE_READ_WRITE` 없이 쓰면 모든 workspace에 적용 |
| `WORKSPACE_READ_WRITE` | (없음) | `WORKSPACE_ROOTS`에서 read-write로 둘 workspace 이름 목록(예: `api` 또는 `api,web`). 나열하지 않은 workspace는 read-only. 빈 값은 설정하지 않은 것과 같다. 값이 있을 때 `WORKSPACE_ROOT`나 `WORKSPACE_MODE`와 함께 주거나, 없는 이름·중복·빈 항목이 있으면 startup에서 거부 |
| `WORKSPACE_NAME` | root basename | `get_workspace_info`의 `name` (`WORKSPACE_ROOT` 전용) |
| `WORKSPACE_MAX_READ_BYTES` | `1048576` | 이보다 큰 파일은 `FILE_TOO_LARGE` |
| `WORKSPACE_MAX_WRITE_BYTES` | `1048576` | write content 최대 크기 (UTF-8 bytes) |
| `WORKSPACE_MAX_DIRECTORY_ENTRIES` | `1000` | `list_directory` 응답 최대 entry 수 |
| `WORKSPACE_MAX_DEPTH` | `3` | `list_directory` 최대 depth |
| `WORKSPACE_REQUEST_TIMEOUT_MS` | `10000` | tool call timeout. 최대 `2147483647`(Node timer 한도) |
| `WORKSPACE_MAX_SEARCH_FILES` | `10000` | `find_files`/`search_text` 한 번이 살펴보는 파일 수 상한 |
| `WORKSPACE_AUDIT_LOG` | (없음 → stderr) | audit JSONL 파일 절대 경로. 모든 workspace 밖이어야 하며 symlink는 거부. 새로 만들 때 권한 `0600`(이미 있는 파일의 권한은 바꾸지 않음) |
| `WORKSPACE_AUDIT_LOG_MAX_BYTES` | `10485760` | 이 크기를 넘기 전에 `<path>.1`로 rotate (backup 1개) |
| `WORKSPACE_EXTRA_DENY_PATTERNS` | (없음) | 쉼표로 구분한 path segment glob(`*`만 지원). 기본 deny 목록에 추가만 가능 |
| `WORKSPACE_GIT` | (없음 → 꺼짐) | `read-only`면 Git tool 4개를 등록한다. 다른 값은 거부. 켜져 있는데 workspace 밖 `PATH`에서 git을 찾지 못하거나 git이 `--attr-source` 등 필요한 인자를 지원하지 않으면 startup 실패. `--check`가 찾은 git의 version과 경로를 보여준다 |
| `WORKSPACE_CONTENT_SCAN` | `on` | `off`면 내용 검사를 끈다. 빈 값은 `on`, 그 밖의 값은 거부. 오탐 파일을 읽어야 할 때 쓰는 서버 전체 kill switch이고 파일별 예외는 없다 |

- 정수 설정은 1 이상 `Number.MAX_SAFE_INTEGER` 이하여야 한다.
- 값이 잘못되면 stderr에 이유를 출력하고 exit code 1로 종료한다(fail closed).
- stdout은 MCP protocol 전용이다. startup 메시지는 stderr로, audit log는 `WORKSPACE_AUDIT_LOG`가 있으면 그 파일로, 없으면 stderr로 나간다.

### CLI 인자

| 인자 | 동작 |
|------|------|
| (없음) | stdio MCP 서버로 대기 |
| `--check` | 서버를 띄우지 않고 startup과 같은 검증만 한 뒤, 해석된 workspace root(canonical 경로)와 mode, limit, audit 출력처, 내용 검사 여부를 stderr에 요약한다. 설정이 틀리면 startup과 같은 오류를 내고 exit 1이다. audit file은 만들지 않는다 |
| `--version` | version 출력 |

그 밖의 인자를 주면 usage를 내고 exit 2로 끝난다.

## Git 운영 메모

- Git을 켤 때는 workspace root를 repository toplevel(main checkout)로 둔다.
- Windows는 Git for Windows를 전제로 하고, PATH의 launcher(`bin\git.exe`, `cmd\git.exe`) 대신 `git --exec-path`로 찾은 실제 `<prefix>\bin\git.exe`를 실행한다(종료 시 손자 process가 남지 않게). 그 배치가 아니면 startup에서 거부한다.
- system config를 읽지 않으므로 Git for Windows가 system에 두는 `core.autocrlf=true`가 빠져 `git_status`가 운영자의 git과 다르게 보일 수 있다. 필요하면 repo config에 둔다.
- LFS처럼 filter가 필요한 파일은 filter를 끄므로 stat만 바뀌어도 modified로 보일 수 있다.
- repo config가 worktree 안 파일을 include하거나 `hook.*`을 쓰면 Git tool은 동작하지 않는다.
