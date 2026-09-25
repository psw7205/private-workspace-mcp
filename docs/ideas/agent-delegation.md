# 아이디어: 로컬 coding agent 위임

* Status: 아이디어 초안 (2026-09-25). 결정이 아니다. 채택하면 새 ADR로 옮긴다.

## 배경

지금 방향(PRD 17절)은 capability를 typed tool로 하나씩 직접 만드는 것이다. filesystem과 read-only Git은 거의 갖췄다. 하지만 PRD 16절 로드맵(shell, process session, 개발 도구, policy engine)까지 같은 방식으로 만들면 범위가 계속 커진다.

## 아이디어

머신에서 무언가를 실행하는 일은 로컬 coding agent(Claude Code, Codex)에 맡긴다. 이 서버는 MCP client(ChatGPT)가 그 agent에게 일을 시키고 대화할 수 있게 하는 얇은 중계층이 된다.

- **역할 분담**: 쓰기와 실행은 agent가 한다. 검증은 이 서버의 기존 typed read tool(`read_file`, `git_diff` 등)로 한다. agent가 "했다"고 보고한 내용은 검증 근거로 쓰지 않는다.
- **이 서버가 맡는 일**
  - job lifecycle: 시작, 상태 조회, 후속 지시, 취소
  - agent 실행 환경 강제: workspace 고정, sandbox 필수, env 제한, agent config 격리
  - audit
- **지원 범위**: Claude Code와 Codex를 같은 등급(0급)으로 지원한다. 같은 tool surface, 같은 보안 등급, 같은 contract test를 적용한다.
- **기존 tool**: filesystem tool은 더 고도화하지 않고 지금 상태로 동결한다. read tool은 검증 경로로 계속 쓴다.
- **기본값**: opt-in이고 기본은 꺼져 있다. ADR-004 Git tool과 같은 방식이다.

## 무엇이 바뀌나

- **제품 성격**: "작고 명시적인 capability"에서 "자연어로 받는 원격 실행"으로 바뀐다. PRD의 Phase 5(shell)를 사실상 먼저 당기는 결정이다.
- **보안 경계**: `PathGuard`에서 agent의 sandbox로 옮겨간다. 그래서 agent 선택 기준 1순위는 sandbox를 강제할 수 있는가이다.
- **문서 변경**: 보안 불변식 1·8과 PRD 16절 Phase 5~7에 Amendment가 필요하다.

## 먼저 풀어야 할 질문

- **긴 작업 처리**: hosted tool call timeout 안에 긴 작업을 어떻게 다루나? ChatGPT가 status tool을 스스로 부르나? 이 답에 따라 동기 호출로 갈지 비동기 job으로 갈지가 정해진다.
- **sandbox 동등성**: Claude Code를 headless로 돌릴 때 Codex의 OS sandbox만큼 제한할 수 있나? 안 되면 Codex를 먼저 낼지, 두 agent의 등급을 나눌지 정해야 한다.
- **config 격리와 인증**: 둘 다 home 아래에 있다. 사용자의 instruction, hook, plugin, MCP server를 격리하면서 agent 로그인은 유지할 수 있나?
- **연동 방식**: headless CLI stream, 공식 TypeScript SDK, ACP 중 무엇으로 붙이나? 방식에 따라 sandbox 옵션, session resume, 넘어가는 env가 달라진다.
- **tool 형태**: agent를 인자로 받는 공통 tool 한 세트로 할까, agent마다 따로 둘까?
- **agent의 git write**: agent에 commit 같은 git write를 허용할까? 기본은 불허 쪽이다.
- **Windows 지원 등급**: 어느 수준으로 지원할까?
- **승인 요청 처리**: sandbox 밖을 건드리는 요청은 모두 거부할까, MCP elicitation으로 사용자에게 넘길까?
- **prompt injection**: MCP client가 읽은 외부 내용이 agent의 셸 실행으로 이어진다. sandbox만으로 막는 것을 받아들일 수 있나?

## 다음 단계 (채택 시)

1. **Spike**: repo 코드는 바꾸지 않는다. 일회용 workspace와 읽기 전용 sandbox에서 두 agent를 hosted 경로에 붙여, 위 질문 중 긴 작업 처리·sandbox 동등성·config 격리와 인증을 먼저 확인한다.
2. **판단 지점**: spike 결과로 두 agent를 동시에 지원할지 정한다.
3. **ADR-009**: 연동 방식, tool 형태, 보안 등급을 확정한다.
