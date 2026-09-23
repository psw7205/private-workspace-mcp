# ADR-001 — OpenAI Secure MCP Tunnel + Custom MCP Server Architecture

* Status: Accepted
* Date: 2026-09-22
* Scope: MVP architecture

## 1. Context

Private 머신의 파일을 ChatGPT에서 탐색하고 읽고 수정할 수 있는 capability가 필요하다.

이를 위해서는 크게 두 문제가 있다.

1. OpenAI-hosted product에서 private network까지 연결하는 방법
2. private 머신에서 실제 파일 작업을 수행하는 agent capability

OpenAI는 첫 번째 문제를 해결하기 위해 Secure MCP Tunnel과 공식 `tunnel-client`를 제공한다.

`tunnel-client`는 private network에서 OpenAI로 outbound HTTPS 연결을 생성하고 OpenAI가 전달한 MCP 요청을 내부 MCP 서버에 전달한다.

두 번째 문제는 custom MCP server를 직접 구현하여 해결한다.

---

# 2. Decision

다음 아키텍처를 채택한다.

```text
┌───────────────────────────────┐
│            OpenAI             │
│                               │
│ ChatGPT                       │
│      │                        │
│      ▼                        │
│ Secure MCP Tunnel Service     │
└──────────────┬────────────────┘
               │
               │ outbound HTTPS
               │
┌──────────────▼────────────────┐
│        Private Machine        │
│                               │
│ tunnel-client                 │
│      │                        │
│      │ stdio                  │
│      ▼                        │
│ Private Workspace MCP         │
│      │                        │
│      ▼                        │
│ Configured Workspace          │
└───────────────────────────────┘
```

OpenAI tunnel protocol은 직접 구현하지 않는다.

공식 `openai/tunnel-client`를 그대로 사용한다.

---

# 3. MCP Transport

MVP에서는 **stdio transport**를 사용한다.

```text
tunnel-client
     │
     │ stdin/stdout
     ▼
MCP process
```

OpenAI Secure MCP Tunnel은 stdio MCP command를 공식적으로 지원한다.

### 이유

HTTP MCP server를 별도로 띄우면 추가로 고려해야 한다.

* port binding
* HTTP lifecycle
* MCP authentication
* local network exposure
* TLS 여부
* server lifecycle
* port conflicts

stdio는 이러한 surface가 없다.

MVP에서는:

```text
one tunnel-client
       ↓
one MCP child process
```

모델이 가장 단순하다.

---

# 4. MCP Version

MCP specification:

```text
2026-07-28
```

을 기준으로 한다.

해당 specification은 stateless protocol core를 도입했고 2026년 7월 28일 정식 발표되었다.

---

# 5. MCP SDK

TypeScript 공식 SDK v2를 사용한다.

```text
@modelcontextprotocol/server
```

현재 TypeScript SDK v2는 stable release line이며 MCP `2026-07-28` specification을 구현한다.

### 선택 이유

* 공식 Tier 1 MCP SDK
* TypeScript
* stdio 지원
* 최신 MCP spec 지원
* runtime 및 schema 작성이 단순
* 프로젝트 규모가 작아 언어 통일 이점이 큼

---

# 6. Runtime / Toolchain

MVP 기본 선택:

```text
Node.js LTS
TypeScript
pnpm
MCP TypeScript SDK v2
Zod v4
```

> **Amendment (2026-09-23):** runtime을 Node.js 26(현재 stable 26.10.0), compiler를 TypeScript 7로 올린다. Node 26은 2026-10에 LTS로 전환될 예정이고, 그 전까지는 Current release line이다. 버전은 `mise.toml`에서 pin한다.

특정 HTTP framework는 도입하지 않는다.

stdio process이므로:

```text
Express
Fastify
Hono
NestJS
```

등은 현재 필요하지 않다.

---

# 7. Project Structure

MVP는 단일 package로 시작한다.

개념적 구조:

```text
src/
  server/
    server.ts

  tools/
    workspace-info.ts
    list-directory.ts
    read-file.ts
    write-file.ts

  filesystem/
    path-guard.ts
    file-reader.ts
    file-writer.ts
    revision.ts

  policy/
    deny-list.ts
    workspace-policy.ts

  config/
    config.ts

  audit/
    audit-log.ts

  errors/
    errors.ts
```

초기 단계에서 monorepo나 plugin architecture를 도입하지 않는다.

---

# 8. Workspace Selection

workspace는 서버 startup config에서 결정한다.

예:

```text
WORKSPACE_ROOT=/workspace/project
```

MCP client가 workspace root를 마음대로 변경할 수 없게 한다.

MCP Roots 기능에 의존하지 않는다.

MCP `2026-07-28`에서는 Roots가 deprecated되었으며 신규 구현에서는 tool arguments, resource URI 또는 서버 configuration 사용이 권장된다.

---

# 9. Filesystem API Design

MVP tool surface:

```text
get_workspace_info
list_directory
read_file
write_file
```

처음부터 많은 filesystem operation을 제공하지 않는다.

특히 다음은 후속 ADR까지 보류한다.

```text
delete
move
rename
chmod
symlink
shell
git
process
```

파괴적 operation을 줄여 initial attack surface를 최소화한다.

> **Amendment (2026-09-23):** Phase 2와 3의 첫 tool로 `edit_file`(ADR-002), `find_files`, `search_text`를 추가한다. `find_files`와 `search_text`는 read-only이고 기존 filesystem 규칙(PathGuard, deny 양쪽 검사, symlink 미추적, 특수 파일·binary·non-UTF-8 제외)을 따른다. 검색은 in-process literal 검색만 한다. `rg` 같은 외부 process 실행은 15절에 따라 제외하고, client가 준 regex는 timeout으로 끊을 수 없는 동기 실행이라 제외한다. `.gitignore`와 `.ignore`를 순회에 적용한다. 세부 결정은 `docs/implementation-notes.md` M19~M24에 둔다. delete, move, rename 등 위 목록은 여전히 보류다.

---

# 10. Path Security

filesystem access는 반드시 단일 `PathGuard`를 통과한다.

```text
tool
 ↓
PathGuard
 ↓
filesystem implementation
```

각 tool이 독립적으로 path validation을 구현하지 않는다.

`PathGuard`가 담당:

* relative path enforcement
* normalization
* canonicalization
* workspace containment
* symlink resolution
* deny rule
* platform-specific invalid path handling

다음 형태는 사용하지 않는다.

```text
candidate.startsWith(workspaceRoot)
```

대신 canonical path와 relative containment를 기준으로 판정한다.

---

# 11. OS Permission Is the Security Boundary

MCP application의 path validator만으로 host 보안을 보장하지 않는다.

보안 계층:

```text
OS / container boundary
        ↓
workspace mount / permission
        ↓
PathGuard
        ↓
deny rules
        ↓
tool policy
```

MCP 서버가 compromise되더라도 agent 전용 OS account가 접근할 수 없는 파일은 접근할 수 없어야 한다.

따라서 장기 운영에서는 dedicated user 또는 isolated container/VM을 권장한다.

---

# 12. Write Consistency

기존 파일 수정에는 optimistic concurrency control을 적용한다.

`read_file`은 content와 함께 revision을 반환한다.

예:

```text
revision = sha256(content)
```

`write_file`은 기존 파일 overwrite 시 해당 revision을 함께 받는다.

```text
read
 revision=A

write
 expected_revision=A
```

현재 revision이 B이면:

```text
REVISION_CONFLICT
```

를 반환하고 overwrite하지 않는다.

### 이유

MCP request와 실제 사용자 편집 사이에는 시간차가 존재할 수 있다.

이를 통해 stale agent write가 사용자의 최근 작업을 덮어쓰는 것을 방지한다.

---

# 13. Atomic File Write

파일 쓰기는 가능한 범위에서 atomic replacement를 사용한다.

```text
new content
   ↓
temporary file
   ↓
rename
   ↓
target file
```

중간 실패로 target이 partial content 상태가 되는 것을 최소화한다.

---

# 14. Read-only by Default

server 기본 mode:

```text
read-only
```

write를 사용하려면 운영자가 명시적으로:

```text
read-write
```

를 설정해야 한다.

MCP client 또는 ChatGPT의 approval UI는 defense-in-depth로 간주하며 서버 권한 판단의 근거로 삼지 않는다.

---

# 15. No Shell in MVP

`execute_command`, `bash`, `terminal` capability는 MVP에서 제공하지 않는다.

### 이유

파일 API:

```text
read(path)
write(path)
```

는 capability 범위를 비교적 명확하게 제한할 수 있다.

반면:

```text
execute("...")
```

가 제공되는 순간 다음이 가능해진다.

```text
filesystem access
network access
process execution
credential access
package installation
Git operation
system modification
```

따라서 shell은 사실상 별도의 security architecture를 요구한다.

이를 별도 ADR로 설계한 후 추가한다.

---

# 16. No Public MCP Endpoint

MVP는 MCP HTTP server를 제공하지 않는다.

외부 접근:

```text
OpenAI Secure MCP Tunnel
```

만 사용한다.

따라서 MCP server 자체에 public DNS/TLS/reverse proxy를 구축하지 않는다.

---

# 17. Authentication Boundary

책임을 다음처럼 나눈다.

## OpenAI ↔ tunnel-client

OpenAI runtime API key와 Tunnel 권한을 사용한다.

`tunnel-client`가 담당한다.

## tunnel-client ↔ MCP

stdio child process이므로 별도 network authentication을 구현하지 않는다.

## MCP ↔ filesystem

OS permission + workspace policy로 통제한다.

> **Amendment (2026-09-23):** MCP 계층에 OAuth를 도입하지 않는다. ChatGPT connector는 "인증 없음"으로 만들고, 호출 가능 범위는 해당 tunnel에 Tunnels Use 권한을 가진 OpenAI 사용자로 정해진다. 이유: 배포 형태가 운영자 = 데이터 소유자인 self-host이고, public endpoint가 없어 요청은 OpenAI tunnel 경로로만 들어오며, MCP authorization spec은 HTTP transport 대상이다. OAuth를 붙이려면 HTTP transport 전환(3절, 16절 결정 번복)과 authorization server가 필요하다. 한계: 서버는 호출자를 구분하지 못하므로 사용자별 권한과 audit 주체 기록이 없다. 재검토 조건: 한 tunnel을 여러 사용자가 공유하면서 사용자별 권한이나 audit 주체가 필요해질 때, 또는 HTTP transport나 tunnel 밖 endpoint를 도입할 때. 그 전까지는 read-only 기본값, 좁은 `WORKSPACE_ROOT`, 권한이 다른 용도의 tunnel 분리로 대응한다.

---

# 18. Data Boundary

Secure MCP Tunnel은 private server를 public internet에 공개하지 않지만 end-to-end opaque tunnel은 아니다.

다음 데이터는 OpenAI 경로를 통과한다.

* MCP tool name
* tool arguments
* file contents returned by tools
* tool results
* MCP streaming events

따라서 이 시스템은:

```text
private network exposure 방지
```

를 해결하지만:

```text
OpenAI가 파일 내용을 절대 볼 수 없어야 함
```

이라는 요구사항을 해결하지 않는다. OpenAI 공식 tunnel architecture 역시 MCP request/response가 OpenAI product runtime과 tunnel-service를 통과한다고 명시한다.

---

# 19. Alternatives Considered

## Third-party filesystem/shell MCP

예:

* Desktop Commander
* MCP filesystem reference server
* Serena

### Reject for MVP

이 프로젝트의 목적은 필요한 capability를 직접 통제하는 것이다.

특히 shell capability를 불필요하게 처음부터 제공하지 않는다.

---

## Public HTTP MCP

```text
Internet
 ↓
https://mcp.example.com
```

### Reject

* public attack surface 증가
* 인증 추가 필요
* TLS 필요
* firewall/inbound configuration 필요
* Secure MCP Tunnel 사용 목적과 맞지 않음

---

## Cloudflare Tunnel

기술적으로 가능하지만 OpenAI product 전용 private MCP 연결에는 OpenAI Secure MCP Tunnel이 더 직접적인 통합을 제공한다.

현재 범위에서는 사용하지 않는다.

---

## Custom tunnel implementation

### Reject

routing/queue/auth/reconnect/streaming 등을 다시 구현할 이유가 없다.

공식 `tunnel-client`를 사용한다.

---

## HTTP transport between tunnel-client and MCP

추후 필요하면 지원할 수 있으나 MVP에서는 stdio보다 복잡하다.

현재 보류한다.

---

## Go MCP server

Go도 적합한 선택이지만 MVP의 핵심은 filesystem policy와 MCP tool design이다.

TypeScript 공식 SDK가 안정적으로 제공되고 구현 규모도 작으므로 TypeScript를 선택한다.

향후 장기 daemon 성능이나 단일 binary 배포가 중요한 요구사항이 생기면 재검토한다.

---

# 20. Consequences

## Positive

* MCP 서버를 public internet에 노출하지 않는다.
* custom security policy를 직접 통제할 수 있다.
* capability surface가 매우 작다.
* OpenAI tunnel 구현을 유지보수하지 않아도 된다.
* stdio라 MCP server 자체의 network stack이 필요 없다.
* 기능을 단계적으로 추가하기 쉽다.
* third-party generic shell MCP에 의존하지 않는다.

## Negative

* filesystem security 코드를 직접 책임져야 한다.
* Windows/macOS/Linux path semantics를 고려해야 한다.
* 기능이 기존 범용 MCP보다 초기에는 적다.
* Secure MCP Tunnel에 의존하므로 OpenAI 외 MCP client 사용에는 별도 transport가 필요할 수 있다.
* MCP로 반환한 file content는 OpenAI를 통과한다.

---

# 21. Deferred Decisions

다음 항목은 별도 ADR에서 결정한다.

* ADR-002: edit/patch model
* ADR-003: local approval system
* ADR-004: Git capability
* ADR-005: sandboxed shell execution
* ADR-006: process/session management
* ADR-007: container/VM isolation
* ADR-008: multi-workspace policy
* ADR-009: HTTP MCP transport
* ADR-010: semantic code intelligence / LSP integration

> **Amendment (2026-09-23):** ADR-002는 `docs/adr-002-edit-model.md`로 Accepted.

---

# 22. Final Architecture Principle

초기 설계 원칙은 다음 한 문장으로 고정한다.

> **최소 capability를 typed MCP tool로 명시적으로 제공하고, 실제 보안 경계는 MCP prompt가 아니라 filesystem과 OS 권한에서 만든다.**

새 기능을 추가할 때도:

```text
specialized typed tool
        ↓
limited generic capability
        ↓
arbitrary shell
```

순서로 검토한다.

Shell은 기본 도구가 아니라 최후의 범용 escape hatch로 취급한다.
