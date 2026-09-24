# Private Workspace MCP — Product Requirements Document

## 1. 개요

Private Workspace MCP는 private 머신의 제한된 파일시스템을 ChatGPT 등 MCP client에서 안전하게 탐색하고 읽고 수정할 수 있도록 제공하는 자체 MCP(Model Context Protocol) 서버다.

외부 연결에는 OpenAI Secure MCP Tunnel을 사용한다.

전체 구조는 다음과 같다.

```text
ChatGPT
   │
   │ MCP request
   ▼
OpenAI Secure MCP Tunnel
   │
   │ outbound HTTPS
   ▼
tunnel-client
   │
   │ stdio
   ▼
Private Workspace MCP
   │
   ▼
Configured Workspace
```

MCP 서버 자체를 인터넷에 공개하지 않는다.

`tunnel-client`가 OpenAI에 outbound HTTPS 연결을 생성하고, MCP 서버는 `tunnel-client`의 child process로 실행되어 stdio로 통신한다.

---

## 2. 문제 정의

ChatGPT와 같은 원격 AI agent가 private 개발 머신에서 작업하려면 다음 capability가 필요하다.

* 프로젝트 구조 탐색
* 파일 및 디렉터리 조회
* 파일 내용 읽기
* 파일 생성
* 파일 수정

일반적인 MCP 서버를 사용할 수도 있지만 다음 문제가 있다.

* 범용 MCP는 필요 이상의 권한을 제공하는 경우가 많다.
* shell access가 포함되면 사실상 원격 코드 실행 권한이 된다.
* third-party MCP의 보안 정책과 업데이트를 신뢰해야 한다.
* workspace 경계와 write 정책을 프로젝트 요구사항에 맞게 제어하기 어렵다.
* agent용 기능을 이후 점진적으로 확장하기 어렵다.

따라서 최소한의 capability부터 직접 구현한다.

---

## 3. 목표

MVP의 목표는 다음과 같다.

1. OpenAI Secure MCP Tunnel을 통해 private 머신의 MCP 서버를 ChatGPT에서 사용할 수 있다.
2. 지정된 workspace 내부만 탐색할 수 있다.
3. 지정된 workspace 내부 파일을 읽을 수 있다.
4. 지정된 workspace 내부에 파일을 생성하거나 수정할 수 있다.
5. workspace 밖으로 탈출하는 모든 파일 접근을 차단한다.
6. 파일 변경 충돌을 탐지할 수 있다.
7. 서버는 public HTTP listener 없이 stdio만으로 동작할 수 있다.
8. 추후 shell, Git, process execution 등을 추가할 수 있는 구조를 유지한다.

---

## 4. Non-goals — MVP

MVP에서는 다음 기능을 구현하지 않는다.

* Bash / shell 명령 실행
* arbitrary process spawning
* Git 명령 실행
* package manager 실행
* build/test 실행
* SSH
* Docker/Kubernetes 조작
* 브라우저 자동화
* LSP(Language Server Protocol) 기반 semantic analysis
* GitHub API
* 여러 머신 관리
* 자체 AI agent loop
* 자체 LLM 호출
* 자체 tunnel 구현
* public MCP endpoint 제공
* OAuth 서버 구현
* 웹 관리 UI

특히 MVP MCP는 **coding agent 자체가 아니다.**

AI reasoning과 orchestration은 ChatGPT가 담당하고 MCP 서버는 제한된 capability provider 역할만 한다.

---

# 5. Target Environment

초기 대상은 개인 또는 관리 가능한 private Linux/macOS/Windows 머신이다.

대표 구성:

```text
Private machine

tunnel-client
     │
     └── stdio
           │
           ▼
     workspace-mcp
           │
           ▼
     /workspace/project
```

운영 환경에서는 가능하면 별도 OS 사용자 또는 컨테이너를 권장한다.

예:

```text
agent-user

/workspace/project    rw
/home/agent-user      제한
~/.ssh                접근 불가
~/.aws                접근 불가
sudo                  없음
```

MCP 서버의 path validation은 defense-in-depth이고 실제 최종 보안 경계는 OS filesystem permission이어야 한다.

---

# 6. 사용자 시나리오

## 6.1 프로젝트 구조 확인

사용자:

> 현재 프로젝트 구조 파악해줘.

ChatGPT:

```text
list_directory(".")
list_directory("src")
read_file("package.json")
```

MCP 서버는 configured workspace 안에서만 요청을 수행한다.

---

## 6.2 파일 분석

사용자:

> API 서버 구조를 분석해줘.

ChatGPT:

```text
list_directory("src")
read_file("src/server.ts")
read_file("src/routes/index.ts")
```

대용량 파일은 pagination 또는 range 방식으로 읽는다.

---

## 6.3 기존 파일 수정

사용자:

> README의 설치 방법을 수정해줘.

흐름:

```text
read_file("README.md")
        ↓
현재 revision 확인
        ↓
write_file(...)
        ↓
revision 확인
        ↓
atomic replace
```

기존 파일을 수정할 때는 가능하면 기존 revision을 확인하여 stale write를 방지한다.

---

## 6.4 파일 생성

사용자:

> docs/architecture.md 만들어줘.

MCP:

```text
write_file(
  path = "docs/architecture.md",
  ...
)
```

workspace 밖의 경로는 거부된다.

---

# 7. MVP Tools

MVP의 MCP surface는 작게 유지한다.

## `get_workspace_info`

현재 서버가 노출하는 workspace 정보를 반환한다.

반환 예:

```text
workspace name
workspace root alias
read/write mode
platform
limits
```

실제 host absolute path는 기본적으로 반환하지 않는다.

---

## `list_directory`

디렉터리 내용을 탐색한다.

입력 개념:

```text
path
depth
limit
```

기본 depth는 `1`.

무제한 recursive traversal은 허용하지 않는다.

출력:

```text
relative path
type: file | directory | symlink
size
```

---

## `read_file`

텍스트 파일을 읽는다.

입력:

```text
path
offset / start_line
limit / max_lines
```

출력:

```text
content
size
truncated
revision
```

`revision`은 SHA-256 등 현재 파일 내용에서 계산한 opaque identifier로 사용한다.

이를 이후 write 시 optimistic concurrency control에 활용한다.

---

## `write_file`

파일을 생성하거나 기존 파일을 교체한다.

기존 파일 수정에는 가능하면 `read_file`이 반환한 revision을 요구한다.

개념적으로:

```text
read
 → revision=A

write(expected_revision=A)
```

현재 revision이 달라졌다면:

```text
CONFLICT
```

로 실패한다.

이를 통해 다음 race를 막는다.

```text
Agent가 파일 읽음
       ↓
사용자가 파일 수정
       ↓
Agent가 오래된 내용으로 덮어씀
```

파일 쓰기는 가능하면:

```text
temporary file
      ↓
fsync / flush where appropriate
      ↓
atomic rename
```

방식으로 수행한다.

---

# 8. Workspace Security Model

## 8.1 Workspace root는 서버에서 결정한다

MCP client가 arbitrary root를 지정할 수 없게 한다.

예:

```text
WORKSPACE_ROOT=/workspace/project
```

또는 config:

```text
workspace:
  root: /workspace/project
```

MCP `roots/list`를 security boundary로 사용하지 않는다.

MCP 2026-07-28에서는 Roots 기능 자체가 deprecated되었으며 신규 구현은 tool parameter, resource URI 또는 서버 설정을 사용하도록 권장된다.

---

## 8.2 모든 tool path는 relative path

허용:

```text
src/index.ts
docs/architecture.md
.
```

거부:

```text
/etc/passwd
C:\Users\...
../../secret
```

---

## 8.3 canonical path validation

단순 문자열 prefix 비교를 사용하지 않는다.

다음 검증을 수행한다.

```text
input relative path
        ↓
syntax validation
        ↓
workspace root + path
        ↓
canonicalize / realpath
        ↓
workspace containment check
```

다음을 방어한다.

* `../` traversal
* absolute path
* symlink escape
* Windows drive-relative path
* Windows reserved device names
* alternate path encoding
* path normalization bypass

존재하지 않는 새 파일 역시 가장 가까운 기존 parent를 canonicalize하여 symlink escape를 확인한다.

---

# 9. Sensitive File Policy

workspace 안에 있다고 모든 파일을 자동 허용하지 않는다.

기본 deny pattern을 둔다.

예:

```text
.env
.env.*
*.pem
*.key

.ssh/**
.aws/**
.gnupg/**

.npmrc
.netrc

credentials*
secrets*
```

단, denylist 자체를 security boundary로 간주하지 않는다.

실제 protection은 다음 계층에서 제공한다.

```text
OS permission
   ↓
workspace root isolation
   ↓
canonical path validation
   ↓
deny patterns
```

---

# 10. Resource Limits

agent 요청 때문에 MCP 서버가 과도한 자원을 사용하지 않도록 제한한다.

MVP에서 최소한 다음 제한을 둔다.

```text
max read bytes
max write bytes
max directory entries
max traversal depth
request timeout
```

Binary file은 MVP에서는 기본적으로 읽지 않는다.

텍스트 파일 위주로 제한한다.

---

# 11. Write Policy

서버 설정으로 최소 두 모드를 지원한다.

```text
read-only
read-write
```

기본값:

```text
read-only
```

write capability가 필요한 환경에서 명시적으로:

```text
read-write
```

를 활성화한다.

ChatGPT 또는 MCP client가 별도의 tool confirmation UI를 제공하더라도 이를 서버의 security boundary로 간주하지 않는다.

---

# 12. Audit

MVP에서도 최소 audit log는 남긴다.

기록:

```text
timestamp
request id
tool
relative path
success/failure
duration
bytes read/written
failure reason
```

기록하지 않는 것:

```text
file content
API key
authorization headers
secret values
```

---

# 13. Error Model

에러는 agent가 복구할 수 있도록 명확히 분류한다.

예:

```text
PATH_OUTSIDE_WORKSPACE
PATH_BLOCKED
FILE_NOT_FOUND
NOT_A_FILE
NOT_A_DIRECTORY
FILE_TOO_LARGE
BINARY_FILE
READ_ONLY
REVISION_CONFLICT
INVALID_PATH
PERMISSION_DENIED
TIMEOUT
INTERNAL_ERROR
```

agent에게 host 내부 절대 경로나 secret 정보가 노출되지 않도록 한다.

> **Amendment (2026-09-23):** `edit_file`(ADR-002)과 함께 `EDIT_NO_MATCH`, `EDIT_AMBIGUOUS`를 추가한다.

---

# 14. OpenAI Secure MCP Tunnel Integration

Private Workspace MCP가 OpenAI와 직접 인증하거나 tunnel protocol을 구현하지 않는다.

역할 분리는 다음과 같다.

```text
OpenAI
  │
  ▼
tunnel-client
  │
  ▼
Private Workspace MCP
```

`tunnel-client`가 담당:

* OpenAI authentication
* tunnel ID
* outbound HTTPS
* polling
* response relay
* tunnel health

Private Workspace MCP가 담당:

* MCP protocol
* tool schemas
* filesystem capability
* path security
* workspace policy
* audit

OpenAI Secure MCP Tunnel은 private MCP를 public endpoint로 만들지 않고 outbound HTTPS 연결로 OpenAI 제품과 연결한다. MCP request/response 자체는 OpenAI 경로를 통과한다.

---

# 15. Success Criteria

MVP 완료 조건은 다음과 같다.

1. ChatGPT에서 Secure MCP Tunnel을 통해 MCP tool catalog가 조회된다.
2. 지정 workspace의 directory listing이 가능하다.
3. 텍스트 파일을 읽을 수 있다.
4. 파일 생성과 수정이 가능하다.
5. read-only 모드에서는 모든 write가 차단된다.
6. `../`, absolute path 및 symlink를 통한 workspace escape가 차단된다.
7. deny pattern 파일을 읽거나 쓸 수 없다.
8. 대용량 read/write가 설정된 limit에서 차단된다.
9. stale revision에 대한 write가 실패한다.
10. MCP 서버는 외부 HTTP port를 열지 않고 stdio로 동작한다.
11. tunnel-client 종료 시 MCP child process도 정상 종료된다.
12. filesystem 관련 주요 security case가 자동 테스트로 검증된다.

---

# 16. Future Features / TODO

MVP 범위와 분리해서 단계적으로 진행한다.

## Phase 2 — Safer Editing

* `edit_file`

  * exact-match replacement
  * line/range replacement
* patch/diff 기반 수정
* before/after diff 생성
* write preview
* write approval
* bulk edit transaction
* formatter integration
* file revision history
* rollback

특히 기존 파일 수정은 전체 `write_file`보다 targeted `edit_file`을 우선하도록 발전시킨다.

> **Amendment (2026-09-23):** exact-match `edit_file`을 구현한다(ADR-002). 나머지 항목은 보류한다.

> **Amendment (2026-09-24):** 한 파일 안의 여러 exact-match 교체를 원자적으로 적용하는 `multi_edit_file`을 구현한다(ADR-002 4절 Amendment, implementation notes M40~M42). 위 "bulk edit transaction" 중 한 파일 범위만 해당하고, 여러 파일에 걸친 transaction과 나머지 항목은 여전히 보류한다.

---

## Phase 3 — Better File Intelligence

* recursive search
* ripgrep 기반 text search
* glob search
* file metadata
* symbol search
* language detection
* ignore file 지원

  * `.gitignore`
  * `.ignore`
* file change watcher
* diagnostics

> **Amendment (2026-09-23):** recursive glob 검색(`find_files`), literal text 검색(`search_text`), `.gitignore`/`.ignore` 지원을 in-process로 구현한다. ripgrep 실행, regex, symbol 검색, language detection, watcher, diagnostics는 보류한다.

> **Amendment (2026-09-24):** `search_text`에 선형 시간 엔진(`re2js`)으로 실행하는 opt-in regex 검색(`regex: true`)을 추가한다(ADR-001 9절 Amendment, implementation notes M44~M46). ripgrep 실행, symbol 검색, language detection, watcher, diagnostics는 계속 보류한다.

---

## Phase 4 — Git

전용 Git capability를 추가한다.

우선 read-only:

* status
* diff
* log
* show
* branch

이후 제한적 write:

* add
* commit
* branch create
* checkout

다음은 별도 고위험 operation으로 분류한다.

* reset
* clean
* force checkout
* push
* force push

Git도 가능하면 arbitrary shell을 통해 실행시키기보다 typed tool로 제공한다.

---

## Phase 5 — Shell / Command Execution

가장 나중에 추가한다.

예:

```text
execute_command
```

하지만 MVP filesystem tool과 다른 security tier로 취급한다.

필수 고려사항:

* dedicated OS user
* sandbox/container/VM
* working-directory confinement
* environment variable filtering
* execution timeout
* output size limit
* process count limit
* network policy
* command audit
* cancellation
* explicit approval
* dangerous command policy

문자열 blocklist를 실제 security boundary로 사용하지 않는다.

---

## Phase 6 — Process Sessions

Shell 실행이 안정화된 이후:

* long-running processes
* process list
* stdout/stderr streaming
* process termination
* interactive session
* dev server
* test watcher
* REPL

등을 추가한다.

---

## Phase 7 — Development Agent Capabilities

coding workflow에 특화된 tool을 추가한다.

예:

* `get_diagnostics`
* test runner
* formatter
* lint
* package scripts
* dependency inspection
* language server integration
* symbol search
* find references
* rename symbol

Serena와 같은 semantic coding MCP의 접근법을 참고하되 필요한 capability만 직접 구현한다.

---

## Phase 8 — Policy Engine

tool마다 capability policy를 선언한다.

예:

```text
workspace A
  read: yes
  write: yes
  shell: no

workspace B
  read: yes
  write: no

workspace C
  read: yes
  write: yes
  shell: sandboxed
  git_push: no
```

추후:

* per-tool policy
* per-path policy
* per-client policy
* temporary capability grant
* approval policy
* rate limiting

을 지원한다.

> **Amendment (2026-09-24):** 첫 단계로 workspace별 write 허용만 구현한다. `WORKSPACE_ROOTS`와 함께 `WORKSPACE_READ_WRITE`에 나열한 workspace만 쓸 수 있고 나머지는 read-only다(ADR-008 2.1절 Amendment, implementation notes M37~M39). per-tool·per-path·per-client policy와 나머지 항목은 보류한다.

---

## Phase 9 — Isolation

운영 수준으로 발전할 경우:

```text
tunnel-client
       ↓
MCP Server
       ↓
sandbox boundary
       ↓
workspace
```

형태를 기본으로 한다.

후보:

* dedicated Linux user
* Docker/Podman
* bubblewrap
* macOS sandbox
* lightweight VM

목표는 MCP application-level validation에 문제가 생겨도 host 전체가 노출되지 않도록 하는 것이다.

---

## Phase 10 — Operations

* `/healthz`
* `/readyz`
* metrics
* OpenTelemetry
* structured audit log
* MCP request tracing
* tool latency metrics
* error metrics
* policy violation metrics
* log redaction
* configuration validation
* `doctor` command
* dry-run mode

> **Amendment (2026-09-24):** configuration validation의 첫 단계로 서버 entry에 `--check`(startup과 같은 검증 후 해석된 설정을 stderr에 요약하고 종료)와 `--version`을 추가한다. 모르는 인자는 exit 2로 거부한다(implementation notes M47~M48). health endpoint, metrics, `doctor` command, dry-run mode와 나머지 항목은 보류한다.

---

## Phase 11 — Multi-workspace

한 MCP server에서 여러 workspace를 다루는 기능.

단순 absolute path 입력 대신 서버가 관리하는 opaque ID를 사용한다.

```text
workspace_id: project-a
path: src/index.ts
```

각 workspace는 서로 다른 capability policy를 가질 수 있다.

> **Amendment (2026-09-24):** 첫 단계는 ADR-008로 정한다. `WORKSPACE_ROOTS`로 이름과 root를 설정하고 tool은 `workspace` 인자를 받는다. capability policy(mode, limits, deny)는 우선 모든 workspace가 공유한다.

> **Amendment (2026-09-24, 2):** access mode는 이제 workspace별로 정할 수 있다. `WORKSPACE_ROOTS`와 함께 `WORKSPACE_READ_WRITE`에 쓰기를 허용할 workspace 이름을 나열하고, 나머지는 read-only다(ADR-008 Amendment, implementation notes M37~M39). limits, deny 목록, audit 설정은 계속 모든 workspace가 공유한다.

---

# 17. 장기적인 제품 방향

궁극적으로 이 프로젝트의 목표는 “모든 것을 실행할 수 있는 remote shell”이 아니다.

목표는:

> **AI agent가 private 환경에서 필요한 작업을 수행할 수 있도록 작고 명시적이며 감사 가능한 capability를 제공하는 MCP server**

이다.

새로운 capability는 가능한 한:

```text
typed tool
>
generic shell
```

순서로 추가한다.

Shell은 typed capability로 표현하기 어려운 작업을 위한 escape hatch로 취급한다.
