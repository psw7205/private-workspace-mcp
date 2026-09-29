# AGENTS.md

이 repo에서 개발하는 사람과 coding agent를 위한 규칙이다. 제품 개요와 사용법은 `README.md`와 `docs/getting-started.md`에 있다.

## 먼저 읽을 것

- `docs/prd.md`, `docs/adr/001-architecture.md`: 범위와 아키텍처 결정의 출발점. 고도화하며 필요하면 Amendment나 새 ADR로 바꾼다.
- `docs/implementation-notes.md`: 문서에 없던 결정(C/M 번호), 잔여 위험, 알려진 제약, 검증 결과, TODO.
- 문서에서 결정되지 않은 중요한 사항은 임의로 확장하지 말고 가장 단순하고 보수적인 쪽을 택한다. 택한 결정은 `docs/implementation-notes.md`에 기록한다.
- ADR 원문은 고치지 않는다. 결정이 바뀌면 해당 절에 `Amendment (날짜)`를 추가한다.
- implementation notes의 M 항목도 덮어쓰지 않는다. 결정이 바뀌면 새 M 항목을 추가하고 원래 항목에 `(이후 Mxx로 대체)`를 표시한다.
- 바뀐 결정 찾기: `grep -rn "Amendment (" docs`. 새 결정은 `docs/adr/NNN-*.md`, 세부 결정은 implementation notes의 M 표, 변경 이유는 `git log -- docs/`.

## 문서 배치

| 문서 | 독자 | 담는 것 |
|------|------|---------|
| `README.md` | 처음 온 사용자 | 소개, 예시, 빠른 시작, tool 요약. 상세는 링크로 넘긴다 |
| `docs/getting-started.md` | 운영자 | 설치, tunnel 연결, 업그레이드, 여러 repo, container, 문제 해결 |
| `docs/reference.md` | 운영자, client 작성자 | tool 인자, error code, 환경 변수, CLI |
| `docs/security.md` | 운영자, 리뷰어 | 방어 계층, Git hardening, client 승인 |
| `docs/hosted-verification.md` | 개발자 | ChatGPT UI(hosted) 경로로 미출시 기능을 확인하는 수동 절차 |
| `AGENTS.md` | 개발자, coding agent | 명령, 불변식, 테스트 규칙, 릴리즈, 구조 |

- tool, error code, env를 추가하거나 바꾸면 `docs/reference.md`를 고치고, README의 tool 요약 표와 특징이 여전히 맞는지 본다.
- `docs/assets/`의 스크린샷은 가짜 demo fixture로 `pnpm build` 후 MCP Inspector를 띄워 찍는다. Inspector는 server command와 env를 화면에 보여 주므로, 경로가 드러나지 않게 wrapper script(예: PATH에 둔 `private-workspace-mcp` shim이 `WORKSPACE_ROOT`를 설정)로 띄운다. host 절대 경로나 사용자 이름이 보이는 이미지는 올리지 않는다.
- README의 예시 응답도 같은 방식으로 실제 서버에서 받은 값을 쓴다.

## 명령

toolchain은 `mise.toml`로 pin한다(Node 26, pnpm). shell에 mise가 활성화되어 있지 않으면 앞에 `mise exec --`를 붙인다.

```sh
mise install                    # Node 26, pnpm
pnpm install --frozen-lockfile
pnpm typecheck      # tsc (TypeScript 7), noEmit
pnpm test           # vitest: unit + stdio integration (서버 process를 직접 spawn)
pnpm build          # tsc -p tsconfig.build.json -> dist/index.js
pnpm bundle         # release/: index.mjs, THIRD_PARTY_LICENSES.txt, SHA256SUMS
pnpm e2e:tunnel     # build 후 tunnel-client dev proxy 경유 e2e (tunnel-client 필요, OpenAI credential 불필요)
pnpm install:local  # clean tree 검증·bundle 후 ~/.local/share/private-workspace-mcp/v<version>-<commit>에 설치하고 current 전환 (macOS, Linux)
```

작업 완료를 보고하기 전에 `pnpm typecheck`와 `pnpm test`를 실행한다. 서버 entry, transport, 종료 처리를 바꿨다면 `pnpm e2e:tunnel`까지 실행한다.

- 로컬에서 tool을 직접 호출해 보려면 `npx @modelcontextprotocol/inspector -e WORKSPACE_ROOT="$PWD" -- node dist/index.js`. 서버 환경 변수는 `-e`로 넘긴다.
- `pnpm e2e:tunnel`은 `tunnel-client dev proxy --mcp-command`로 local control plane을 띄워 `tunnel-client → stdio` 경로 전체를 검증한다. legacy와 `2026-07-28` 양쪽 era, revision conflict, escape와 deny 거부, `WORKSPACE_ROOTS`·`WORKSPACE_READ_WRITE` multi case, `WORKSPACE_GIT=read-only` repo의 Git tool 호출, tunnel-client 종료 시 child 정리를 확인한다.
- `TEST_SERVER_ENTRY=release/index.mjs`를 주면 `test/stdio.test.ts`와 `pnpm e2e:tunnel`이 source 대신 bundle을 실행한다.
- CI(`.github/workflows/ci.yml`)는 ubuntu, macOS, windows에서 typecheck, test, build를 실행하고, bundle로 stdio test를 한 번 더 돌린다.
- 로컬 daemon으로 dogfooding할 때는 `pnpm install:local` 뒤 daemon을 재시작한다. profile이 repo의 `dist/`를 직접 가리키게 하지 않는다. 개발 중 `pnpm build`가 검증 안 된 build를 daemon에 올린다.
- ChatGPT UI(hosted) 경로 확인은 `docs/hosted-verification.md`의 수동 절차를 따른다.

## 보안 불변식

아래 규칙을 깨는 변경은 하지 않는다. 바꿔야 한다면 먼저 사용자와 합의하고 문서에 기록한다.

1. 모든 filesystem 접근은 `PathGuard`(`resolveExisting` / `resolveForWrite`)를 통과한다. tool이나 filesystem 모듈에서 입력 path로 직접 절대 경로를 조립하지 않는다. 예외: ADR-004 Git tool의 git child는 `src/git/` runner가 2.3~2.6절(2.4.1절 포함)을 적용한 경우에만 실행한다.
2. containment는 canonical 경로에 대한 `path.relative` 결과로 판정한다. `startsWith` 같은 문자열 prefix 비교를 쓰지 않는다.
3. deny 검사는 입력 경로와 canonical 경로 양쪽에 적용한다. 기본 deny 목록(`DEFAULT_DENY_PATTERNS`)은 설정으로 제거할 수 없게 유지한다.
4. client에 가는 message에는 host 절대 경로와 Node error message를 넣지 않는다. 오류는 workspace 상대 경로만 담은 `WorkspaceError`로 던지고, 모르는 오류는 `runTool`이 `INTERNAL_ERROR`로 바꾼다(audit에는 errno만 남긴다).
5. stdout은 MCP protocol 전용이다. `console.log`를 쓰지 않는다. 진단 메시지는 stderr로 보낸다.
6. audit record에는 파일 내용, secret, 환경 변수 값을 넣지 않는다.
7. write 규칙을 유지한다: 기본 read-only, 기존 파일은 `expected_revision` 필수, temp file + fsync + rename, 새 파일은 `link()`로 생성.
8. 새 tool은 `runTool`로 감싸고(timeout, error 변환, audit) `annotations`를 설정한다. shell, Git, process 실행 tool은 별도 ADR 없이 추가하지 않는다. Git read-only tool은 ADR-004를 따른다.

## 테스트 규칙

- security에 영향을 주는 변경은 실패하는 test를 먼저 작성하고, red를 확인한 뒤 구현한다.
- fixture는 `test/helpers.ts`의 `createFixture()`(`os.tmpdir()` 아래 임시 디렉터리)를 쓴다. macOS에서는 `tmpdir`이 `/var → /private/var` symlink 뒤에 있어서, symlinked root case가 자연스럽게 검증된다.
- 오류 경로를 추가하면 host 경로 비노출(`expectNoHostPath`)도 확인한다.
- Windows 호환: directory symlink에는 `'dir'` type을 준다. POSIX signal, FIFO, file mode test는 `win32`에서 건너뛴다.
- tracked 파일(test 포함)에 `/Users/...` 같은 로컬 절대 경로를 넣지 않는다.
- tracked 파일에 credential 형식 값(`AKIA…`, `ghp_…`, PEM private key 등)을 literal로 넣지 않는다. 그 파일은 내용 검사(ADR-010)에 걸려 이 repo를 workspace로 둔 agent가 읽을 수 없게 되고, `test/content-patterns.test.ts`가 실패한다. test 값은 `test/helpers.ts`의 `FAKE_CREDENTIALS`처럼 runtime에 이어 붙여 만든다(M75).

## 함정

- TypeScript 7은 `types` 기본값이 `[]`다. `tsconfig.json`의 `types: ["node"]`를 지우면 Node 타입이 사라진다. `strict`는 기본값이라 따로 적지 않는다.
- MCP SDK `serveStdio`는 stdio connection을 첫 요청의 protocol era로 pin한다. OpenAI hosted 경로는 `2026-07-28` self-contained 요청을 보낸다(implementation notes 4절).
- SDK client에서 version pin은 `versionNegotiation: { mode: { pin: '2026-07-28' } }` 형태다. `{ pin }`만 쓰면 조용히 무시되고 legacy로 연결된다.
- `tunnel-client`는 child에 자기 환경 변수를 그대로 넘긴다. runtime key를 child에 넘기지 않으려면 `--mcp-command`를 `env -u CONTROL_PLANE_API_KEY -u OPENAI_API_KEY ...`로 감싼다.
- 로컬 `.env`(git ignore 대상)의 `TUNNEL_ID`는 `init --tunnel-id`로 profile에 넣고, `API_KEY`는 실행 시 `CONTROL_PLANE_API_KEY`로 넘긴다. `CONTROL_PLANE_TUNNEL_ID`를 export하면 profile의 `tunnel_id`를 덮어써서 profile이 여러 개일 때 tunnel이 섞인다. 값은 출력하지 않는다.

## 릴리즈

1. `package.json`의 `version`과 `src/server/server.ts`의 `SERVER_VERSION`을 올린다. 둘이 다르면 stdio test가 실패한다. `docs/getting-started.md` 설치 절의 `VERSION=`도 맞춘다.
2. `main`에 commit하고 push한 뒤 CI가 통과하는지 본다.
3. `git tag vX.Y.Z && git push origin vX.Y.Z`. `.github/workflows/release.yml`이 tag와 `package.json` version이 같은지 확인하고, test와 bundle 뒤에 attestation을 만들어 GitHub Release에 `index.mjs`, `index.mjs.map`, `THIRD_PARTY_LICENSES.txt`, `SHA256SUMS`를 올린다.

bundle은 minify하지 않는다. release된 파일을 그대로 읽고 감사할 수 있게 하기 위해서다.

## 구조

```text
src/
  index.ts                 stdio entry: config 로드, serveStdio, 종료 처리
  cli.ts                   --check, --version 처리
  server/server.ts         McpServer factory와 tool 등록
  tools/                   tool 정의(schema, annotation)와 공통 runTool(timeout, error 변환, audit)
  filesystem/              PathGuard, reader, lister, writer, editor, 검색(walker, glob, ignore 파일), revision
  policy/deny-list.ts      민감 파일 deny pattern
  policy/content-patterns.ts  내용 기반 credential pattern (ADR-010)
  git/                     Git read-only runner(hardened env·인자, process group), repository·config·rev 검사, status/diff/log/show (ADR-004)
  config/config.ts         env 파싱과 검증
  audit/audit-log.ts       stderr/file audit sink
  errors/errors.ts         error code와 fs error 변환
test/                      vitest (security case 중심, fixture는 임시 디렉터리)
scripts/
  bundle.ts                release bundle과 third-party license 수집
  e2e-tunnel-client.ts     tunnel-client dev proxy 경유 e2e
  install-local.ts         source checkout을 release와 같은 구조로 로컬 설치
docs/                      사용자 문서, PRD, ADR, implementation notes
```

## Git

- 작업 단위마다 branch를 만든다. 검증이 끝나면 `main`에 squash merge하고, branch tree와 `main` tree가 같은지 확인한 뒤 branch를 삭제한다.
- commit subject는 `type(scope): 설명`(72자 이하)이다. 설명과 body는 한국어로 쓰고, 식별자·경로·명령은 영어 그대로 backtick으로 감싼다.
- push는 사용자가 명시적으로 요청할 때만 한다.
