# ADR-008 — Multi-workspace

* Status: Accepted
* Date: 2026-09-24
* Scope: PRD 16 Phase 11 (Multi-workspace) 첫 단계

## 1. Context

지금은 tunnel 하나가 workspace 하나다. 한 머신에서 repo 여러 개를 쓰려면 repo마다 tunnel, `tunnel-client` profile, daemon, health port, audit 파일, ChatGPT connector를 따로 둔다. 공통 상위 directory를 root로 잡으면 다른 repo와 home 아래 파일까지 노출되고, 상위에 둔 symlink는 root 밖이라 `PATH_OUTSIDE_WORKSPACE`로 거부된다.

`tunnel-client`(0.0.14)는 한 instance에 channel별 stdio command를 여러 개 둘 수 있다(`--mcp.command "channel=<name>,command=..."`). 그러나 어느 channel로 보낼지는 OpenAI tunnel-service가 정하고, channel이 비면 `main`이다. ChatGPT connector 설정과 Responses API의 `type: mcp`(`tunnel_id`, `server_url`)에는 channel을 고르는 필드가 없다. 따라서 channel별 workspace는 지금 쓸 수 없고, 가능해져도 connector가 workspace 수만큼 필요하다.

ADR-001 21절은 multi-workspace policy를 이 ADR로 미뤘고, PRD 16 Phase 11은 절대 경로 대신 서버가 관리하는 ID로 workspace를 고르는 형태를 제시한다.

## 2. Decision

서버 process 하나가 설정된 workspace 여러 개를 다루고, tool 호출마다 `workspace` 인자로 대상을 고른다.

### 2.1 설정

```text
WORKSPACE_ROOTS=api=/abs/path/api,web=/abs/path/web
```

* 항목은 `,`로 나누고 각 항목은 첫 `=`에서 이름과 절대 경로로 나눈다. 경로에 `,`가 있으면 쓸 수 없다. Windows drive 경로(`C:\...`)는 그대로 쓴다.
* 이름은 `^[a-z0-9][a-z0-9_-]{0,63}$`이고 중복될 수 없다. model 인자, audit, 오류 메시지에 그대로 들어가므로 좁게 잡는다.
* 각 root에 `WORKSPACE_ROOT`와 같은 검사(절대 경로, realpath 고정, directory, 넓은 root 거부)를 적용한다.
* canonical root가 서로 같거나 한쪽이 다른 쪽 안에 있으면 startup을 거부한다. 겹치면 한 파일에 두 경로가 생겨 workspace별 판단이 흐려지고, 같은 파일을 두 이름으로 쓸 수 있다.
* `WORKSPACE_AUDIT_LOG`는 모든 root 밖이어야 한다.
* `WORKSPACE_ROOTS`와 `WORKSPACE_ROOT` 또는 `WORKSPACE_NAME`을 함께 주면 startup을 거부한다(fail closed).
* mode, limits, deny 목록, audit 설정은 모든 workspace가 공유한다. workspace별 policy는 필요해질 때 설정 파일과 함께 별도 결정으로 다룬다.

> **Amendment (2026-09-24):** mode는 workspace별로 정한다(PRD 16 Phase 8 첫 단계). `WORKSPACE_READ_WRITE=api,web`처럼 쓰기를 허용할 workspace 이름을 `,`로 나열하고, 나열하지 않은 workspace는 read-only다. `WORKSPACE_READ_WRITE`는 `WORKSPACE_ROOTS`와만 쓸 수 있고, `WORKSPACE_MODE`와 함께 주면 값과 상관없이 startup을 거부한다. 없는 이름, 두 번 나온 이름, 빈 항목도 거부한다. `WORKSPACE_READ_WRITE` 없이 `WORKSPACE_MODE=read-write`를 주면 지금처럼 모든 workspace가 read-write다. mode를 `WORKSPACE_ROOTS` 항목 문법(`api=/abs:rw` 등)에 넣지 않는 이유는 Windows drive 경로의 `:`와 겹치고 parser가 복잡해지기 때문이다. limits, deny 목록, audit 설정은 계속 공유한다. 세부 결정은 `docs/implementation-notes.md` M37~M39에 둔다.

### 2.2 Tool 인터페이스

* `WORKSPACE_ROOTS`로 시작하면(항목이 하나여도) path를 받는 tool 6개에 필수 인자 `workspace`가 붙는다. schema는 설정된 이름의 enum이라 model이 `tools/list`만으로 선택지를 알고, 없는 이름은 SDK 입력 검증에서 거부된다.
* `get_workspace_info`는 `{ workspaces: [{ name }], mode, platform, limits }`를 반환한다. host 경로는 넣지 않는다.
* 한 호출은 workspace 하나만 다룬다. 여러 workspace를 한 번에 검색하지 않는다.
* `WORKSPACE_ROOT`로 시작하면 tool schema, 출력, audit이 이전과 같다.

> **Amendment (2026-09-24):** multi mode의 `get_workspace_info`는 `{ workspaces: [{ name, mode }], platform, limits }`를 반환한다. mode가 섞이면 top-level `mode` 하나로는 맞는 값이 없고, 어느 값을 넣어도 model이 잘못 판단할 수 있어 뺀다. `write_file`과 `edit_file`의 description은 startup 시점에 쓰기 가능한 workspace 이름을 적는다. annotations는 바꾸지 않는다. single mode(`WORKSPACE_ROOT`)의 schema와 출력은 그대로다.

> **Amendment (2026-09-24, 2):** `multi_edit_file`(ADR-002 4절 Amendment)이 추가되어 path를 받는 tool은 7개다. multi mode에서는 7개 모두 필수 인자 `workspace`를 받는다. `multi_edit_file` description도 `write_file`·`edit_file`과 같이 쓰기 가능한 workspace 이름을 적는다.

### 2.3 내부 구조

* workspace마다 `PathGuard`를 만들고 tool은 `workspace` 인자로 guard를 고른다. filesystem 모듈은 guard 하나만 받는 지금 구조를 유지하므로 containment와 deny 규칙(AGENTS.md 보안 불변식 1~3)은 workspace마다 그대로 적용된다.
* 같은 canonical path에 대한 write lock(M14)은 root가 겹치지 않으므로 바꾸지 않는다.
* audit record에는 `WORKSPACE_ROOTS`일 때 `workspace` 이름을 넣는다. 이름은 운영자가 정한 값이고 client에도 공개되는 값이라 secret이 아니다.

## 3. Consequences

### Positive

* tunnel, daemon, health port, audit 파일, connector가 머신당 하나로 줄어든다.
* 공통 상위 directory를 root로 잡지 않고도 repo 여러 개를 한 대화에서 쓴다.
* 기존 `WORKSPACE_ROOT` 설정은 그대로 동작한다.

### Negative

* 한 tunnel의 모든 workspace는 접근 주체가 같다. ADR-001 17절 Amendment대로 해당 tunnel에 Tunnels Use 권한이 있는 사용자는 모든 workspace를 호출할 수 있다. 권한이나 용도가 다른 repo는 지금처럼 tunnel을 나눈다.
* mode가 공유되므로 read-write로 띄우면 모든 workspace가 쓰기 가능하다. 일부만 쓰기가 필요하면 tunnel을 나눈다.
* workspace를 추가하거나 빼면 tool schema가 바뀌므로 daemon 재시작 뒤 connector Refresh가 필요하다.
* OS 권한 경계(ADR-001 11절)를 container로 만들 때 mount가 workspace 수만큼 늘어난다.

> **Amendment (2026-09-24):** "mode가 공유되므로" 항목은 `WORKSPACE_READ_WRITE`(2.1절 Amendment)로 해소한다. 일부 repo만 쓰기가 필요하면 tunnel을 나누지 않고 그 이름만 나열한다. 접근 주체가 같다는 항목은 그대로 남는다. 권한이 다른 사용자에게 줄 repo는 여전히 tunnel을 나눈다.

## 4. Alternatives Considered

* **channel별 stdio child**: OpenAI 제품에서 channel을 고를 수 없어 동작하지 않는다(1절).
* **공통 상위 directory 아래 가상 mount**(`api/src/...`): tool schema는 그대로지만 경로 첫 segment에 따라 다른 root로 가는 규칙을 `PathGuard`에 넣어야 하고, `.` 목록 조회가 특수해진다. 보안 판정이 경로 규칙 안에 숨는다.
* **gateway가 workspace별 서버를 띄우고 tool 이름에 prefix**: process 격리는 얻지만 tool 수가 workspace 수에 비례해 늘고 child 관리가 새로 생긴다.
* **호출로 현재 workspace를 바꾸는 tool**: stdio child 하나를 모든 caller가 공유하고 `2026-07-28` 요청은 self-contained라, 대화 사이에 선택 상태가 섞인다.
