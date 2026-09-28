# Security Policy

Please report vulnerabilities privately through GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue, pull request, or discussion for a suspected vulnerability. Only the latest release is supported. The rest of this document is in Korean.

## 지원 버전

가장 최근 [GitHub Release](https://github.com/psw7205/private-workspace-mcp/releases/latest)만 보안 수정을 받는다. 이전 release에는 backport하지 않으므로, 보고 전에 최신 release에서 재현되는지 확인한다.

## 보고 방법

- repo의 **Security** 탭에서 **Report a vulnerability**를 눌러 비공개 advisory로 보고한다.
- public issue, PR, discussion에는 취약점 내용을 올리지 않는다.
- 보고에 담을 것: 영향받는 version(`--version` 출력), 환경 변수 설정(값 중 secret은 빼고), 재현 절차, 기대 동작과 실제 동작, 영향 범위.
- 수정과 release가 나올 때까지 공개하지 않기를 부탁한다. 수정 후 advisory를 공개하고, 원하면 보고자를 credit한다.

## 범위

설계상 방어 계층은 [`docs/security.md`](../docs/security.md)에 있다. 다음은 범위 안이다.

- **path confinement 우회**: `..`, symlink, 절대/drive/UNC 경로, Windows alias 등으로 workspace root 밖의 파일을 읽거나 쓰는 경우.
- **deny 우회**: `DEFAULT_DENY_PATTERNS`나 운영자가 추가한 deny pattern에 걸리는 파일(`.env`, key, credential 등)을 읽기, 목록, 검색, Git tool로 드러내는 경우.
- **host path 누출**: client에 가는 응답이나 error message에 host 절대 경로나 Node error message가 들어가는 경우.
- **Git runner hardening 우회**: `WORKSPACE_GIT=read-only`에서 hook, filter, pager, external diff, network, repo config 등을 통해 git child가 임의 명령을 실행하거나, 상속되면 안 되는 환경 변수를 받거나, 쓰기를 하는 경우.
- **write model 위반**: read-only 모드나 `WORKSPACE_READ_WRITE`에 없는 workspace에서 쓰기가 되거나, `expected_revision` 없이 기존 파일을 덮어쓰거나, 새 파일 생성이 기존 파일을 덮어쓰는 경우.

다음은 범위 밖이다.

- workspace 안에서 허용된 동작: read-write 모드에서 model이 prompt injection으로 파일을 고치는 것 자체(`docs/security.md`의 client 승인 절 참고).
- 운영자가 직접 넓힌 설정의 결과, OS 권한 경계 자체의 문제, `tunnel-client`나 MCP client 등 이 repo 밖 구성 요소의 취약점.
- `docs/implementation-notes.md` 3절에 수용한 잔여 위험으로 기록된 항목. 기록된 것보다 영향이 크다는 근거가 있으면 범위 안으로 본다.
