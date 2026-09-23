# Private Workspace MCP

OpenAI Secure MCP Tunnel 뒤에서 `tunnel-client`의 child process로 실행되는 stdio MCP 서버. 설정한 workspace 하나를 작고 감사 가능한 filesystem tool로 노출한다.

- 요구사항과 설계: [`docs/prd.md`](docs/prd.md), [`docs/adr.md`](docs/adr.md)
- 문서에 없던 결정, 잔여 위험, TODO: [`docs/implementation-notes.md`](docs/implementation-notes.md)

## Tools

| tool | 설명 |
|------|------|
| `get_workspace_info` | workspace 이름, mode, platform, limits. host 절대 경로는 반환하지 않음 |
| `list_directory` | `path`, `depth`(기본 1), `limit`. symlink는 따라가지 않고, 민감 파일은 생략 |
| `read_file` | UTF-8 텍스트 파일. `start_line`/`max_lines` pagination. 파일 전체의 `revision`(`sha256:…`) 반환 |
| `write_file` | 생성 또는 전체 교체. 기존 파일은 `expected_revision` 필수, 새 파일은 생략. temp file + fsync + atomic rename |

실패는 `isError: true` tool result로 반환되며 본문은 `{"error":{"code","message"}}` 형태다. code 목록은 PRD 13과 같다.

## 개발

toolchain은 `mise.toml`(Node 24 LTS, pnpm)로 관리한다.

```sh
mise install
pnpm install
pnpm typecheck
pnpm test          # unit + stdio integration (서버 process를 직접 spawn)
pnpm build         # dist/index.js
pnpm e2e:tunnel    # tunnel-client dev proxy 경유 e2e (tunnel-client 필요, OpenAI credential 불필요)
```

## 설정 (env)

| env | 기본값 | 설명 |
|-----|--------|------|
| `WORKSPACE_ROOT` | (필수) | 절대 경로. startup 시 realpath로 고정 |
| `WORKSPACE_MODE` | `read-only` | `read-only` \| `read-write` |
| `WORKSPACE_NAME` | root basename | `get_workspace_info`의 `name` |
| `WORKSPACE_MAX_READ_BYTES` | `1048576` | 이보다 큰 파일은 `FILE_TOO_LARGE` |
| `WORKSPACE_MAX_WRITE_BYTES` | `1048576` | write content 최대 크기 (UTF-8 bytes) |
| `WORKSPACE_MAX_DIRECTORY_ENTRIES` | `1000` | `list_directory` 응답 최대 entry 수 |
| `WORKSPACE_MAX_DEPTH` | `3` | `list_directory` 최대 depth |
| `WORKSPACE_REQUEST_TIMEOUT_MS` | `10000` | tool call timeout |
| `WORKSPACE_AUDIT_LOG` | (없음 → stderr) | audit JSONL 파일 절대 경로. workspace 밖이어야 하며 symlink는 거부. 권한 `0600` |
| `WORKSPACE_AUDIT_LOG_MAX_BYTES` | `10485760` | 이 크기를 넘기 전에 `<path>.1`로 rotate (backup 1개) |
| `WORKSPACE_EXTRA_DENY_PATTERNS` | (없음) | 쉼표로 구분한 path segment glob(`*`만 지원). 기본 deny 목록에 추가만 가능 |

값이 잘못되면 stderr에 이유를 출력하고 exit code 1로 종료한다. stdout은 MCP protocol 전용이다. startup 메시지는 stderr로, audit log(JSON Lines)는 `WORKSPACE_AUDIT_LOG`가 있으면 그 파일로, 없으면 stderr로 나간다.

## OpenAI Secure MCP Tunnel 연결

`tunnel-client`는 Homebrew(`brew install openai/tools/tunnel-client`)로 설치한다. child는 `tunnel-client`의 환경 변수를 상속하고, child의 stderr(audit log 포함)는 `tunnel-client` 로그로 전달된다(`tunnel-client` 0.0.14에서 확인). 서버 설정은 command에 명시하는 편이 profile만 보고도 알 수 있어 명확하다.

```sh
pnpm build

export CONTROL_PLANE_TUNNEL_ID="tunnel_..."   # Platform > Tunnels
export CONTROL_PLANE_API_KEY="sk-..."          # Runtime API key (admin key 아님)

tunnel-client init --sample sample_mcp_stdio_local --profile workspace-mcp \
  --tunnel-id "$CONTROL_PLANE_TUNNEL_ID" \
  --mcp-command "env WORKSPACE_ROOT=/workspace/project WORKSPACE_MODE=read-write node $(pwd)/dist/index.js"
tunnel-client doctor --profile workspace-mcp --explain
tunnel-client run --profile workspace-mcp
```

`run`이 healthy인 동안 ChatGPT Settings > Connectors에서 connector를 만들거나 확인한다.

주의:

- tunnel ID 하나에는 `tunnel-client` instance 하나만 실행한다. stdio child가 instance마다 따로 뜨기 때문이다(tunnel-client stdio deployment limit).
- MCP SDK `serveStdio`는 stdio connection을 **첫 요청의 protocol era**로 pin한다. `tunnel-client`는 stdio `main` channel을 `stateless`로 선언하지 않으므로 ChatGPT 트래픽은 legacy `initialize` era 하나로 예상된다. 근거와 제약은 implementation notes 4절을 참고한다.
- workspace path를 검증하는 것은 defense-in-depth일 뿐이다. 실제 보안 경계는 전용 OS 사용자나 container 같은 OS 권한이다(ADR-001 §11).
