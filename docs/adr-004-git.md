# ADR-004 — Git Read-only Capability

* Status: Proposed
* Date: 2026-09-24
* Scope: PRD 16 Phase 4 (Git)의 read-only 부분

## 1. Context

agent가 코드 작업에서 가장 자주 원하는 맥락은 "지금 무엇이 바뀌었나", "이 변경은 언제 왜 들어왔나"다. 지금은 `.git`이 기본 deny(M3)라 filesystem tool로는 볼 수 없고, shell도 없다(ADR-001 15절). PRD 16 Phase 4는 Git을 arbitrary shell이 아니라 typed tool로 주고 read-only부터 시작한다고 정한다. ADR-001 21절은 Git capability를 이 ADR로 미뤘다.

Git을 붙이면 지금까지의 전제가 두 가지 깨진다.

* **process 실행**: system `git`을 쓰면 AGENTS.md 보안 불변식 8(process 실행은 ADR 필요)에 해당한다. git은 설정에 따라 다른 program을 실행한다(`core.fsmonitor`, `diff.external`, `diff.<drv>.textconv`, `filter.<drv>.clean`, `gpg.program` 등).
* **PathGuard 밖의 읽기**: 어떤 engine이든 `.git`과 worktree를 직접 읽는다. 불변식 1(모든 filesystem 접근은 `PathGuard`)을 문자 그대로 지킬 수 없다.

또 history는 deny 목록이 이름으로만 막던 내용을 다른 경로로 드러낸다. 과거에 commit된 `.env`, `secret.yaml`의 diff, 지금은 지운 파일의 내용이 그 예다.

## 2. Decision

system `git`을 shell 없이 spawn하는 read-only typed tool 4개를 opt-in으로 추가한다. 아래 hardening, repository 경계, deny 필터를 모두 적용한 경우에만 호출이 git까지 간다.

### 2.1 Tool

| tool | 입력 | 출력 |
|------|------|------|
| `git_status` | (없음) | 현재 branch, upstream과 다른지 여부(`--no-ahead-behind`, 개수는 세지 않음), 변경 entry 목록(`path`, `orig_path`, index/worktree 상태). untracked는 파일 단위 |
| `git_diff` | `base?`, `head?`, `staged?`, `path?` | 변경 파일 목록 + unified patch. `base`/`head`가 없으면 worktree↔index(`diff-files -p`), `staged`면 index↔`HEAD`(`diff-index --cached -p`), rev가 있으면 `diff-tree -r -p`. porcelain `git diff`는 쓰지 않는다 |
| `git_log` | `rev?`(기본 `HEAD`), `path?`, `max_count?`(기본 20, 최대 200) | commit 목록(`oid`, parent oid, author/committer 이름·email·시각, message). 서버가 고정한 `--format`만 쓰고 `%G*`(서명 검증, `gpg.program` 실행)는 넣지 않는다. 변경 파일 목록은 넣지 않는다 |
| `git_show` | `rev` | commit 1개의 metadata + first parent와의 파일 목록·patch(root commit은 빈 tree 기준). metadata는 pathspec 없이 `log -1 --no-walk`로, diff는 `diff-tree -r`(`<oid>^1 <oid>` 또는 `--root <oid>`)로 따로 얻는다. `git show <oid> -- <exclude>`는 commit이 denied 파일만 바꿨으면 header까지 통째로 사라진다(git 2.54.0에서 확인) |

모두 `workspace` 인자(ADR-008)를 받고 `runTool`로 감싼다. annotations는 `readOnlyHint: true`, `openWorldHint: false`다. `rev:path` 형태의 blob 조회, `git_branch`, write 계열은 5절로 미룬다.

### 2.2 Engine

`node:child_process.spawn`으로 system `git`을 실행한다. `shell: false`, `stdio: ['ignore', 'pipe', 'pipe']`, 인자는 배열로만 넘긴다. `execFile` 대신 `spawn`을 쓰는 이유는 stdout을 stream으로 읽어 byte 상한에서 끊고 `truncated`를 표시해야 하기 때문이다(`execFile`의 `maxBuffer`는 초과 시 결과를 버린다).

git 실행 파일은 startup에서 hardened env의 `PATH`로 한 번 찾아 절대 경로로 고정하고, 그 경로가 어떤 workspace root 안에도 없음을 `relativeInside`로 확인한다. Windows의 실행 파일 탐색은 cwd를 먼저 볼 수 있어서, cwd를 workspace root로 두고 `git`이라는 이름으로 실행하면 model이 쓴 `git.exe`가 실행될 수 있다. 필요한 option(`--attr-source` 등, 2.3절)의 지원 여부는 version 문자열 비교가 아니라 startup에서 2.3절 전역 인자 전체를 붙여 `--version`을 실행해 확인한다. 모르는 전역 option이면 git은 exit 129로 끝난다(git 2.54.0에서 확인). `--attr-source`가 들어온 정확한 version은 unresolved: 로컬 man page에 version 표기가 없음(2.40 전후로 기억).

### 2.3 실행 환경 hardening

env는 상속하지 않고 새로 만든다. `tunnel-client`가 넘긴 `CONTROL_PLANE_API_KEY`(implementation notes 3절), `GIT_*`, `SSH_*`, `HOME`, `XDG_CONFIG_HOME`은 child에 가지 않는다.

| env | 값 | 목적 |
|-----|----|------|
| `PATH` | 서버 env의 `PATH`에서 상대 경로 항목과 workspace root 안의 항목을 뺀 것 | filter 등이 찾는 program을 workspace 밖으로 한정 |
| `SystemRoot`, `windir` | 서버 env 값 (Windows만) | Git for Windows 동작에 필요 |
| `LC_ALL` | `C` | 오류 분류가 locale에 흔들리지 않게 |
| `GIT_DIR`, `GIT_WORK_TREE` | `<root>/.git`, `<root>` (canonical) | discovery를 쓰지 않고 repo를 고정. repo config의 `core.worktree`도 무시된다 |
| `GIT_CONFIG_NOSYSTEM` | `1` | system config 제외 |
| `GIT_CONFIG_GLOBAL` | `os.devNull` | `~/.gitconfig`, `$XDG_CONFIG_HOME/git/config` 제외 |
| `GIT_OPTIONAL_LOCKS` | `0` | `status`가 index를 다시 쓰지 않음(lock 경합 방지). porcelain `git diff`는 이 설정과 무관하게 index를 다시 쓰므로 diff는 plumbing만 쓴다 |
| `GIT_NO_LAZY_FETCH` | `1` | partial clone에서 누락 object를 promisor remote로 가져오지 않음. 이 때문에 network, `credential.helper`, `core.sshCommand`, `core.askPass`가 read 경로에 들어오지 않는다 |
| `GIT_NO_REPLACE_OBJECTS` | `1` | `refs/replace`로 history가 다르게 보이지 않게 |
| `GIT_TERMINAL_PROMPT` | `0` | prompt로 block되지 않게 |
| `GIT_PAGER` | `cat` | pager 미실행(stdout이 tty가 아니어도 명시) |

모든 호출에 붙이는 인자:

```text
git --no-pager --no-optional-locks --attr-source=HEAD
    -c core.fsmonitor=false -c protocol.allow=never -c color.ui=never
    -c core.quotePath=false -c diff.renames=false -c status.renames=false
    -c log.showSignature=false -c core.hooksPath=<os.devNull>
    -c core.attributesFile=<os.devNull>
    [-c filter.<drv>.clean= -c filter.<drv>.smudge= -c filter.<drv>.process=
     -c filter.<drv>.required=false  ... 2.4.1절에서 찾은 driver마다]
    <subcommand> ...
```

filter driver는 호출마다 읽은 resolved config(2.4.1절)에서 이름을 모아 모두 빈 값으로 덮어쓴다. 이 때문에 HEAD `.gitattributes`가 `filter=lfs` 같은 운영자 driver를 가리켜도 read 경로에서는 filter program이 실행되지 않는다. 대가로 stat 정보가 바뀐 LFS 파일은 clean 없이 비교되어 `status`에 modified로 보일 수 있다. 이름에 `=`나 control 문자가 있는 driver는 `-c`로 표현할 수 없으므로 fail closed한다.

subcommand별로 `--no-ext-diff --no-textconv --no-color --ignore-submodules=all`(diff 계열), `--no-show-signature --no-use-mailmap --encoding=UTF-8`(log/show), `--porcelain=v2 -z --branch --no-ahead-behind --untracked-files=all --ignore-submodules=all`(status)을 붙인다. workspace 안의 nested repo도 submodule처럼 들어가지 않는다. `--attr-source=HEAD`는 worktree `.gitattributes`를 읽지 않게 한다(`GIT_ATTR_SOURCE`와 같음). binary 파일은 `--binary`를 주지 않으므로 `Binary files ... differ` 한 줄로 나온다.

git 2.54.0(Apple Git-157)에서 확인한 것: repo config의 `filter.<drv>.clean`은 worktree `.gitattributes`가 가리키면 `git status`와 `git diff`에서 실행되고 `--attr-source=HEAD`면 실행되지 않는다. repo config의 `core.fsmonitor` hook은 `status`에서 실행되고 `-c core.fsmonitor=false`면 실행되지 않는다. `diff.<drv>.textconv`는 `git show`에서 기본으로 실행되고 `--no-textconv`면 실행되지 않는다. `diff.external`은 `--no-ext-diff`로 막힌다. `-c filter.<drv>.clean=`(및 `process=`)은 repo config의 driver를 무력화한다. stat만 바뀐 파일에서 hardened `status`, `diff-files`, `diff-index --cached`는 `.git/index`를 다시 쓰지 않고 porcelain `git diff`는 다시 쓴다. `diff-files -p`는 stat만 바뀐 파일을 patch에서 생략하지만 `diff-files --name-status`는 `M`으로 낸다. `$GIT_DIR/hooks` 방식의 `post-index-change` hook은 `-c core.hooksPath=/dev/null`로 막히지만, config 기반 hook(`hook.<name>.command` + `hook.<name>.event`)은 같은 override에서도 porcelain `git diff`에서 실행된다. 그래서 config hook은 2.4.1절에서 fail closed하고, index를 쓰는 명령은 쓰지 않는다. unborn repo에서도 `--attr-source=HEAD`는 실패하지 않는다. `env -i`(HOME 없음)에서도 `status`가 동작한다. 나머지 항목(`GIT_NO_LAZY_FETCH`, `log.showSignature`, `GIT_OPTIONAL_LOCKS`, protected configuration)은 `git help git`, `git help config`, `githooks(5)`의 설명에 근거한다.

alias는 builtin subcommand 이름을 덮어쓸 수 없으므로 고정 subcommand만 쓰는 한 영향이 없다.

### 2.4 Repository 경계

workspace root가 repository toplevel이고 `<root>/.git`이 실제 directory일 때만 허용한다. 호출마다 다음을 확인하고, 하나라도 어긋나면 `NOT_A_REPOSITORY`다.

1. Node에서 `lstat(<root>/.git)`이 directory다. symlink나 gitfile(`gitdir: ...`)이면 거부한다. 2.3절의 `GIT_DIR`은 gitfile을 따라가므로 이 검사를 git에 맡기지 않는다.
2. POSIX에서는 `.git`의 owner uid가 서버 process uid와 같다. 명시적 `GIT_DIR`에서 git의 `safe.directory` ownership 검사가 적용되는지는 unresolved: 다른 uid 소유 repo로 확인하지 못함. 그래서 같은 검사를 Node에서 한다.
3. `git rev-parse --git-dir --git-common-dir --show-toplevel`의 결과를 realpath로 풀어 각각 `<root>/.git`, `<root>/.git`, `<root>`와 같다(linked worktree의 `commondir` 차단).

workspace가 repo의 하위 directory인 구성은 지원하지 않는다. history, commit message, 다른 경로의 diff가 workspace 밖 파일을 드러내기 때문이다. `GIT_DIR`을 명시하고 discovery를 쓰지 않으므로 `GIT_CEILING_DIRECTORIES`는 필요 없다. submodule과 linked worktree도 지원하지 않는다.

#### 2.4.1 Repository config 검사

`.git/config`는 model이 쓸 수 없지만, 운영자가 둔 `include.path`/`includeIf.*.path`가 worktree 파일(예: `../.gitconfig`)을 가리키면 model이 쓸 수 있는 deny 밖 파일이 config가 된다. git 2.54.0에서 hardened 인자로도 이렇게 들어온 `filter.lfs.clean`이 HEAD `.gitattributes`의 `filter=lfs`를 통해 `status`와 `diff-files`에서 실행됐고, worktree를 가리키는 `core.attributesFile`은 `--attr-source=HEAD`를 우회했다. 그래서 2.4절 검사 뒤, 다른 git 명령 전에 호출마다 같은 env와 인자로 `git config --list --show-origin --show-scope -z`를 읽고 다음 중 하나면 `UNSAFE_GIT_CONFIG`로 거부한다.

* `include.path` 또는 `includeIf.*.path` 값이 `~`로 시작하거나, 그 entry가 나온 config 파일의 directory 기준으로 풀고 가장 가까운 존재하는 상위를 realpath한 결과가 어떤 workspace root 안이면서 `<root>/.git` 밖이다. include key 자체는 대상 파일이 없어도 목록에 나오므로(git 2.54.0에서 확인), 나중에 파일을 만드는 TOCTOU도 key 단계에서 막는다.
* entry의 origin 파일이 어떤 workspace root 안이면서 `<root>/.git` 밖이다.
* path 값을 받는 key(`core.attributesFile`, `core.excludesFile`, `mailmap.file`, `blame.ignoreRevsFile`, `diff.orderFile`, `commit.template`, `core.hooksPath`)가 같은 규칙으로 root 안 `.git` 밖을 가리킨다. `core.attributesFile`과 `core.hooksPath`는 `-c`로도 덮어쓴다.
* `hook.` 으로 시작하는 key가 하나라도 있다. `core.hooksPath` override로 막히지 않고, read tool에 hook이 필요할 이유가 없다.
* filter driver 이름이 `-c`로 표현할 수 없다(2.3절).

이 검사를 통과한 config에서 모은 filter driver 이름이 2.3절 override 목록이 된다. config 읽기와 본 명령 사이에 include 대상이 바뀌어도 include key가 root 밖을 가리키는 경우만 통과하므로 model이 그 대상을 쓸 수 없다.

### 2.5 입력 검증

* `path`: `normalizeRelativePath`와 `isDenied`(입력 경로 기준)를 통과해야 한다. 존재 여부는 보지 않는다(지운 파일의 history도 조회 대상). git에는 `--` 뒤에 `:(literal)<path>`로 넘겨 glob과 다른 magic이 해석되지 않게 한다. 전역 `--literal-pathspecs`는 2.6절의 exclude magic까지 끄므로(`git help git`) 쓰지 않는다.
* `rev`, `base`, `head`: `<base><suffix>` 형태만 받는다. `<base>`는 `HEAD`, 4~64자 hex OID, 또는 ref 이름(`^(?!-)[A-Za-z0-9._/-]{1,200}$`, `..` 금지)이고 `<suffix>`는 `(~[0-9]{1,4}|\^[0-9]?)*`이다. `:`(`HEAD:.env`, `:/regex`), 공백, range 문법(`base`/`head`로 나눠 받음), `@{`(reflog)는 pattern에서 빠진다. ref 이름은 `git rev-parse --verify --symbolic-full-name --end-of-options <base>`로 full ref로 바꿔 `refs/heads/`, `refs/tags/`, `refs/remotes/` 아래일 때만 받는다. `stash`(`refs/stash`)는 거부된다. `stash^3`은 `stash push -u`의 untracked 파일 commit이라 ignore·untracked 파일 내용을 드러낸다(git 2.54.0에서 확인). `refs/notes/*`, `refs/original/*`, `refs/replace/*`도 같은 이유로 받지 않는다. 그 뒤 `git rev-parse --verify --end-of-options <rev>^{commit}`으로 commit OID로 바꾸고, 이후 명령에는 hex OID만 넘긴다. 사용자 문자열이 option 위치에 가지 않으므로 `--output=` 같은 option injection이 구조적으로 막힌다.

### 2.6 Deny 적용

deny 목록(`DEFAULT_DENY_PATTERNS` + `WORKSPACE_EXTRA_DENY_PATTERNS`)은 두 겹으로 적용한다. 목록에 오른 파일은 M4처럼 존재 여부도 드러내지 않고 생략한다.

1. **static exclude**: 각 pattern `P`를 `:(exclude,icase,glob)**/P`와 `:(exclude,icase,glob)**/P/**`로 바꿔 `status`, `diff`, `show`에 붙인다. deny pattern은 `*`만 특수하고 segment 단위로 맞추므로 `glob` magic의 `*`(segment 안)과 의미가 같다. pattern의 `*` 외 glob 특수 문자(`?`, `[`, `\`)는 `\`로 escape한다. git 2.54.0에서 `:(literal)sub`, `:(exclude,icase,glob)**/secret*`, `:(exclude,literal)sub/other`를 함께 주면 exclude가 적용되고, `\[x\]` escape가 literal `[x]`에 맞는 것을 확인했다.
2. **in-process 필터**: rev 사이 diff와 `show`는 먼저 `diff-tree --name-status -z`로, worktree↔index와 staged diff는 `status --porcelain=v2 -z` entry로 파일 목록을 받아 `isDenied`로 검사한다(rename detection은 끄지만 rename 표기가 오면 두 경로 모두). `diff-files --name-status`는 stat만 바뀐 파일을 변경으로 내므로 목록으로 쓰지 않는다. 걸린 파일이 있으면 두 번째 `-p` 실행에 `:(exclude,literal)<path>`로 추가한다. 두 실행 사이에 worktree가 바뀌어도 static exclude는 그대로 적용된다. `status`는 porcelain v2 entry의 `path`와 `orig_path`를 검사한다. patch text의 `diff --git` header를 파싱하지 않는다.

`git_log`에는 static exclude를 쓰지 않는다. log의 pathspec은 출력 필터가 아니라 commit 선택(history simplification)을 바꾼다. log는 파일 목록을 주지 않으므로 필터할 경로가 없다. commit message와 author는 그대로 나간다.

두 겹 모두 경로 이름 기준이다. `config.json`에 복사된 secret처럼 이름이 deny에 걸리지 않는 내용은 `read_file`과 마찬가지로 막지 못한다.

### 2.7 자원 제한

* **종료**: POSIX는 `detached: true`로 child마다 process group을 만들고, 끝낼 때는 항상 `process.kill(-pid, 'SIGKILL')`로 group 전체를 죽인다. 대상은 `runTool` `AbortSignal`(M24) timeout, 출력 상한 도달, 서버 종료(stdin EOF, `SIGTERM`/`SIGINT` 처리 경로)다. 서버는 살아 있는 git group을 집합으로 들고 종료 경로에서 모두 죽인다. 서버가 `SIGKILL`로 죽으면 group이 고아로 남을 수 있다. git은 stdout pipe가 닫혀 다음 write에서 `SIGPIPE`로 끝나지만, 쓰지 않고 도는 작업(큰 repo의 status scan)은 끝날 때까지 남는다(6절 잔여 위험).
* **출력 상한**: stdout을 `WORKSPACE_MAX_READ_BYTES`까지 읽고 넘으면 group을 끝내고 `truncated: true`로 돌려준다. patch는 마지막 불완전한 파일 section을 버린다. stderr는 64 KiB까지만 모아 오류 분류에만 쓴다.
* **log**: `-n <max_count>`. `max_count`는 1~200.
* **동시성**: process당 git child를 2개로 제한하고 나머지는 대기한다. 대기 시간도 timeout에 포함된다. `tunnel-client` 기본 동시 요청 수(10)만큼 git이 뜨지 않게 한다.

### 2.8 오류와 audit

stderr와 exit 메시지는 client에 보내지 않는다(불변식 4). 새 error code:

| code | 조건 |
|------|------|
| `NOT_A_REPOSITORY` | 2.4절 검사 실패 |
| `UNSAFE_GIT_CONFIG` | 2.4.1절 config 검사 실패. message는 고정 문구이고 key 이름도 넣지 않는다(audit `error_detail`에만 key 이름) |
| `INVALID_REVISION` | 2.5절 pattern 불일치, 허용 밖 ref namespace, 또는 `rev-parse --verify` 실패 |
| `GIT_FAILED` | 그 밖의 비정상 종료. message는 고정 문구 |

path 오류는 기존 `INVALID_PATH`, `PATH_OUTSIDE_WORKSPACE`, `PATH_BLOCKED`를 쓴다. audit record는 기존 필드(`tool`, `workspace`, `path`, `ok`, `error_code`, `duration_ms`, `bytes_read`=읽은 stdout bytes)에 `truncated`를 더한다. `GIT_FAILED`면 `error_detail`에 `exit:<n>` 또는 `signal:<name>`만 남긴다. stderr, commit message, diff 내용, rev 문자열은 남기지 않는다(불변식 6).

### 2.9 활성화, mode, multi-workspace

* `WORKSPACE_GIT=read-only`일 때만 tool 4개를 등록한다. 기본은 꺼짐이다. 켜져 있는데 git이 없거나 2.2절 option 확인에 실패하면 startup 실패(M11 fail closed). 조용히 빠지면 운영자가 설정 오류를 모른다.
* git은 host 속성이라 등록 여부는 process 단위다. workspace가 repo인지는 호출 시점에 판단하므로 multi mode에서 repo가 아닌 workspace는 `NOT_A_REPOSITORY`를 받는다.
* `WORKSPACE_MODE`와 무관하게 read-only 모드에서도 동작한다. `get_workspace_info`에 `git: boolean`을 더한다.

### 2.10 Windows

Git for Windows를 전제로 한다. 경로 출력은 git이 `/`로 주므로 변환하지 않는다. system config를 끄면 Git for Windows가 system에 두는 `core.autocrlf=true`가 빠져 `status`가 운영자의 git과 다르게 보일 수 있다. 필요하면 repo config에 둔다. 다음은 unresolved: Windows host 없음. Accept 전에 `windows-latest` CI에서 확인한다.

* `os.devNull`(`\\.\nul`)을 `GIT_CONFIG_GLOBAL`, `core.hooksPath`, `core.attributesFile` 값으로 받는지.
* process group kill 대신 무엇으로 손자 process를 끝낼지(Job Object 등).
* `.git` alias와 deny의 관계. `.git.`, `.git::$DATA` 같은 이름은 M12 문법 검사가 모든 OS에서 거부하지만, 8.3 short name(`GIT~1`)은 문법상 통과한다. `write_file`로 `GIT~1/hooks/...`나 `GIT~1/config`에 쓰는 것이 canonical 경로 deny(realpath가 long name을 돌려주는지)에 걸리는지 확인하지 못했다. `.git` 쓰기는 사실상 코드 실행이므로 CI test plan에 넣는다. 이 항목은 Git tool과 무관하게 현재 filesystem tool에도 해당한다.

### 2.11 보안 불변식과의 관계

불변식 1은 서버 코드의 filesystem 접근에 대한 규칙이다. git child는 그 밖에서 `.git`과 worktree를 읽는다. 대신 다음 사슬이 같은 보장을 만든다.

1. root는 startup에서 `PathGuard`와 같은 검사로 고정된 canonical 경로다.
2. 호출마다 2.4절로 repo가 root 자신임을 확인하고, 2.4.1절로 config가 model이 쓸 수 있는 파일을 끌어오지 않음을 확인한다.
3. 입력 경로는 `normalizeRelativePath`/`isDenied`를, rev는 2.5절을 통과한다.
4. 출력은 같은 `DenyMatcher`로 2.6절 필터를 거친다.
5. git은 tracked symlink를 따라가지 않고 link 문자열만 다루므로 worktree symlink로 root 밖을 읽지 않는다. 남는 우회(`objects/info/alternates`)는 운영자가 쓴 `.git` 안에 있다.
6. 최종 경계는 그대로 OS 권한(ADR-001 11절)이다.

Accept 시 AGENTS.md를 다음처럼 고친다(이 ADR에서는 고치지 않는다).

* 불변식 1 끝에 "예외: ADR-004 Git tool의 git child는 `src/git/` runner가 2.3~2.6절(2.4.1절 포함)을 적용한 경우에만 실행한다."
* 불변식 8의 "shell, Git, process 실행 tool은 별도 ADR 없이 추가하지 않는다"에 "Git read-only tool은 ADR-004를 따른다"를 붙인다.

### 2.12 Accept 조건

* 2.3~2.6절 각 항목에 red-first test.
  * repo config의 filter(HEAD attributes 경유 포함)/fsmonitor/textconv/external diff/`$GIT_DIR/hooks` hook이 어느 tool에서도 실행되지 않음.
  * `include.path=../.gitconfig`(대상 있음·없음 둘 다), `includeIf.*.path`, worktree를 가리키는 `core.attributesFile`·`core.excludesFile`·`mailmap.file`, `hook.<name>.command`가 있으면 `UNSAFE_GIT_CONFIG`이고 그 program이 실행되지 않음.
  * 모든 tool 호출 전후로 `.git/index`의 bytes와 mtime이 같음(stat만 바뀐 파일 포함).
  * gitfile·하위 directory·symlink `.git` 거부, `HEAD:.env`·`--output=x`·`stash`·`stash^3`·`refs/notes/commits` 거부.
  * 과거 commit의 `.env`·`secret.yaml`이 status/diff/show에 없음, host 경로 비노출.
  * timeout과 출력 상한에서 filter 대신 넣은 느린 program을 포함한 process group 전체가 종료됨(POSIX).
* `windows-latest` CI 통과와 2.10절 unresolved 해소.
* PRD 13 error 표와 implementation notes에 M 항목 추가.

## 3. 이유

* **system git이 정답을 준다.** status의 racy-git 처리, clean filter 반영, reftable·SHA-256·sparse/split index, partial clone은 git만 끝까지 맞춘다. pure-JS 구현이 이런 repo를 잘못 읽으면 기능 누락이 아니라 틀린 답을 준다.
* **bundle과 supply chain이 늘지 않는다.** M29 단일 파일 bundle에 dependency와 license가 추가되지 않는다. git은 운영자가 이미 쓰는 binary다.
* **config 실행 surface는 닫을 수 있다.** "`.git`은 deny라 model이 config를 쓸 수 없다"는 전제만으로는 부족하다. 운영자 `.git/config`의 include나 path 값 key가 worktree 파일을 가리키면 model이 쓴 파일이 config나 attributes가 된다(2.4.1절에서 확인). 그래서 둘을 함께 쓴다. (1) resolved config를 호출마다 읽어 model이 쓸 수 있는 파일을 끌어오면 fail closed한다. (2) config가 정할 수 있는 실행 경로 중 알려진 것(filter, fsmonitor, hooks, textconv, external diff, pager, 서명 검증, network)은 config 내용과 무관하게 인자·env로 끈다. 그러면 남는 입력은 운영자가 쓴 `.git` 안과 root 밖 파일뿐이다.
* **opt-in으로 둔다.** history는 deny 이름에 걸리지 않는 과거 파일(지운 설정, 옛 secret)을 드러낸다. 업그레이드만으로 노출 범위가 넓어지지 않게 한다.
* **경계를 좁게 잡는다.** 하위 directory, gitfile, submodule을 허용하면 path 필터로 막을 수 없는 metadata(commit message, 다른 경로)가 새어 나간다. 필요해지면 좁은 규칙부터 넓힌다.

## 4. Alternatives Considered

* **isomorphic-git 등 pure-JS**: process 실행과 config 실행 surface가 아예 없다는 점이 가장 큰 장점이다. 그러나 patch 생성 엔진이 없어 diff를 직접 구현해야 하고, 새 repo 형식(reftable, SHA-256, sparse index)과 clean filter를 따르지 않아 틀린 status를 줄 수 있다. 큰 repo의 hashing이 event loop를 오래 잡고(M20과 같은 문제), bundle과 license 목록이 커진다. `.git`을 읽는 것은 같아서 불변식 1 예외는 어차피 필요하다.
* **libgit2 binding(nodegit 등)**: native addon이라 M29 단일 파일 bundle과 맞지 않고 platform별 build가 필요하다.
* **`execFile` + `maxBuffer`**: 상한을 넘으면 결과 전체를 버려 `truncated` 응답을 만들 수 없다.
* **`GIT_CEILING_DIRECTORIES`로 discovery 제한**: discovery를 허용하는 한 gitfile과 상위 repo 판단이 git에 남는다. `GIT_DIR` 명시와 Node 측 `lstat`이 더 엄격하다.
* **git이 없으면 tool 미등록(자동 감지)**: 설정 없이 노출 범위가 host 상태에 따라 바뀐다. opt-in + fail closed가 더 예측 가능하다.
* **patch 출력의 `diff --git` header 파싱으로 deny 필터**: quote된 경로와 rename 표기 파싱이 취약하다. `--name-status -z` 2단계가 더 단순하다.

## 5. Deferred

* write 계열(`add`, `commit`, `branch create`, `checkout`)과 고위험 operation(PRD 16 Phase 4). model이 `.gitattributes`를 commit할 수 있게 되면 2.3절의 `--attr-source=HEAD` 근거가 사라지므로 write ADR에서 다시 다룬다.
* `git_branch`(목록), `git_blame`, `rev:path` blob 조회
* 하위 directory workspace, submodule, linked worktree 지원
* rename/copy detection, ahead/behind 개수
* LFS 등 filter가 필요한 파일의 정확한 status(지금은 filter를 끄므로 stat만 바뀐 파일이 modified로 보일 수 있음)
* `hook.*` key가 있는 repo 지원(지금은 fail closed)

## 6. Consequences

### Positive

* agent가 shell 없이 변경 내역과 history를 본다. 모든 tool이 read-only라 기존 mode 규칙을 바꾸지 않는다.
* 실행 인자와 env가 고정 목록이라 audit과 review가 쉽다.

### Negative

* 새 dependency는 없지만 host의 git 버전과 설정에 따라 동작이 달라진다(`--attr-source`를 지원하는 git 필요, Windows `autocrlf`).
* linked worktree(`.git`이 gitfile)에서는 쓸 수 없다. worktree로 작업하는 운영자는 main checkout을 root로 둬야 한다.
* worktree `.gitattributes`를 무시하므로 commit 전 attribute 변경은 status/diff에 반영되지 않는다.
* history는 현재 파일 이름 기준 deny로 막지 못하는 내용을 드러낸다. opt-in과 경계 규칙으로 범위를 줄일 뿐 없애지 않는다.
* worktree 안을 include하는 repo, `hook.*`을 쓰는 repo에서는 git tool이 `UNSAFE_GIT_CONFIG`로 동작하지 않는다.
* 호출마다 `git config --list`와 `rev-parse`가 추가로 돌아 child가 2~4개 뜬다.
* error code 4개와 env 1개가 늘어 PRD 13과 설정 표를 고쳐야 한다.

### 잔여 위험

* **열거하지 못한 config 실행 경로**: 2.3절은 알려진 실행 key를 끄는 denylist다. 이후 git version이 read 경로에 새 config 기반 program 실행을 넣으면 운영자 `.git/config`(root 밖 include 포함)의 그 값이 실행된다. 2.2절 startup option 확인은 이를 잡지 못한다. git version을 올릴 때 이 ADR의 목록을 다시 본다.
* **history 노출**: 이름 기준 deny는 rename된 secret, deny에 없는 이름의 과거 파일, commit message를 막지 못한다. 알려진 OID로 HEAD history 밖 commit(예: stash의 untracked commit)을 직접 지정하는 것도 막지 않는다. OID를 알 수단은 주지 않지만 추측 불가능성에 기댄다.
* **고아 process와 object 경계**: 서버가 `SIGKILL`로 죽으면 git process group이 남을 수 있다(2.7절). `objects/info/alternates`가 root 밖 object store를 가리키면 그 object도 읽힌다.
* 명시적 `GIT_DIR`에서 git 자체의 ownership 검사 여부는 unresolved다(2.4절). Node uid 검사로 대신하지만 Windows에는 해당 검사가 없다. Windows `.git` alias(`GIT~1`)와 deny의 관계도 unresolved다(2.10절).
