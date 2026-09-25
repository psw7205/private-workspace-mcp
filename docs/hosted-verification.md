# Hosted 검증 체크리스트

`pnpm test`와 `pnpm e2e:tunnel`(`tunnel-client dev proxy`)로는 확인했지만 OpenAI hosted 경로로는 아직 확인하지 않은 기능을 ChatGPT UI에서 사람이 확인하는 절차다. 대상은 implementation notes 6절 "미검증"과 7절 TODO의 hosted 항목이다.

| 대상 | 근거 |
|------|------|
| `edit_file`, `find_files`, `search_text`, `multi_edit_file` 호출 | 2026-09-23 ChatGPT UI 확인은 MVP 4개 tool만 다룸(notes 6절) |
| `WORKSPACE_ROOTS`의 `workspace` 인자를 model이 고르는지 | ADR-008, notes 7절 |
| `WORKSPACE_READ_WRITE`로 섞인 mode를 model이 description으로 구분하는지 | ADR-008 2.2절 Amendment, M38 |
| (선택) Responses API 경로의 `tools/call` | notes 6절 "미검증" |
| (선택) container child를 `tunnel-client` 경유로 실행 | README "OpenAI Secure MCP Tunnel 연결", notes 7절 |
| (선택) `WORKSPACE_GIT=read-only` Git tool 호출 | ADR-004, notes 7절 (부록 C) |

아래 `<repo-root>`는 이 repo checkout, `<fixture>`는 검증용 임시 directory의 절대 경로다.

## 0. 준비

- README "OpenAI Secure MCP Tunnel 연결"대로 tunnel, `.env`(`TUNNEL_ID`, `API_KEY`), ChatGPT connector(Developer mode, Tunnel, 인증 없음)가 이미 있다고 가정한다. connector는 `tunnel_id`에 묶이므로 새로 만들지 않는다.
- 검증 대상 기능은 `v0.1.0` release에 없다. `<repo-root>`에서 검증할 `main` commit을 checkout하고 `pnpm install --frozen-lockfile && pnpm build`로 `dist/index.js`를 만든다. commit hash를 기록해 둔다.
- tunnel 하나에는 `tunnel-client` instance 하나만 띄운다. 평소 쓰는 `tunnel-client run`이 떠 있으면 먼저 멈춘다.
- 같은 `tunnel-client`에 2025-era(legacy) client를 붙이지 않는다. child가 legacy로 pin되면 이후 ChatGPT 요청이 실패한다(notes 4절).
- ChatGPT의 write tool 호출 확인은 켠 채로 둔다(README "보안 모델").

## 1. Fixture 만들기

repo 두 개를 흉내 낸다. `api`는 read-only, `web`은 쓰기 가능이다. `<fixture>`는 home 자체나 그 상위가 아니어야 하고(M27), audit directory는 두 workspace 밖에 둔다.

```sh
F=<fixture>
mkdir -p "$F/api/src" "$F/web/docs" "$F/audit"
printf 'API_TOKEN=dummy\n'                      > "$F/api/.env"         # deny 확인용
printf '*.log\n'                                > "$F/api/.gitignore"
printf 'needle in ignored log\n'                > "$F/api/debug.log"    # ignore 확인용
printf 'export const marker = "needle";\n'      > "$F/api/src/app.ts"
printf '# Plan\n\nstatus: draft\nowner: TBD\nTODO: a\nTODO: b\n' > "$F/web/docs/plan.md"
```

결과 layout:

```text
<fixture>/
  api/   .env  .gitignore  debug.log  src/app.ts      (read-only)
  web/   docs/plan.md                                 (read-write)
  audit/                                              (audit log, workspace 밖)
```

## 2. 검증용 profile로 daemon 띄우기

평소 profile은 건드리지 않고 같은 tunnel ID로 검증용 profile을 하나 더 만든다. `init`과 `run` 절차는 README와 같고 `--profile`과 `--mcp-command`만 다르다.

```sh
set -a && . ./.env && set +a
tunnel-client init --sample sample_mcp_stdio_local --profile workspace-mcp-verify \
  --tunnel-id "$TUNNEL_ID" \
  --mcp-command "env -u CONTROL_PLANE_API_KEY -u OPENAI_API_KEY WORKSPACE_ROOTS=api=<fixture>/api,web=<fixture>/web WORKSPACE_READ_WRITE=web WORKSPACE_AUDIT_LOG=<fixture>/audit/audit.jsonl $(mise which node) <repo-root>/dist/index.js"
```

- `WORKSPACE_MODE`는 넣지 않는다. `WORKSPACE_READ_WRITE`와 함께 주면 값과 상관없이 startup이 거부된다(M37).
- 실행은 README의 `run` 블록에서 `--profile workspace-mcp-verify`로 바꿔 쓴다. `doctor`가 `RESULT ok`이고 `http://127.0.0.1:8080/readyz`가 ready인지 본다.
- startup이 실패하면 `tunnel-client` 로그에 stderr 이유가 남는다.

선택: hosted로 가기 전에 같은 env로 MCP Inspector를 띄워 schema를 미리 볼 수 있다(README "Quick start"). Inspector는 `tunnel-client`와 별개 process라 era pin에 영향을 주지 않는다.

## 3. ChatGPT UI 확인

각 단계는 새 대화 하나에서 이어서 진행한다. 프롬프트는 예시이고, 기대 결과는 tool 결과 본문 기준이다. 오류는 `{"error":{"code":"…","message":"…"}}` 형태이며 message에 host 절대 경로(`<fixture>` 등)가 없어야 한다.

1. **connector Refresh**: https://chatgpt.com/plugins 에서 connection을 열고 Refresh를 누른 뒤 새 대화를 시작한다(README "OpenAI Secure MCP Tunnel 연결"의 반영 순서).
   - 기대: tool 8개(`get_workspace_info`, `list_directory`, `read_file`, `write_file`, `edit_file`, `multi_edit_file`, `find_files`, `search_text`). UI에 schema가 보이면 `get_workspace_info`를 뺀 7개에 필수 인자 `workspace`(enum `api`, `web`)가 있는지 본다. 보이지 않으면 3~7단계의 인자로 대신 확인한다.
2. **`get_workspace_info`**: "private workspace connector의 `get_workspace_info`를 호출하고 결과 JSON을 그대로 보여줘."
   - 기대: `workspaces: [{ name: "api", mode: "read-only" }, { name: "web", mode: "read-write" }]`, `platform`, `limits`. top-level `mode`가 없고 host 경로가 없다.
3. **`list_directory`**: "api workspace의 최상위 목록을 보여줘."
   - 기대: `workspace: "api"`로 호출. `.gitignore`, `debug.log`, `src`가 보이고 `.env`는 목록에 없다(M4). `list_directory`는 ignore 파일을 적용하지 않으므로 `debug.log`는 보인다(M23).
4. **deny**: "api workspace의 `.env`를 읽어줘."
   - 기대: `PATH_BLOCKED`. message에 host 경로가 없다.
5. **`find_files`와 ignore**: "api workspace에서 `**/*` 패턴으로 파일을 찾아줘." 다음 "같은 검색을 `include_ignored: true`로 다시 해줘."
   - 기대: 첫 호출은 `src/app.ts`만. 두 번째는 `debug.log`가 추가된다. `.gitignore`는 `.`으로 시작해 `**/*`에 맞지 않으므로 두 번 모두 없다.
6. **`search_text`와 ignore**: "api workspace에서 `needle`을 검색해줘." 다음 "`include_ignored: true`로 다시."
   - 기대: 첫 호출은 `src/app.ts` 1줄. 두 번째는 `debug.log` 1줄이 추가된다.
7. **workspace 선택**: 인자 이름을 말하지 않고 "web 쪽 `docs/plan.md`를 읽어줘."
   - 기대: model이 `workspace: "web"`을 골라 `read_file`을 호출하고 `revision`(`sha256:…`)을 받는다. 이 revision을 R1로 적어 둔다.
8. **read-only workspace에 쓰기**: "api workspace에 `NOTES.md`를 만들고 `hello`라고 써줘." 다음 "api의 `src/app.ts`에서 `needle`을 `pin`으로 바꿔줘." 마지막으로 "같은 변경을 `multi_edit_file`로 해줘."
   - 기대(M38): model이 description의 `Writable workspaces: web. Other workspaces fail with READ_ONLY.`를 보고 호출 전에 거절하거나, 호출하면 `write_file`·`edit_file`·`multi_edit_file` 모두 `READ_ONLY`. 어느 쪽이었는지 기록한다. `<fixture>/api`에 변화가 없다.
9. **`edit_file` revision 흐름**: "web의 `docs/plan.md`에서 `status: draft`를 `status: review`로 바꿔줘."
   - 기대: ChatGPT가 write 확인을 묻는다. 승인하면 성공하고 새 `revision` R2를 반환한다.
   - 이어서 "`TODO`를 `DONE`으로 바꿔줘. `replace_all`은 쓰지 마." → `EDIT_AMBIGUOUS`.
   - 이어서 "7단계의 revision R1을 `expected_revision`으로 그대로 써서 `owner: TBD`를 `owner: x`로 바꿔줘. 다시 읽지 마." → `REVISION_CONFLICT`. 파일은 바뀌지 않는다.
10. **`multi_edit_file`**: "web의 `docs/plan.md`를 다시 읽고, `multi_edit_file` 한 번으로 `owner: TBD`→`owner: web-team`, `TODO: a`→`DONE: a`를 적용해줘."
    - 기대: 성공, `replacements: 2`, `edit_replacements: [1, 1]`, 새 `revision`. 로컬에서 `cat <fixture>/web/docs/plan.md`로 두 곳이 바뀌었는지 본다.
    - 이어서 "`multi_edit_file`로 `DONE: a`→`DONE: aa`, `없는문자열`→`x`를 적용해줘." → `EDIT_NO_MATCH`, message가 `edits[1]`로 시작한다. 파일은 바뀌지 않는다(`read_file` revision이 직전 값과 같음).
11. **`write_file` 생성**: "web에 `docs/new.md`를 새로 만들어 `created`라고 써줘." 다음 "같은 파일을 revision 없이 다시 만들어줘."
    - 기대: 첫 호출 성공. 두 번째는 `REVISION_CONFLICT`(M15).

## 4. Audit 확인

```sh
A=<fixture>/audit/audit.jsonl
ls -l "$A"                                                    # -rw------- (0600)
jq -c '{tool, workspace, path, ok, error_code}' "$A"
jq -s 'map(select(.workspace == null)) | length' "$A"         # 0
grep -c 'dummy\|created\|web-team' "$A"                       # 0 (파일 내용 없음)
```

- 기대: 3절에서 서버까지 간 호출마다 1줄(8단계는 model이 호출한 경우만). SDK 입력 검증에서 거부된 호출(모르는 `workspace` 등)은 남지 않는다(M35).
- 모든 줄에 `workspace`가 있고, 4·8·9·10·11단계의 실패 줄에 `error_code`(`PATH_BLOCKED`, `READ_ONLY`, `EDIT_AMBIGUOUS`, `REVISION_CONFLICT`, `EDIT_NO_MATCH`)가 있다.
- 파일 내용, `.env` 값, host 절대 경로가 없다.

## 5. 정리

1. 검증용 `run`을 멈추고 평소 profile의 `run`을 다시 띄운다.
2. tool schema가 single mode로 돌아가므로 connector를 Refresh하고 새 대화를 시작한다.
3. `<fixture>`를 지운다. 검증용 profile은 `tunnel-client profiles` 명령으로 지우거나 다음 검증을 위해 남긴다.

## 6. 결과 기록

- implementation notes 6절에 날짜, 검증한 commit, `tunnel-client` 버전, 단계별 결과(특히 8단계에서 model이 거절했는지 호출했는지)를 한 항목으로 추가한다.
- 확인된 항목은 notes 7절 TODO에서 지운다. 기대와 다른 결과는 7절에 남기고, 결정이 필요하면 새 M 항목이나 ADR Amendment로 다룬다.
- 로컬 절대 경로와 tunnel ID는 기록하지 않는다.

## 부록 A. (선택) Responses API `tools/call`

credit이 있는 API 계정이 필요하다. 2026-09-23에는 `429 credit_balance_exhausted`로 model 추론이 실패해 `server/discover`·`tools/list`까지만 확인했다(notes 6절). 2절의 daemon을 띄운 채로 호출한다.

```sh
curl -s https://api.openai.com/v1/responses \
  -H "Authorization: Bearer $OPENAI_API_KEY" -H 'Content-Type: application/json' \
  -d '{
    "model": "<model>",
    "input": "private_workspace의 get_workspace_info를 호출하고, api workspace에서 needle을 search_text로 찾아줘.",
    "tools": [{
      "type": "mcp", "server_label": "private_workspace", "tunnel_id": "<tunnel-id>",
      "require_approval": {"never": {"tool_names": ["get_workspace_info", "list_directory", "read_file", "find_files", "search_text"]}}
    }]
  }'
```

- 기대: `output`에 `mcp_list_tools`(8개)와 `mcp_call` 항목이 있고 `mcp_call` output이 3절 2·6단계와 같다. 쓰기 tool을 요청하면 `mcp_approval_request`가 온다.
- audit에 호출이 기록된다. 결과는 notes 6절 "미검증" 항목을 갱신한다.

## 부록 B. (선택) container child를 `tunnel-client` 경유로

README의 container `--mcp-command` 예시를 검증용 profile에 넣고 2~4절을 반복한다. `WORKSPACE_ROOTS`면 repo마다 `-v <fixture>/api:/workspaces/api` 식으로 mount하고 `-e WORKSPACE_ROOTS=api=/workspaces/api,web=/workspaces/web -e WORKSPACE_READ_WRITE=web`을 준다. 추가로 `tunnel-client run`을 멈춘 뒤 `docker ps`에 container가 남지 않는지 확인한다.

## 부록 C. (선택) read-only Git tool (ADR-004)

`WORKSPACE_GIT=read-only`로 켠 Git tool 4개를 hosted 경로로 확인한다. `pnpm e2e:tunnel`의 git case는 `tunnel-client dev proxy`까지만 확인했다(notes 6절).

1. `api`를 repository로 만든다. `.env`가 history에 남도록 먼저 commit하고, 그 뒤 worktree를 하나 바꾼다.

   ```sh
   cd <fixture>/api && git init -q -b main && git add -A && git commit -qm initial
   printf 'export const marker = "needle2";\n' > src/app.ts
   ```

2. 2절 `--mcp-command`의 `env -u ...` 뒤에 `WORKSPACE_GIT=read-only`를 더해 profile을 다시 만든다. 띄우기 전에 같은 env로 `node <repo-root>/dist/index.js --check`를 실행해 마지막 줄이 `git: read-only (git <version> at <path>)`인지 본다.
3. tool 목록이 12개로 바뀌므로 connector를 Refresh하고 새 대화를 시작한다.
4. ChatGPT에 요청하고 결과를 확인한다.

   | # | 요청 | 기대 |
   |---|------|------|
   | 1 | "api workspace의 git status 보여줘" | `git_status`(`workspace: "api"`), `src/app.ts`가 worktree `M`. `.env`, `.gitignore` 대상은 없음 |
   | 2 | "api의 변경 diff 보여줘" | `git_diff`, patch에 `needle2` |
   | 3 | "api의 최근 commit과 그 commit 내용을 보여줘" | `git_log` 뒤 `git_show`, 파일 목록에 `.env` 없음, `API_TOKEN` 문자열 없음 |
   | 4 | "web workspace의 git log 보여줘" | `NOT_A_REPOSITORY` (web은 repository가 아님) |
   | 5 | "api에서 `HEAD:.env`를 git_show로 보여줘" | model이 거절하거나 `INVALID_REVISION` |

5. 4절처럼 audit을 확인한다. Git 호출 record에 `bytes_read`가 있고 파일 내용, rev 문자열, git stderr가 없어야 한다.
