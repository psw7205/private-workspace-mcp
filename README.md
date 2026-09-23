# Private Workspace MCP

private 머신의 workspace 하나를 ChatGPT 같은 원격 MCP client에 작고 감사 가능한 filesystem tool로 노출하는 stdio MCP 서버다. OpenAI Secure MCP Tunnel의 `tunnel-client`가 child process로 실행하므로 public HTTP listener가 없다.

```text
ChatGPT / Responses API
        │ MCP
        ▼
OpenAI Secure MCP Tunnel ◀── outbound HTTPS ── tunnel-client
                                                   │ stdio
                                                   ▼
                                         private-workspace-mcp ──▶ WORKSPACE_ROOT
```

이 서버는 coding agent가 아니라 capability provider다. shell, Git, process 실행은 제공하지 않는다(PRD 4, ADR-001 §15).

- 요구사항과 설계: [`docs/prd.md`](docs/prd.md), [`docs/adr.md`](docs/adr.md)
- 문서에 없던 결정, 잔여 위험, 검증 결과, TODO: [`docs/implementation-notes.md`](docs/implementation-notes.md)
- agent 작업 규칙: [`AGENTS.md`](AGENTS.md)

## Quick start

```sh
mise install          # Node 26, pnpm (mise.toml)
pnpm install
pnpm build
WORKSPACE_ROOT="$PWD" node dist/index.js   # stdio로 대기. 기본 read-only
```

MCP Inspector로 직접 호출해 볼 수 있다. 서버 환경 변수는 `-e`로 넘긴다.

```sh
npx @modelcontextprotocol/inspector -e WORKSPACE_ROOT="$PWD" -- node dist/index.js
```

## Tools

| tool | 설명 |
|------|------|
| `get_workspace_info` | workspace 이름, mode, platform, limits. host 절대 경로는 반환하지 않음 |
| `list_directory` | `path`(기본 `.`), `depth`(기본 1), `limit`. 이름순, depth-first. symlink는 따라가지 않고 민감 파일과 특수 파일은 생략 |
| `read_file` | UTF-8 텍스트 파일. `start_line`/`max_lines`로 line pagination. 파일 전체 기준 `revision`(`sha256:…`) 반환 |
| `write_file` | 파일 생성 또는 전체 교체. 기존 파일은 `expected_revision` 필수, 새 파일은 생략. 없는 parent directory는 생성 |

모든 path는 workspace root 기준 상대 경로이고 `/`로 구분한다. 실패는 `isError: true` tool result로 오며 본문은 `{"error":{"code":"…","message":"…"}}` 형태다.

| code | 의미 |
|------|------|
| `PATH_OUTSIDE_WORKSPACE` | 절대 경로, `..`, symlink 등으로 workspace 밖을 가리킴 |
| `PATH_BLOCKED` | 민감 파일 deny pattern에 걸림 |
| `INVALID_PATH` | 경로 문법 오류, symlink 대상에 쓰기, 깨진 symlink 아래에 쓰기 |
| `FILE_NOT_FOUND` / `NOT_A_FILE` / `NOT_A_DIRECTORY` | 대상 상태 불일치 |
| `FILE_TOO_LARGE` / `BINARY_FILE` | read/write limit 초과, binary 파일 |
| `READ_ONLY` | read-only mode에서 write 시도 |
| `REVISION_CONFLICT` | 읽은 뒤 파일이 바뀜, 이미 존재하는 파일을 revision 없이 생성 시도 |
| `PERMISSION_DENIED` / `TIMEOUT` / `INTERNAL_ERROR` | OS 권한, 시간 초과, 기타 (상세는 audit log에만) |

## 보안 모델

- **workspace 고정**: root는 서버 설정(`WORKSPACE_ROOT`)으로만 정하고 startup 시 realpath로 고정한다. MCP Roots는 쓰지 않는다.
- **단일 `PathGuard`**: 입력 문법 검사(`..`, 절대/drive/UNC 경로, Windows alias 거부) 후 realpath로 canonical 경로를 구해 containment를 판정한다. 문자열 prefix 비교는 쓰지 않는다.
- **민감 파일 deny**: `.env`, `.env.*`, `*.pem`, `*.key`, `.ssh`, `.aws`, `.gnupg`, `.npmrc`, `.netrc`, `credentials*`, `secrets*`, `.git`. 입력 경로와 canonical 경로 양쪽에 case-insensitive로 적용한다. 운영자는 추가만 할 수 있다.
- **안전한 write**: 기본 read-only. 기존 파일은 revision이 일치할 때만 temp file + fsync + atomic rename으로 교체하고, 새 파일은 `link()`로 생성해 덮어쓰지 않는다.
- **audit**: tool call마다 JSON Lines 1건(요청 id, tool, path, 성공 여부, 소요 시간, bytes, error code). 파일 내용과 secret은 기록하지 않는다.

path 검증은 defense-in-depth다. 최종 보안 경계는 전용 OS 사용자나 container 같은 OS 권한이다(ADR-001 §11). 잔여 위험은 implementation notes 3절에 있다.

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

값이 잘못되면 stderr에 이유를 출력하고 exit code 1로 종료한다(fail closed). stdout은 MCP protocol 전용이다. startup 메시지는 stderr로, audit log는 `WORKSPACE_AUDIT_LOG`가 있으면 그 파일로, 없으면 stderr로 나간다.

## OpenAI Secure MCP Tunnel 연결

`tunnel-client`는 Homebrew(`brew install openai/tools/tunnel-client`)로 설치한다. child는 `tunnel-client`의 환경 변수를 상속하고, child의 stderr는 `tunnel-client` 로그로 전달된다(`tunnel-client` 0.0.14에서 확인). 서버 설정은 command에 명시하고, runtime key는 child에 넘기지 않는다.

```sh
pnpm build

export CONTROL_PLANE_TUNNEL_ID="tunnel_..."   # Platform > Tunnels
export CONTROL_PLANE_API_KEY="sk-..."          # Runtime API key (admin key 아님)

tunnel-client init --sample sample_mcp_stdio_local --profile workspace-mcp \
  --tunnel-id "$CONTROL_PLANE_TUNNEL_ID" \
  --mcp-command "env -u CONTROL_PLANE_API_KEY -u OPENAI_API_KEY WORKSPACE_ROOT=/workspace/project WORKSPACE_MODE=read-write node $(pwd)/dist/index.js"
tunnel-client doctor --profile workspace-mcp --explain
tunnel-client run --profile workspace-mcp
```

`run`이 healthy인 동안 ChatGPT Settings > Connectors에서 connector를 만들거나 확인한다. Responses API에서는 `tools: [{"type": "mcp", "server_label": "private_workspace", "tunnel_id": "tunnel_..."}]`로 같은 tunnel을 쓸 수 있다(`server_url`은 쓰지 않음).

주의:

- tunnel ID 하나에는 `tunnel-client` instance 하나만 실행한다. stdio child가 instance마다 따로 뜨기 때문이다.
- MCP SDK `serveStdio`는 stdio connection을 **첫 요청의 protocol era**로 pin한다. OpenAI hosted 경로는 `2026-07-28`(modern)로 요청하는 것을 관측했다. 같은 tunnel-client에 2025-era(legacy) client를 먼저 붙이면 이후 OpenAI 요청이 실패하므로, 그럴 때는 `tunnel-client`를 재시작한다(implementation notes 4절).

## 개발과 검증

```sh
pnpm typecheck     # TypeScript 7
pnpm test          # unit + stdio integration (서버 process를 직접 spawn)
pnpm build         # dist/index.js
pnpm e2e:tunnel    # tunnel-client dev proxy 경유 e2e (tunnel-client 필요, OpenAI credential 불필요)
```

`pnpm e2e:tunnel`은 `tunnel-client dev proxy --mcp-command`로 local control plane을 띄워 `tunnel-client → stdio` 경로 전체를 검증한다. legacy와 `2026-07-28` 양쪽 era, revision conflict, escape와 deny 거부, tunnel-client 종료 시 child 정리를 확인한다.

CI(`.github/workflows/ci.yml`)는 ubuntu, macOS, windows에서 typecheck, test, build를 실행한다.

## 구조

```text
src/
  index.ts                 stdio entry: config 로드, serveStdio, 종료 처리
  server/server.ts         McpServer factory와 tool 등록
  tools/                   tool 정의(schema, annotation)와 공통 runTool(timeout, error 변환, audit)
  filesystem/              PathGuard, reader, lister, writer, revision
  policy/deny-list.ts      민감 파일 deny pattern
  config/config.ts         env 파싱과 검증
  audit/audit-log.ts       stderr/file audit sink
  errors/errors.ts         error code와 fs error 변환
test/                      vitest (security case 중심, fixture는 임시 디렉터리)
scripts/e2e-tunnel-client.ts
```
