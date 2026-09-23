# Implementation Notes — MVP

PRD와 ADR-001을 기준으로 MVP를 구현하면서 문서에 결정되지 않았거나 서로 긴장 관계에 있는 항목을 어떻게 닫았는지 기록한다. 원칙은 "문서 범위를 넘기지 않고, 가장 단순하고 보수적인 선택"이다.

## 1. PRD / ADR 검토 결과

### 1.1 모순 또는 긴장

| # | 항목 | 문서 내용 | 결정 |
|---|------|-----------|------|
| C1 | 대용량 파일 | PRD 6.2 "대용량 파일은 pagination/range로 읽는다" vs PRD 10·15-8 "대용량 read는 limit에서 차단" | 파일 크기가 `max read bytes`를 넘으면 `FILE_TOO_LARGE`. 그 이하 파일은 line 단위 pagination(`start_line`, `max_lines`, 1-based) |
| C2 | revision 요구 수준 | PRD 7 "가능하면 revision 요구" vs PRD 15-9 "stale revision write는 실패" | 기존 파일 덮어쓰기는 `expected_revision` **필수**. 대상이 없으면 `expected_revision`을 생략해야 하며 create-only로 동작 |
| C3 | read-only 모드의 `write_file` | PRD 7 MVP tool 목록 vs PRD 13 `READ_ONLY` error | tool은 항상 등록하고, read-only 모드에서는 `READ_ONLY`를 반환 |

### 1.2 누락 (문서에 결정 없음)

| # | 항목 | 결정 | 근거 |
|---|------|------|------|
| M1 | revision 범위 | 항상 **파일 전체 bytes**의 SHA-256 (`sha256:<hex>`). line window만 읽어도 동일 | window 단위 revision이면 paginated read 후 write가 불가능 |
| M2 | deny pattern 매칭 의미 | 모든 path segment에 basename glob(`*`만 지원)을 **case-insensitive**로 적용. 입력 경로와 canonical(realpath) 경로 둘 다 검사 | macOS/Windows case-insensitive FS에서 `.ENV` 우회, workspace 내부 symlink(`foo -> .env`) 우회 방지 |
| M3 | deny 목록 | PRD 9 예시 + `.git` (이후 M26으로 확장). 운영자는 `WORKSPACE_EXTRA_DENY_PATTERNS`로 추가만 할 수 있고 기본 목록은 제거할 수 없음 | `.git/hooks` 쓰기는 사용자의 다음 git 명령에서 코드 실행으로 이어지고, `.git/config`에는 credential이 들어 있을 수 있음. Git은 Phase 4 typed tool로 다룬다 |
| M4 | listing에서 deny 항목 | 결과에서 생략 | 민감 파일 존재 여부도 노출하지 않음 |
| M5 | binary 판정 | 앞 8 KiB에 NUL byte가 있으면 `BINARY_FILE` | 단순하고 흔한 heuristic |
| M6 | 새 파일의 parent directory | 없는 parent는 생성. 가장 가까운 기존 ancestor를 canonicalize해 containment를 확인한 뒤, 누락된 segment만 하나씩 `mkdir`하고 다시 realpath로 재확인 | PRD 6.4(`docs/architecture.md` 생성)와 PRD 8.3("가장 가까운 기존 parent를 canonicalize")이 누락 parent를 전제함. MVP에는 별도 mkdir tool이 없음 |
| M7 | symlink에 쓰기 | 대상 경로의 마지막 component가 symlink면 거부(`INVALID_PATH`) | atomic rename은 link 자체를 교체하므로 의미가 모호함. 가장 보수적인 선택 |
| M8 | symlink 탐색 | listing은 symlink를 따라가지 않고 `type: symlink`로만 표시. read는 realpath가 workspace 내부이고 deny에 걸리지 않을 때만 허용 | PRD 8.3 symlink escape 방어 |
| M9 | 특수 파일(FIFO/socket/device) | read는 `NOT_A_FILE`. listing에서는 생략 | FIFO read는 무기한 block될 수 있음 |
| M10 | audit log 출력 위치 | 기본은 stderr에 JSON Lines. `WORKSPACE_AUDIT_LOG`가 있으면 파일에 append하고 size 기준으로 `.1` backup 1개만 유지. 파일은 workspace 밖에 있어야 하고 symlink면 startup 거부. 쓰기 실패 시 stderr로 fallback | stdout은 MCP protocol channel. workspace 안에 두면 agent가 `read_file`/`write_file`로 audit을 읽거나 조작할 수 있음 |
| M11 | 설정 방식 | env만 사용. 잘못된 값이면 startup 실패(fail closed) | PRD 8.1 예시가 `WORKSPACE_ROOT=` |
| M12 | 경로 문법 | `..` segment는 위치와 무관하게 거부. `\`, drive letter, UNC, NUL/control 문자, Windows reserved name, `:` `<>"\|?*`, `.`/공백으로 끝나는 segment는 **모든 OS에서** 거부 | Windows에서 `.env.` → `.env`, `.env::$DATA` 같은 alias로 deny를 우회하는 경로를 플랫폼과 무관하게 차단 |
| M13 | request timeout | tool handler 전체에 timeout을 걸고 `TIMEOUT`을 반환. 이미 시작된 fs 작업은 취소되지 않으므로 write timeout 메시지에 "재조회로 결과 확인"을 명시 | Node fs 작업은 취소 불가 |
| M14 | 동시 write | 같은 canonical path에 대한 write는 process 내 lock으로 직렬화 | tunnel-client 기본 동시 요청 수가 10이므로 agent 요청끼리의 revision race를 막음 |
| M15 | 새 파일 create-only 보장 | temp file을 쓴 뒤 `link(tmp, target)`. target이 이미 있으면 `EEXIST` → `REVISION_CONFLICT` | check와 create 사이의 race를 제거 |
| M16 | 기존 파일 mode | overwrite 시 temp file을 기존 file mode로 생성하고, umask 보정을 위해 rename 전에 다시 chmod | rename으로 inode가 바뀌면서 실행 비트 등이 사라지는 것을 방지. 기본 mode로 만든 뒤 chmod하면 `0600` 파일의 새 내용이 잠시 다른 로컬 사용자에게 읽힐 수 있음 |
| M17 | non-UTF-8 파일 | 유효한 UTF-8이 아니면 read를 `BINARY_FILE`로 거부(strict decode). 새 error code는 만들지 않음 | lossy decode는 잘못된 byte를 U+FFFD로 바꾸는데 revision은 원본 byte 기준이라, 읽은 content를 그대로 write하면 EUC-KR·latin1 파일이 조용히 손상됨. `ErrorCode`와 PRD 13 표를 바꾸지 않는 쪽을 택함 |
| M18 | read limit을 넘는 기존 파일 overwrite | revision 계산 전에 `FILE_TOO_LARGE`로 거부. revision 계산은 `readRegularFile`을 재사용 | `read_file`이 이런 파일의 revision을 주지 않으므로 overwrite는 성공할 수 없다. 제한 없이 hash하면 임의 `expected_revision` 하나로 lock을 쥔 채 큰 IO를 일으킬 수 있음 |

### 1.2.1 Phase 2·3 결정 (2026-09-23)

| # | 항목 | 결정 | 근거 |
|---|------|------|------|
| M19 | `edit_file` | exact-match 단일 교체. `expected_revision` 필수, 0개 match `EDIT_NO_MATCH`, 여러 match는 `replace_all` 없으면 `EDIT_AMBIGUOUS`. 읽기는 `read_file` 규칙, 쓰기는 `write_file` 교체 경로 재사용 | ADR-002 |
| M20 | 검색 tool 범위 | `find_files`: glob을 기준 디렉터리 상대 경로에 자체 matcher(`src/filesystem/glob.ts`)로 적용. `*`·`?`는 segment 안, `**`는 segment 단위로 0개 이상, `{a,b}`는 중첩 없이 확장 64개까지, 패턴은 256자까지. 나머지 문자는 literal(extglob, 문자 class, 숫자 범위 없음). `.`으로 시작하는 segment는 패턴에 명시해야 맞고, 대소문자는 모든 platform에서 구분. 패턴 앞의 `./`는 제거. `path.posix.matchesGlob`은 쓰지 않는다: brace 확장과 extglob regex가 동기로 돌아 `{1..20000}`에 1.4초, `+(a|aa)+(a|aa)+(a|aa)+(a|aa)b`에 100초 넘게 event loop를 막았다(2026-09-23, Node 26.10). 자체 matcher는 alternative 간에 segment 조각을 공유하고 (조각, path segment) 쌍을 후보마다 한 번만 비교한다. 255자 이름 16단 경로와 64-alternative 256자 패턴의 최악 사례가 match 1회 약 40 ms(macOS, Node 26.10)이고, walker가 파일마다 abort를 확인하므로 timeout이 동작한다. `search_text`: literal 검색, `case_sensitive` 기본 false, 줄마다 첫 match 하나를 결과로. regex와 외부 process는 쓰지 않음 | 동기 regex는 `runTool` timeout으로 끊을 수 없어 catastrophic backtracking에 취약. process 실행은 ADR-001 15절 |
| M21 | 검색 순회 규칙 | `list_directory`와 같다: symlink 미추적, deny는 입력·canonical 양쪽, 특수 파일 제외. `search_text`는 read limit 초과, binary(NUL), non-UTF-8 파일을 건너뛴다. depth 제한(`WORKSPACE_MAX_DEPTH`)은 적용하지 않음 | depth 3이면 recursive 검색이 의미 없음. 대신 M22 상한으로 작업량을 막음 |
| M22 | 검색 작업량 상한 | 순회 중 만나는 regular file 수를 `WORKSPACE_MAX_SEARCH_FILES`(기본 10000)로 제한하고, 결과 수는 `limit`(최대 `WORKSPACE_MAX_DIRECTORY_ENTRIES`)으로 제한. 어느 쪽에 걸렸는지 `truncated`와 `scan_limit_reached`로 구분 | 결과가 적은 검색도 순회 비용은 클 수 있음 |
| M23 | ignore 파일 | 순회하는 각 디렉터리의 `.gitignore`, `.ignore`를 `ignore` package로 적용. 규칙은 그 디렉터리 기준이고 상위 규칙도 함께 적용. ignore된 디렉터리는 들어가지 않으므로 그 아래 파일은 negation으로 되살릴 수 없음(git과 같음). `include_ignored: true`면 적용하지 않음. ignore 파일 자체는 `lstat`으로 regular file임을 확인한 뒤(Windows에는 `O_NOFOLLOW`가 없음) 읽고, deny 대상·read limit 초과·non-UTF-8이면 없는 것으로 취급. 규칙은 canonical 상대 경로로 맞추므로 검색 시작 경로의 상위 디렉터리 ignore 파일도 적용. 대소문자는 `ignore` package 기본값대로 무시. ignore된 파일은 검색 파일 수 상한에 세지 않음. 검색 기준 경로 자체가 상위 규칙에 ignore되면(예: `node_modules/pkg`) 호출자가 명시한 것으로 보고 상위 ignore 파일을 적용하지 않음. 기준 경로 아래의 ignore 파일은 그대로 적용. `list_directory`, `read_file`에는 적용하지 않음. global excludes와 `.git/info/exclude`는 읽지 않음(`.git`은 deny) | 검색 결과에서 `node_modules`, build 산출물 같은 소음을 뺌. ignore는 편의 기능이지 보안 경계가 아니므로 deny와 섞지 않음 |
| M24 | timeout 후 작업 중단 | `runTool`이 timeout 때 `AbortSignal`을 abort하고 검색 순회는 파일마다 signal을 확인해 멈춤 | 이전에는 timeout 응답 뒤에도 순회가 끝까지 돌았음 |
| M25 | well-formed가 아닌 content | `write_file`·`edit_file` 결과에 lone surrogate가 있으면 `BINARY_FILE`로 거부 | `Buffer.from`이 lone surrogate를 U+FFFD로 바꿔, 보낸 것과 다른 내용이 저장됨. `edit_file`에서 `old_string`이 surrogate pair의 절반이면 파일이 손상됨 |

### 1.2.2 보안 피드백 후속 결정 (2026-09-23)

ChatGPT에서 connector로 black-box 점검한 피드백 중 코드로 닫을 수 있는 항목이다.

| # | 항목 | 결정 | 근거 |
|---|------|------|------|
| M26 | deny 목록 확장 | `secrets*`를 `secret*`로 넓히고 `.git-credentials`, `service-account*.json`, `id_rsa*`, `id_ed25519*`, `*.tfstate`, `*.tfstate.*`, `.kube`, `kubeconfig*`, `.docker`, `.pypirc`, `*.p12`, `*.pfx`를 추가. PRD 9 원문 목록은 고치지 않음 | `secrets*`는 `secret.yaml`을 놓쳤고, 나머지는 `.ssh`·`.aws` 밖에 흔히 놓이는 credential. `secretary.md` 같은 오탐은 read 거부로 끝나지만 누락은 되돌릴 수 없음. deny는 여전히 보조 방어(PRD 9) |
| M27 | 넓은 root 거부 | canonical root가 filesystem root이거나 canonical home을 포함하면(home 자신과 그 상위) startup 실패. home을 알 수 없으면(`HOME` 미설정 + passwd entry 없는 uid) home 검사만 건너뜀 | root가 사실상 sandbox 경계. `$HOME`이면 deny에 없는 home 아래 모든 파일이 노출됨. 전용 uid로 container를 띄우는 구성(README)이 막히지 않게 home 조회 실패는 허용 |

### 1.2.3 CI 후속 결정 (2026-09-23)

| # | 항목 | 결정 | 근거 |
|---|------|------|------|
| M28 | 파일을 디렉터리로 쓴 경로 | `resolveExisting`에서 `realpath`가 `ENOENT`면 가장 가까운 존재하는 상위 경로를 `stat`하고, directory가 아니면 `NOT_A_DIRECTORY`. 상위를 `stat`할 수 없으면 원래 `FILE_NOT_FOUND` | `README.md/x`에 POSIX는 `ENOTDIR`, Windows는 `ENOENT`를 줘서 첫 Windows CI job에서 오류 code가 갈렸다. 거부 여부는 같고 code만 OS와 무관하게 맞춘다. symlink 상위는 POSIX `realpath`처럼 따라가서 판정한다 |

### 1.2.4 릴리즈 결정 (2026-09-23)

| # | 항목 | 결정 | 근거 |
|---|------|------|------|
| M29 | 배포 형태 | `vX.Y.Z` tag에서 CI가 만든 단일 파일 ESM bundle(`index.mjs`, esbuild, minify 없음)을 GitHub Release로 배포. bundle에 들어간 package의 license 파일을 `THIRD_PARTY_LICENSES.txt`로 함께 올리고, license 파일이 없는 package가 있으면 bundle이 실패. npm publish, container image, Node SEA는 쓰지 않음 | 실행 머신에 Node 26만 있으면 되고 파일 하나라 버전 식별과 rollback이 쉬움. `npx`식 실행은 daemon이 뜰 때 registry에서 받아오므로 supply-chain 위험이 있음. container는 `tunnel-client` 경유가 미검증(6절). Node SEA는 platform별 build와 codesign이 필요해 과함. ADR-001의 Go/단일 binary 재검토 조건에는 해당하지 않음(Node 런타임은 유지) |
| M30 | 무결성 | release는 CI에서만 build. tag와 `package.json` version이 다르면 실패. `SHA256SUMS`의 모든 파일에 `actions/attest`로 build provenance를 붙이고, 설치 시 `shasum -c`와 `gh attestation verify`로 확인. `SERVER_VERSION`은 stdio test가 `package.json`과 비교. bundle이 build 머신의 project 경로를 담으면 실패 | public repo라 attestation을 무료 plan에서도 쓸 수 있음. checksum은 같은 Release에 있어 asset 교체를 막지 못하므로 서명된 provenance로 보완 |
| M31 | 설치 layout | `$HOME/.local/share/private-workspace-mcp/<version>/`에 풀고 `current` symlink를 profile이 가리킴 | `tunnel-client` profile은 절대 경로를 담으므로 한 번만 만들고, 업그레이드와 rollback은 symlink 교체로 끝냄 |

### 1.3 구조 조정

- ADR 7의 `policy/workspace-policy.ts`는 만들지 않는다. mode 판정은 config 값 하나로 충분하다. 파일이 필요해지면 Phase 8 policy engine에서 도입한다.
- TypeScript 7 기본값(`strict` true, `rootDir` `./`, `types` `[]`)에 맞춰 tsconfig에서 중복 옵션을 제거했다. `types: ["node"]`는 TS 7에서 기본값이 `[]`가 되어 명시가 필수다. `target`/`lib`는 7.x minor에서 기본값이 바뀌어도 build 출력이 흔들리지 않도록 `ES2025`로 명시한다.
- ADR 7에 없는 `filesystem/directory-lister.ts`와 `tools/run-tool.ts`(timeout, error 변환, audit을 담당하는 공통 wrapper)를 추가한다.

## 2. 설정

| env | 기본값 | 설명 |
|-----|--------|------|
| `WORKSPACE_ROOT` | (필수) | 절대 경로. 존재하는 directory여야 하며 startup 시 realpath로 고정. filesystem root, home, home의 상위는 거부(M27) |
| `WORKSPACE_MODE` | `read-only` | `read-only` \| `read-write` |
| `WORKSPACE_NAME` | root basename | `get_workspace_info`에 노출되는 이름 |
| `WORKSPACE_MAX_READ_BYTES` | `1048576` | 이 크기를 넘는 파일은 read 거부 |
| `WORKSPACE_MAX_WRITE_BYTES` | `1048576` | UTF-8 기준 write content 최대 크기 |
| `WORKSPACE_MAX_DIRECTORY_ENTRIES` | `1000` | `list_directory` 1회 응답의 최대 entry 수 |
| `WORKSPACE_MAX_DEPTH` | `3` | `list_directory` 최대 depth |
| `WORKSPACE_REQUEST_TIMEOUT_MS` | `10000` | tool call timeout. 최대 `2147483647`(Node timer 한도) |
| `WORKSPACE_MAX_SEARCH_FILES` | `10000` | 검색 한 번이 순회 중 만나는 regular file 수 상한(M22) |
| `WORKSPACE_AUDIT_LOG` | (없음 → stderr) | audit JSONL 파일 절대 경로. workspace 밖이어야 하며 symlink는 거부. 새로 만들 때 권한 `0600`(이미 있는 파일의 권한은 바꾸지 않음) |
| `WORKSPACE_AUDIT_LOG_MAX_BYTES` | `10485760` | 이 크기를 넘기 전에 `<path>.1`로 rotate (backup 1개) |
| `WORKSPACE_EXTRA_DENY_PATTERNS` | (없음) | 쉼표로 구분한 path segment glob(`*`만 지원). 기본 deny 목록에 추가만 가능 |

정수 설정은 모두 1 이상 `Number.MAX_SAFE_INTEGER` 이하여야 한다. 범위를 벗어나면 startup이 실패한다. timeout 상한이 따로 있는 이유는 `setTimeout`이 `2^31-1`보다 큰 값을 1 ms로 바꿔 모든 tool call이 `TIMEOUT`이 되기 때문이다.

## 3. 잔여 위험 (MVP에서 수용)

- **TOCTOU**: 경로 검증과 실제 open 사이에 로컬 프로세스가 중간 directory를 symlink로 바꾸면 우회할 수 있다. Node에는 `openat2(RESOLVE_BENEATH)`가 없다. 마지막 component는 `O_NOFOLLOW`로 open해 줄이지만, 최종 경계는 ADR 11대로 OS 권한이다.
- **hard link**: workspace 안에 외부 파일로 향하는 hard link가 있으면 읽을 수 있다. 이런 link를 만들려면 이미 해당 파일 권한이 있어야 하므로 OS 권한 경계에 맡긴다. write는 rename 방식이라 link 대상 inode를 수정하지 않는다.
- **revision check와 rename 사이의 사용자 편집**: 아주 짧은 window가 남는다. 동일 process 내 agent 요청끼리는 lock으로 막는다.
- **Windows 실동작**: 경로 문법 방어는 OS와 무관하게 적용했다. 하지만 junction, 8.3 short name, case 처리 등 실제 Windows 동작은 로컬에 Windows host가 없어 검증하지 못했다. `.github/workflows/ci.yml`의 `windows-latest` job이 test suite를 실행한다. 첫 실행에서 오류 code 차이 1건이 나와 M28로 고쳤다.
- **prompt injection을 통한 write**: read-write 모드에서 model이 읽은 파일에 심어진 지시가 `write_file`·`edit_file` 호출로 이어질 수 있다. revision은 model도 `read_file`로 얻으므로 방어가 아니다. 서버는 read-only 기본값과 `destructiveHint`만 제공하고, 승인은 client 설정(README)에 맡긴다. 피해 복구 수단(revision history, rollback)은 PRD Phase 2 범위다.
- **child 환경 변수 상속**: `tunnel-client`의 환경(`CONTROL_PLANE_API_KEY` 포함)이 MCP child에 그대로 상속된다. 서버는 환경 변수를 어떤 tool로도 노출하지 않지만, 격리가 필요하면 `--mcp-command`를 `env -u CONTROL_PLANE_API_KEY -u OPENAI_API_KEY ...`로 감싼다.

## 4. 알려진 제약: stdio connection의 protocol era pin

MCP TypeScript SDK v2의 `serveStdio`는 첫 opening 요청으로 connection의 era(2025 `initialize` 또는 `2026-07-28` stateless)를 정하고, 그 connection 동안 instance 하나를 유지한다. `tunnel-client`는 모든 caller를 stdio child 하나로 multiplex하므로 era가 섞이면 실패한다. `tunnel-client dev proxy`로 확인한 결과는 다음과 같다.

| 같은 child에서의 요청 순서 | 결과 |
|---------------------------|------|
| modern → modern | 둘 다 성공 |
| legacy → legacy | 둘 다 성공 |
| legacy → modern | modern 실패: `server/discover` 미제공 |
| modern → legacy | legacy 실패: `Unsupported protocol version: 2025-11-25` |

SDK 문서(`protocol-versions`)에도 stdio에서는 era를 섞어 받는 옵션이 없다. MVP는 SDK 기본 posture를 유지한다.

**hosted 관측 결과 (2026-09-23, `tunnel-client` 0.0.14):** Responses API의 `{"type":"mcp","tunnel_id":…}` 도구로 요청했을 때, OpenAI tunnel-service가 stdio child에 보낸 요청은 `2026-07-28` self-contained 형식이었다. 순서는 `server/discover`(id `openai-mcp-discover`) 다음 `tools/list`였고, 둘 다 `_meta`에 `io.modelcontextprotocol/protocolVersion`, `clientInfo`, `clientCapabilities`가 있었다. 서버는 두 요청에 모두 정상 응답했다. 이는 stdio `main` channel이 `stateless`를 선언하지 않는다는 tunnel-client 문서만 보고 legacy를 예상했던 앞선 판단과 다르다.

운영 영향은 다음과 같다.

- OpenAI 경로만 쓰면 child는 modern으로 pin되고 정상 동작한다.
- 2025-era(legacy) client가 같은 tunnel-client의 child에 **먼저** 붙으면 child가 legacy로 pin되어 이후 OpenAI 요청이 실패한다. 이때는 `tunnel-client`를 재시작하면 복구된다.
- `legacy: 'reject'`(modern 전용)는 채택하지 않았다. 채택 당시에는 ChatGPT UI connector의 era를 검증하지 못했기 때문이다.

**ChatGPT UI 관측 결과 (2026-09-23, `tunnel-client` 0.0.14):** ChatGPT 웹 Developer mode에서 Secure MCP Tunnel connector를 만들었을 때 child에 온 요청은 `rpc_request_id` `openai-mcp-discover` 다음 `0`이었다. Responses API 경로와 같은 순서와 id이므로 ChatGPT UI도 `2026-07-28` modern era(`server/discover` → `tools/list`)로 요청한다고 본다. `tunnel-client` 로그에는 method 이름이 남지 않아 id 일치에 근거한 판단이다. 이로써 OpenAI의 두 경로(Responses API, ChatGPT UI)가 모두 modern이므로 legacy pin 위험은 같은 tunnel에 2025-era client를 따로 붙이는 경우로 한정된다. era routing은 도입하지 않는다.

## 5. 구현 계획

```text
0. git init, baseline commit                  -> verify: git log
1. scaffold (pnpm, tsconfig, vitest)          -> verify: pnpm typecheck, pnpm test
2. security test 정의 (path-guard, deny, reader, writer, lister)
                                              -> verify: 구현 전 red 확인
3. errors / config / deny-list / path-guard   -> verify: 해당 test green
4. revision / file-reader / directory-lister  -> verify: 해당 test green
5. file-writer                                -> verify: 해당 test green
6. tools + run-tool + audit + server + stdio entry
                                              -> verify: stdio integration test (spawn, tools/list, call, stdin EOF 시 종료)
7. tunnel-client dev proxy --mcp-command로 e2e -> verify: MCP client가 tunnel 경유로 tools/list, tools/call 성공, tunnel-client 종료 시 child 종료
8. README, 결과 정리                           -> verify: 문서에 로컬 절대 경로 없음
```

## 6. 검증 결과

- `pnpm test`: unit과 stdio integration을 합쳐 12 files, 345 tests 통과. 커버 범위는 audit 파일 출력과 rotation, 추가 deny pattern, path traversal, 절대/drive/UNC 경로, Windows alias, symlink escape(file/dir/parent/dangling/re-enter), deny 입력·canonical 양쪽, FIFO, binary와 non-UTF-8, 크기 제한, read limit을 넘는 파일 overwrite 거부, 정수 설정 상한, containment 경계(sibling prefix), `edit_file`(유일·다중 match, 치환 패턴 literal, surrogate pair 보호), `find_files`/`search_text`(deny·symlink·ignore 파일·상한·abort), glob 병리 패턴 시간 상한, read-only, stale/concurrent write, create race, mode 보존, temp file 정리, host 경로 비노출, legacy와 `2026-07-28` 양쪽 era, stdin EOF와 SIGTERM 시 exit 0
- `pnpm e2e:tunnel`: `tunnel-client` 0.0.14 `dev proxy --mcp-command` 경유로 tools/list(2026-09-23 재실행, 7개 tool을 legacy·modern 양쪽에서 확인), 기존 4개 tool 호출, revision conflict, escape/deny 거부, audit이 `tunnel-client` 로그에 기록되는지 확인. `tunnel-client` SIGTERM과 SIGKILL 양쪽에서 MCP child 종료
- hosted: `tunnel-client doctor` `RESULT ok`. `tunnel-client run`은 runtime key로 hosted control plane polling을 시작했고 `/healthz` live, `/readyz` ready. Responses API(`type: mcp`, `tunnel_id`) 호출 시 OpenAI → tunnel-service → `tunnel-client` → stdio child로 `server/discover`, `tools/list`가 전달되어 성공 응답했다(stdio tap으로 확인). model 추론은 API 계정 credit 부족(`429 credit_balance_exhausted`)으로 실패해 hosted `tools/call`은 확인하지 못했다. 종료 시 child 정리도 확인
- Linux: Docker `node:26-bookworm`(aarch64, Node 26.10)에서 non-root(`node`) 사용자로 clean install 후 typecheck, test(345), build 통과. Node 24 시절에는 root 사용자로도 확인
- ChatGPT UI (2026-09-23): ChatGPT 웹 Developer mode에서 인증 없음으로 만든 Secure MCP Tunnel connector 경유로 hosted `tools/call`을 확인했다(PRD 15-1). `get_workspace_info`, `list_directory`, `read_file`이 성공했고, `write_file`은 `read_file`로 받은 revision을 넘겨 기존 내용을 보존한 채 항목을 추가했다. `.env` read는 `PATH_BLOCKED`로 거부됐고 message에 host 경로가 없었다. audit 파일에는 7건이 권한 `0600`으로 기록됐다. connector를 OAuth로 만들면 ChatGPT가 "MCP server ... does not implement OAuth" 오류를 내며, 이때 요청은 child까지 오지 않는다
- container 격리 (2026-09-23): `docker run -i --network none --read-only -u 12345:12345`(passwd entry 없음, `HOME=/`)로 `node:26-bookworm`에서 stdio로 직접 호출했다. startup이 M27 검사를 통과했고 `read_file`, `write_file`(새 파일 생성)이 성공했으며 audit 파일이 권한 `0600`으로 기록됐다
- release bundle (2026-09-23): `pnpm bundle`이 4개 package(`@modelcontextprotocol/server`, `@modelcontextprotocol/core`, `zod`, `ignore`)를 묶어 891 KB `index.mjs`를 만들었다. 두 번 build한 `SHA256SUMS`가 같았다. `TEST_SERVER_ENTRY=release/index.mjs`로 stdio test 16개와 `pnpm e2e:tunnel`(legacy·modern 양쪽)이 통과했고, repo 밖 `node_modules`가 없는 directory에서도 실행됐다. release workflow는 actionlint만 통과했고 실제 tag 실행은 아직 하지 않았다
- 미검증: Responses API 경로의 `tools/call`(API credit 부족으로 model 추론 실패). 같은 tunnel-service 경로의 `tools/call`은 ChatGPT UI로 확인했다

## 7. Future TODO

PRD 16의 Phase 2~11은 그대로 유지한다. shell, Git, process execution은 구현하지 않았다. MVP 구현 중 추가로 나온 항목은 다음과 같다.

- API credit을 충전한 뒤 Responses API 경로의 `tools/call` 확인
- Phase 2·3에서 보류한 항목: line/range 교체, diff·미리보기, 여러 edit를 한 호출에, regex 검색(선형 시간 엔진 필요), 문자 class·escape가 있는 glob. ChatGPT UI에서 새 tool 3개 직접 확인
- 알려진 제약: glob의 `{`와 `}`는 alternative 전용이라 이름에 중괄호가 든 파일은 패턴으로 지정할 수 없다. 상위 ignore 규칙에 걸린 기준 경로를 검색하면 상위 ignore 파일 전체가 빠지므로 그 안의 `*.log` 같은 상위 규칙도 적용되지 않는다(M23)
- `legacy: 'reject'` 채택 검토(4절). OpenAI 두 경로가 모두 modern이라 legacy pin을 원천 차단할 수 있지만, 2025-era client 지원과 stdio legacy test를 함께 정리해야 하므로 별도 결정으로 다룬다
- README의 container 실행 예시를 `tunnel-client` `--mcp-command`로 감싸 hosted 경로에서 확인(종료 시 container 정리 포함)
- M28 반영 후 CI Windows job 재실행 결과 확인. 첫 실행(2026-09-23)은 ubuntu·macOS 통과, Windows는 `NOT_A_DIRECTORY` test 1건 실패(M28)
