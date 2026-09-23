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
| `write_file` | 파일 생성 또는 전체 교체. 기존 파일은 `expected_revision` 필수, 새 파일은 생략. read limit을 넘는 기존 파일은 교체 불가. 없는 parent directory는 생성 |
| `find_files` | `path`(기본 `.`) 아래를 depth 제한 없이 glob으로 검색. 패턴은 `path` 기준 상대 경로에 적용(`**/*.ts`). `*`, `?`, `**`, `{a,b}`만 특수 문자(패턴 256자까지)이고 대소문자를 구분. `.`으로 시작하는 이름은 패턴에 명시해야 맞음. `.gitignore`/`.ignore` 대상은 `include_ignored: true`가 아니면 제외. 결과는 파일 경로와 크기 |
| `search_text` | `path` 아래 UTF-8 텍스트 파일에서 literal 문자열 검색(regex 아님). 줄마다 첫 match의 경로·줄·열·줄 내용 반환. `glob`, `case_sensitive`(기본 false), `include_ignored`, `limit`. binary·non-UTF-8·read limit 초과 파일은 건너뜀 |
| `edit_file` | 기존 파일의 exact-match 문자열 교체(ADR-002). `old_string`은 한 번만 나와야 하고 여러 번이면 `replace_all`. `expected_revision` 필수, 새 `revision` 반환 |

모든 path는 workspace root 기준 상대 경로이고 `/`로 구분한다. 실패는 `isError: true` tool result로 오며 본문은 `{"error":{"code":"…","message":"…"}}` 형태다.

| code | 의미 |
|------|------|
| `PATH_OUTSIDE_WORKSPACE` | 절대 경로, `..`, symlink 등으로 workspace 밖을 가리킴 |
| `PATH_BLOCKED` | 민감 파일 deny pattern에 걸림 |
| `INVALID_PATH` | 경로 문법 오류, symlink 대상에 쓰기, 깨진 symlink 아래에 쓰기 |
| `FILE_NOT_FOUND` / `NOT_A_FILE` / `NOT_A_DIRECTORY` | 대상 상태 불일치 |
| `FILE_TOO_LARGE` / `BINARY_FILE` | read/write limit 초과, binary 또는 UTF-8이 아닌 파일, lone surrogate가 든 write content |
| `READ_ONLY` | read-only mode에서 write 시도 |
| `REVISION_CONFLICT` | 읽은 뒤 파일이 바뀜, 이미 존재하는 파일을 revision 없이 생성 시도 |
| `EDIT_NO_MATCH` / `EDIT_AMBIGUOUS` | `edit_file`의 `old_string`이 없음, 여러 번 나오는데 `replace_all`이 아님 |
| `PERMISSION_DENIED` / `TIMEOUT` / `INTERNAL_ERROR` | OS 권한, 시간 초과, 기타 (상세는 audit log에만) |

## 보안 모델

- **workspace 고정**: root는 서버 설정(`WORKSPACE_ROOT`)으로만 정하고 startup 시 realpath로 고정한다. MCP Roots는 쓰지 않는다. root가 사실상 sandbox 경계이므로 filesystem root, home directory, home의 상위 directory는 startup에서 거부한다. agent 전용 directory를 root로 쓴다.
- **단일 `PathGuard`**: 입력 문법 검사(`..`, 절대/drive/UNC 경로, Windows alias 거부) 후 realpath로 canonical 경로를 구해 containment를 판정한다. 문자열 prefix 비교는 쓰지 않는다.
- **민감 파일 deny**: `.env`, `.env.*`, `*.pem`, `*.key`, `.ssh`, `.aws`, `.gnupg`, `.npmrc`, `.netrc`, `credentials*`, `secret*`, `.git`, `.git-credentials`, `service-account*.json`, `id_rsa*`, `id_ed25519*`, `*.tfstate`, `*.tfstate.*`, `.kube`, `kubeconfig*`, `.docker`, `.pypirc`, `*.p12`, `*.pfx`. 입력 경로와 canonical 경로 양쪽에 case-insensitive로 적용한다. 운영자는 추가만 할 수 있다.
- **안전한 write**: 기본 read-only. 기존 파일은 revision이 일치할 때만 temp file + fsync + atomic rename으로 교체하고, 새 파일은 `link()`로 생성해 덮어쓰지 않는다.
- **audit**: tool call마다 JSON Lines 1건(요청 id, tool, path, 성공 여부, 소요 시간, bytes, error code). 파일 내용과 secret은 기록하지 않는다.

path 검증은 defense-in-depth다. 최종 보안 경계는 전용 OS 사용자나 container 같은 OS 권한이다(ADR-001 §11). 잔여 위험은 implementation notes 3절에 있다.

read-write 모드에서는 model이 읽은 파일 내용에 심어진 지시(prompt injection)가 `write_file`·`edit_file` 호출로 이어질 수 있다. revision 검사는 lost update를 막을 뿐 이 경로를 막지 않는다(model도 `read_file`로 revision을 얻는다). 서버는 두 tool에 `readOnlyHint: false`, `destructiveHint: true`를 선언한다. client 쪽 approval은 서버 권한 판단의 근거가 아닌 보조 방어로 쓴다(ADR-001 §14).

- Responses API: `require_approval: {"never": {"tool_names": ["get_workspace_info", "list_directory", "read_file", "find_files", "search_text"]}}`로 읽기 tool만 자동 실행하고 나머지는 승인을 받는다. 쓰기가 필요 없으면 `allowed_tools`로 읽기 tool만 노출하거나 서버를 read-only로 띄운다.
- ChatGPT: write tool 호출 확인을 끄지 않는다.

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
| `WORKSPACE_REQUEST_TIMEOUT_MS` | `10000` | tool call timeout. 최대 `2147483647`(Node timer 한도) |
| `WORKSPACE_MAX_SEARCH_FILES` | `10000` | `find_files`/`search_text` 한 번이 살펴보는 파일 수 상한 |
| `WORKSPACE_AUDIT_LOG` | (없음 → stderr) | audit JSONL 파일 절대 경로. workspace 밖이어야 하며 symlink는 거부. 새로 만들 때 권한 `0600`(이미 있는 파일의 권한은 바꾸지 않음) |
| `WORKSPACE_AUDIT_LOG_MAX_BYTES` | `10485760` | 이 크기를 넘기 전에 `<path>.1`로 rotate (backup 1개) |
| `WORKSPACE_EXTRA_DENY_PATTERNS` | (없음) | 쉼표로 구분한 path segment glob(`*`만 지원). 기본 deny 목록에 추가만 가능 |

정수 설정은 1 이상 `Number.MAX_SAFE_INTEGER` 이하여야 한다. 값이 잘못되면 stderr에 이유를 출력하고 exit code 1로 종료한다(fail closed). stdout은 MCP protocol 전용이다. startup 메시지는 stderr로, audit log는 `WORKSPACE_AUDIT_LOG`가 있으면 그 파일로, 없으면 stderr로 나간다.

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

OS 권한 경계(ADR-001 §11)가 필요하면 child를 container로 띄운다. container에는 workspace와 audit log directory만 mount되므로 PathGuard에 결함이 있어도 host의 다른 파일에 닿지 않는다. `-i`는 필수이고 `-t`는 쓰지 않는다(stdout이 MCP channel).

```sh
--mcp-command "env -u CONTROL_PLANE_API_KEY -u OPENAI_API_KEY docker run -i --rm --network none --read-only -u 12345:12345 \
  -v <repo>:/app:ro -v <project>:/workspace -v <audit-dir>:/logs \
  -e WORKSPACE_ROOT=/workspace -e WORKSPACE_MODE=read-write -e WORKSPACE_AUDIT_LOG=/logs/audit.jsonl \
  node:26-bookworm node /app/dist/index.js"
```

`<repo>`는 `pnpm install`과 `pnpm build`를 마친 이 repo다. Linux host에서는 `-u`로 준 uid가 `<project>`의 파일을 읽고 쓸 수 있어야 하고, 새 파일은 그 uid 소유로 생긴다(Docker Desktop for Mac은 host 사용자로 매핑한다). `docker run` 단독 stdio 호출은 확인했지만 `tunnel-client` 경유는 아직 확인하지 않았다(implementation notes 6절).

`run`이 healthy인 동안 ChatGPT에서 connector를 만든다.

1. Settings > Security and login에서 Developer mode를 켠다.
2. https://chatgpt.com/plugins 에서 새 connector를 추가하고 Connection으로 Tunnel을 골라 tunnel을 선택한다(또는 `tunnel_id` 입력).
3. 인증은 **인증 없음(No authentication)**을 고른다. 이 서버는 OAuth를 구현하지 않으므로 OAuth를 고르면 "does not implement OAuth" 오류가 난다. 접근 통제는 OpenAI의 tunnel 권한이 맡는다(ADR 17 Amendment).
4. tool 7개가 발견되는지 확인한다.

Responses API에서는 `tools: [{"type": "mcp", "server_label": "private_workspace", "tunnel_id": "tunnel_..."}]`로 같은 tunnel을 쓸 수 있다(`server_url`은 쓰지 않음).

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
