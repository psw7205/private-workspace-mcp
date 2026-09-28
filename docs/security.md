# 보안 모델

이 서버는 coding agent가 아니라 capability provider다. model이 할 수 있는 일을 workspace 안의 파일 읽기·쓰기와 (켰을 때) read-only Git 조회로 좁힌다. shell과 임의 process 실행은 제공하지 않는다(PRD 4, ADR-001 §15).

설계 근거는 [`adr/001-architecture.md`](adr/001-architecture.md), [`adr/004-git.md`](adr/004-git.md), 수용한 잔여 위험은 [`implementation-notes.md`](implementation-notes.md) 3절에 있다.

## 방어 계층

- **workspace 고정**: root는 서버 설정(`WORKSPACE_ROOT` 또는 `WORKSPACE_ROOTS`)으로만 정하고 startup 시 realpath로 고정한다. MCP Roots는 쓰지 않는다. root가 사실상 sandbox 경계이므로 filesystem root, home directory, home의 상위 directory는 startup에서 거부한다. 여러 root는 서로 겹칠 수 없다. agent 전용 directory를 root로 쓴다.
- **`PathGuard`**: workspace마다 하나다. 입력 문법 검사(`..`, 절대/drive/UNC 경로, Windows alias 거부) 후 realpath로 canonical 경로를 구해 containment를 판정한다. 문자열 prefix 비교는 쓰지 않는다.
- **민감 파일 deny**: `.env`, `.env.*`, `*.pem`, `*.key`, `.ssh`, `.aws`, `.gnupg`, `.npmrc`, `.netrc`, `credentials*`, `secret*`, `.git`, `.git-credentials`, `service-account*.json`, `id_rsa*`, `id_ed25519*`, `*.tfstate`, `*.tfstate.*`, `.kube`, `kubeconfig*`, `.docker`, `.pypirc`, `*.p12`, `*.pfx`. 입력 경로와 canonical 경로 양쪽에 case-insensitive로 적용한다. 운영자는 추가만 할 수 있다(`WORKSPACE_EXTRA_DENY_PATTERNS`).
- **안전한 write**: 기본 read-only. `WORKSPACE_ROOTS`면 `WORKSPACE_READ_WRITE`에 나열한 workspace만 쓸 수 있다(`WORKSPACE_READ_WRITE` 없이 `WORKSPACE_MODE=read-write`면 모든 workspace). 기존 파일은 revision이 일치할 때만 temp file + fsync + atomic rename으로 교체하고, 새 파일은 `link()`로 생성해 덮어쓰지 않는다.
- **audit**: tool call마다 JSON Lines 1건(요청 id, tool, `WORKSPACE_ROOTS`면 workspace 이름, path, edit dry run이면 `dry_run: true`, 성공 여부, 소요 시간, bytes, error code). 파일 내용과 secret은 기록하지 않는다.
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

history는 현재 이름 기준 deny로 막지 못하는 내용(rename된 secret, 과거 파일, commit message)을 드러내므로 기본은 꺼짐이다. 잔여 위험은 implementation notes 3절에 있다.

## 최종 경계는 OS 권한

path 검증은 defense-in-depth다. 최종 보안 경계는 전용 OS 사용자나 container 같은 OS 권한이다(ADR-001 §11). container로 띄우는 방법은 [`getting-started.md`](getting-started.md#container로-격리하기)에 있다.

## Prompt injection과 client 승인

read-write 모드에서는 model이 읽은 파일 내용에 심어진 지시(prompt injection)가 `write_file`·`edit_file` 호출로 이어질 수 있다(`multi_edit_file`도 같다). revision 검사는 lost update를 막을 뿐 이 경로를 막지 않는다(model도 `read_file`로 revision을 얻는다).

서버는 쓰기 tool 모두에 `readOnlyHint: false`, `destructiveHint: true`를, 읽기 tool(Git tool 포함) 모두에 `readOnlyHint: true`, `destructiveHint: false`를 선언한다. annotations는 tool 단위라 `dry_run` 호출에도 같다. client 쪽 approval은 서버 권한 판단의 근거가 아닌 보조 방어로 쓴다(ADR-001 §14).

- **Responses API**: `require_approval: {"never": {"tool_names": ["get_workspace_info", "list_directory", "read_file", "find_files", "search_text"]}}`로 읽기 tool만 자동 실행하고 나머지는 승인을 받는다. `WORKSPACE_GIT=read-only`면 `git_status`, `git_diff`, `git_log`, `git_show`도 읽기 tool이지만 history는 deny 이름으로 막지 못하는 과거 내용을 드러내므로, 자동 실행 목록에 넣을지는 따로 판단한다. 쓰기가 필요 없으면 `allowed_tools`로 읽기 tool만 노출하거나 서버를 read-only로 띄운다.
- **ChatGPT**: write tool 호출 확인을 끄지 않는다.
