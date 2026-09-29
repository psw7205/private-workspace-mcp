# 보안 모델

이 서버는 coding agent가 아니라 capability provider다. model이 할 수 있는 일을 workspace 안의 파일 읽기·쓰기와 (켰을 때) read-only Git 조회로 좁힌다. shell과 임의 process 실행은 제공하지 않는다(PRD 4, ADR-001 §15).

설계 근거는 [`adr/001-architecture.md`](adr/001-architecture.md), [`adr/004-git.md`](adr/004-git.md), 세부 결정은 [`implementation-notes.md`](implementation-notes.md)의 M 항목에 있다. 수용한 잔여 위험은 [알려진 한계](#알려진-한계)에 있다.

## 방어 계층

- **workspace 고정**: root는 서버 설정(`WORKSPACE_ROOT` 또는 `WORKSPACE_ROOTS`)으로만 정하고 startup 시 realpath로 고정한다. MCP Roots는 쓰지 않는다. root가 사실상 sandbox 경계이므로 filesystem root, home directory, home의 상위 directory는 startup에서 거부한다. 여러 root는 서로 겹칠 수 없다. agent 전용 directory를 root로 쓴다.
- **`PathGuard`**: workspace마다 하나다. 입력 문법 검사(`..`, 절대/drive/UNC 경로, Windows alias 거부) 후 realpath로 canonical 경로를 구해 containment를 판정한다. 문자열 prefix 비교는 쓰지 않는다.
- **민감 파일 deny**: `.env`, `.env.*`, `*.pem`, `*.key`, `.ssh`, `.aws`, `.gnupg`, `.npmrc`, `.netrc`, `credentials*`, `secret*`, `.git`, `.git-credentials`, `service-account*.json`, `id_rsa*`, `id_ed25519*`, `*.tfstate`, `*.tfstate.*`, `.kube`, `kubeconfig*`, `.docker`, `.pypirc`, `*.p12`, `*.pfx`. 입력 경로와 canonical 경로 양쪽에 case-insensitive로 적용한다. 운영자는 추가만 할 수 있다(`WORKSPACE_EXTRA_DENY_PATTERNS`).
- **내용 기반 차단** (ADR-010): 이름 deny는 `backup.json`, `notes.md`, DB dump처럼 평범한 이름의 파일에 든 secret을 막지 못한다. 그래서 파일 내용에 provider prefix가 있는 key나 private key가 있으면 파일 전체를 deny처럼 다룬다. 일부만 가리지 않는 이유는 두 가지다. 가린 내용을 model이 다시 쓰면 파일이 손상되고, match 여부 자체가 한 글자씩 값을 복원하는 oracle이 되기 때문이다. `read_file`·edit tool·기존 파일 교체는 `PATH_BLOCKED`, `search_text`는 match 전에 건너뛴다. 기본으로 켜져 있고 `WORKSPACE_CONTENT_SCAN=off`로만 끈다.
  - 차단 파일은 `list_directory`·`find_files`에 보인다. deny 이름을 목록에서 숨기는 것과 다르다. listing마다 파일 내용을 읽지 않기 위한 의도한 차이다.
  - prefix 없는 secret(비밀번호, connection string, AWS secret access key), base64 등으로 형식을 바꾼 key, Git history(`git_diff`·`git_show`·`git_log`)는 막지 못한다. 차단 자체가 "credential 형식 값이 있다"는 사실을 드러낸다. secret 파일은 workspace 밖에 두는 것이 1차 대응이고, 이 layer는 그 실수를 일부 잡을 뿐이다.
  - 문서화된 예제 값(AWS 문서의 예제 access key id 등)도 실제 key와 형식이 같아 막힌다. 파일별 예외는 없다.
- **안전한 write**: 기본 read-only. `WORKSPACE_ROOTS`면 `WORKSPACE_READ_WRITE`에 나열한 workspace만 쓸 수 있다(`WORKSPACE_READ_WRITE` 없이 `WORKSPACE_MODE=read-write`면 모든 workspace). 기존 파일은 revision이 일치할 때만 temp file + fsync + atomic rename으로 교체하고, 새 파일은 `link()`로 생성해 덮어쓰지 않는다.
- **audit**: tool call마다 JSON Lines 1건(요청 id, tool, `WORKSPACE_ROOTS`면 workspace 이름, path, edit dry run이면 `dry_run: true`, 성공 여부, 소요 시간, bytes, error code, 내용 검사로 막히면 `error_detail`의 pattern id, `search_text`가 건너뛴 파일 수 `content_blocked`). 파일 내용과 secret은 기록하지 않는다.
- **오류 비노출**: client에 가는 message에는 host 절대 경로와 Node error message를 넣지 않는다. 모르는 오류는 `INTERNAL_ERROR`로 바꾸고 상세는 audit log에만 남긴다.

## Git (opt-in)

`WORKSPACE_GIT=read-only`일 때만 켜진다.

- system `git`을 shell 없이 startup에 고정한 절대 경로로 실행한다(workspace 안의 `git`은 쓰지 않음).
- child env는 상속하지 않고 새로 만들어 `CONTROL_PLANE_API_KEY`, `GIT_*`, `SSH_*`, `HOME`이 가지 않는다.
- system·global config, pager, hooks, fsmonitor, filter, textconv, external diff, 서명 검증, network(lazy fetch 포함), replace ref를 인자·env로 끄고, worktree `.gitattributes` 대신 HEAD의 것만 읽는다. index를 다시 쓰는 명령은 쓰지 않는다.
- 호출마다 repository 경계와 repo config를 확인한다. alternates(`objects/info/alternates`, `http-alternates`)가 있거나 `.git/objects`가 symlink인 repo는 root 밖 object store를 읽을 수 있어 `NOT_A_REPOSITORY`로 거부한다. repo config가 model이 쓸 수 있는 파일을 끌어오면 `UNSAFE_GIT_CONFIG`로 거부한다.
- rev는 hex OID로 바꾼 뒤에만 넘겨 option injection이 구조적으로 막힌다.
- deny 목록은 pathspec exclude와 파일 목록 검사 두 겹으로 적용한다.
- timeout·출력 상한·서버 종료 때 git process group 전체를 끝낸다(POSIX).

history는 현재 이름 기준 deny로 막지 못하는 내용(rename된 secret, 과거 파일, commit message)을 드러내므로 기본은 꺼짐이다. 잔여 위험은 [알려진 한계](#알려진-한계)에 있다.

## 최종 경계는 OS 권한

path 검증은 defense-in-depth다. 최종 보안 경계는 전용 OS 사용자나 container 같은 OS 권한이다(ADR-001 §11). container로 띄우는 방법은 [`getting-started.md`](getting-started.md#container로-격리하기)에 있다.

## Prompt injection과 client 승인

read-write 모드에서는 model이 읽은 파일 내용에 심어진 지시(prompt injection)가 `write_file`·`edit_file` 호출로 이어질 수 있다(`multi_edit_file`도 같다). revision 검사는 lost update를 막을 뿐 이 경로를 막지 않는다(model도 `read_file`로 revision을 얻는다).

서버는 쓰기 tool 모두에 `readOnlyHint: false`, `destructiveHint: true`를, 읽기 tool(Git tool 포함) 모두에 `readOnlyHint: true`, `destructiveHint: false`를 선언한다. annotations는 tool 단위라 `dry_run` 호출에도 같다. client 쪽 approval은 서버 권한 판단의 근거가 아닌 보조 방어로 쓴다(ADR-001 §14).

- **Responses API**: `require_approval: {"never": {"tool_names": ["get_workspace_info", "list_directory", "read_file", "find_files", "search_text"]}}`로 읽기 tool만 자동 실행하고 나머지는 승인을 받는다. `WORKSPACE_GIT=read-only`면 `git_status`, `git_diff`, `git_log`, `git_show`도 읽기 tool이지만 history는 deny 이름으로 막지 못하는 과거 내용을 드러내므로, 자동 실행 목록에 넣을지는 따로 판단한다. 쓰기가 필요 없으면 `allowed_tools`로 읽기 tool만 노출하거나 서버를 read-only로 띄운다.
- **ChatGPT**: write tool 호출 확인을 끄지 않는다.

## 알려진 한계

막지 않고 수용한 잔여 위험이다. 여기 적힌 것보다 영향이 크다는 근거가 있으면 [`SECURITY.md`](../.github/SECURITY.md) 절차로 보고한다.

- **TOCTOU**: 경로 검증과 실제 open 사이에 로컬 프로세스가 중간 directory를 symlink로 바꾸면 우회할 수 있다. Node에는 `openat2(RESOLVE_BENEATH)`가 없다. 마지막 component는 `O_NOFOLLOW`로 open해 줄이지만, 최종 경계는 ADR 11대로 OS 권한이다.
- **hard link**: workspace 안에 외부 파일로 향하는 hard link가 있으면 읽을 수 있다. 이런 link를 만들려면 이미 해당 파일 권한이 있어야 하므로 OS 권한 경계에 맡긴다. write는 rename 방식이라 link 대상 inode를 수정하지 않는다.
- **기존 파일 교체 시 metadata**: temp file + rename은 새 inode를 만들므로 owner/group, xattr(macOS extended attribute 포함), ACL, SELinux label은 보존되지 않는다. 새 파일은 서버 process의 uid와 OS 규칙에 따른 group을 갖는다. 원래 파일에서 가져오는 것은 permission bit(`mode & 0o7777`)뿐이고, temp file을 그 mode로 만든 뒤 rename 직전에 `chmod`로 다시 맞춘다(`file-writer.ts`).
- **revision check와 rename 사이의 사용자 편집**: 아주 짧은 window가 남는다. 동일 process 내 agent 요청끼리는 lock으로 막는다.
- **timeout 직후 commit**: write는 `link()`/`rename()` 직전에 abort를 확인하지만(M43), 그 검사 뒤 timeout이 나거나 syscall이 이미 진행 중이면 client가 `TIMEOUT`을 받은 뒤에도 쓰기가 끝날 수 있다. `TIMEOUT` message대로 재조회로 결과를 확인해야 한다.
- **abort된 새 파일 write의 빈 directory**: lock 획득 직후 검사와 commit 직전 검사 사이에 abort되면, 중첩 경로의 새 파일 write가 `createMissingDirectories`로 만든 부모 directory는 빈 채로 남는다. `REVISION_CONFLICT`(concurrent create의 `EEXIST`) 등 기존 실패 경로와 같은 동작이며 파일 내용은 쓰지 않는다.
- **edit dry run의 동기 CPU 시간**: `multi_edit_file` dry run의 segment 추적은 O(edit 수 × segment 수)이고 동기로 돈다(M50). 최대 크기 파일에 짧은 `replace_all` 100개를 걸면 수 초 동안 event loop를 점유하고, 그동안 `runTool` timeout도 발화하지 못한다. 측정한 최악 사례(3.2초)는 기본 timeout 안이고 실제 edit의 `split`/`join`도 같은 성격의 비용(1.0초)이 있어, read limit과 `MAX_EDITS`로 상한을 두는 것으로 수용한다
- **v0.1.0 license 고지 누락**: v0.1.0 Release의 `THIRD_PARTY_LICENSES.txt`에는 SDK dist에 미리 묶인 6개 package(M51)의 license가 없다. 해당 코드는 `index.mjs`에 들어 있다. 다음 release부터 포함되며, 이미 올라간 v0.1.0 asset은 attestation과 checksum을 깨지 않도록 바꾸지 않는다
- **v0.1.0 deny의 줄바꿈 누락**: v0.1.0에서는 deny pattern의 `*`가 line terminator와 match하지 않아(M64), `secret\nx.txt`처럼 이름에 줄바꿈이 든 host 파일이 `list_directory`·`find_files`에 나오고 `search_text`로 내용이 읽혔다. ` `·` `가 든 이름과 그런 이름을 가리키는 symlink는 `read_file`로도 읽혔다. 다음 release(v0.2.0)부터 막힌다. deny는 보조 방어(PRD 9)이고, 노출되려면 그런 이름의 민감 파일이 host에 이미 있어야 한다
- **Windows 실동작**: 경로 문법 방어는 OS와 무관하게 적용했다. 하지만 junction, 8.3 short name, case 처리 등 실제 Windows 동작은 로컬에 Windows host가 없어 검증하지 못했다. `.github/workflows/ci.yml`의 `windows-latest` job이 test suite를 실행한다. 첫 실행에서 오류 code 차이 1건이 나와 M28로 고쳤고, M28 반영 후 재실행에서 통과했다([검증 기록](archive/verification-log.md)).
- **prompt injection을 통한 write**: read-write 모드에서 model이 읽은 파일에 심어진 지시가 `write_file`·`edit_file`·`multi_edit_file` 호출로 이어질 수 있다. revision은 model도 `read_file`로 얻으므로 방어가 아니다. 서버는 read-only 기본값과 `destructiveHint`만 제공하고, 승인은 client 설정([위](#prompt-injection과-client-승인))에 맡긴다. 피해 복구 수단(revision history, rollback)은 PRD Phase 2 범위다.
- **regex 한 줄의 동기 비용**: `regex: true`의 줄 하나 matching은 끊을 수 없다. 상한(M46) 안에서 가장 무거운 패턴과 `WORKSPACE_MAX_READ_BYTES` 기본값(1 MiB)의 한 줄짜리 파일(minified 파일 등)이면 약 2~3초 동안 event loop가 막히고, 그동안 같은 stdio connection의 다른 요청도 기다린다. 비용은 read limit에 비례한다.
- **Git: 열거하지 못한 config 실행 경로** (ADR-004 6절): 2.3절 인자·env는 알려진 실행 key를 끄는 denylist다. 이후 git version이 read 경로에 새 config 기반 program 실행을 넣으면 운영자 `.git/config`(root 밖 include 포함)의 그 값이 실행된다. startup option 확인은 이를 잡지 못한다. `--no-textconv`·`--no-ext-diff`는 plumbing(`diff-tree`·`diff-files`·`diff-index`)이 원래 textconv·external diff를 실행하지 않아 mutation test로 구별되지 않는다([검증 기록](archive/verification-log.md)). git을 올릴 때 ADR 목록과 함께 다시 본다.
- **Git: history 노출**: 이름 기준 deny는 rename된 secret, deny에 없는 이름의 과거 파일, commit message·author를 막지 못한다. 알려진 OID로 HEAD history 밖 commit(stash의 untracked commit 등)을 직접 지정하는 것도 막지 않는다(OID를 알 수단은 주지 않음). tracked symlink target이나 파일 내용의 host 경로도 그대로 나간다(M63).
- **Git: 고아 process와 object 경계**: 서버가 `SIGKILL`로 죽으면 git process group이 남을 수 있다. 쓰지 않고 도는 작업(큰 repo의 status scan)은 끝날 때까지 남는다. `objects/info/alternates`·`http-alternates`가 있거나 `.git/objects`가 symlink인 repo는 이제 `NOT_A_REPOSITORY`로 거부되어 root 밖 object store를 읽지 않는다(M70). `objects/pack`처럼 `objects` 아래 하위 directory의 symlink는 검사하지 않으며, 운영자가 쓴 `.git` 안에 있으므로 OS 권한 경계에 맡긴다.
- **Git: ownership과 Windows**: 명시적 `GIT_DIR`에서 git 자체의 `safe.directory` 검사 여부는 unresolved(다른 uid repo로 확인하지 못함). Node uid 검사로 대신하지만 Windows에는 없다. Windows에는 process group이 없다. 서버는 launcher 대신 실제 `git.exe`를 실행해 kill 하나로 끝나게 했지만(M67), 이후 git version이 read 경로에서 child process를 띄우면 그 손자는 kill에 닿지 않는다(2.3절 hardening이 알려진 경로를 끔). null device 값(M52), `GIT~1` alias(M66)는 `windows-latest` CI로 해소했다.
- **Git: 호출당 비용**: 호출마다 `rev-parse`와 `config --list`가 추가로 돌아 child가 3~6개 뜬다. process당 동시 실행 2개 제한 때문에 여러 요청이 몰리면 대기 시간이 timeout에 포함된다.
- **내용 기반 차단의 한계** (ADR-010 6절): prefix가 없는 secret(비밀번호, DB connection string, AWS secret access key, 사내 token)과 형식을 바꾼 secret(base64, JSON escape, 줄바꿈으로 나뉜 key)은 막지 못한다. 차단 자체가 "이 파일에 credential 형식 값이 있다"는 1 bit를 드러낸다. 차단 파일도 listing에는 보인다(M4와 다름). 오탐을 우회할 수단은 서버 전체 kill switch뿐이다. Git tool 출력에는 적용하지 않는다(ADR-010 5절).
- **child 환경 변수 상속**: `tunnel-client`의 환경(`CONTROL_PLANE_API_KEY` 포함)이 MCP child에 그대로 상속된다. 서버는 환경 변수를 어떤 tool로도 노출하지 않지만, 격리가 필요하면 `--mcp-command`를 `env -u CONTROL_PLANE_API_KEY -u OPENAI_API_KEY ...`로 감싼다.
