# npm 릴리스

Negotium은 하나의 저장소에서 12개 npm 패키지를 lockstep version으로 배포한다. 공식 구현은
`@negotium/*` scope에 있고, unscoped `negotium`은 `@negotium/cli`를 실행하는 실제 편의
패키지다. 이름만 차지하는 placeholder는 배포하지 않는다.

## 최초 1회 준비

1. npmjs.com에서 이메일이 인증된 계정으로 로그인하고 2FA를 활성화한다.
2. 프로필의 **Add an Organization**에서 `negotium` 조직을 만든다.
3. 공개 패키지만 사용하는 무료 플랜을 선택한다.
4. 로컬 계정을 확인한다.

```bash
npm login --auth-type=web
npm whoami
```

`@negotium/*`는 `negotium` 조직이 소유한다. unscoped `negotium`은 최초 게시를 실행한 npm
사용자 계정이 소유하므로, 릴리스 담당 계정 하나를 정해 계속 관리한다.

## 검증

```bash
bun install
bun run check
bun test
bun run release:check
bun run release:status
bun run release:dry-run
bun run release:smoke
```

특정 패키지만 확인할 수 있다.

```bash
bun scripts/release-packages.ts dry-run --only=@negotium/core
bun scripts/release-packages.ts status --from=@negotium/node
```

릴리스 스크립트는 다음을 강제한다.

- 모든 패키지는 같은 version을 사용한다.
- 내부 dependency는 먼저 배포되는 패키지만 가리킨다.
- `files` allowlist와 `publishConfig.access=public`이 있어야 한다.
- 실제 배포는 깨끗한 Git worktree에서만 가능하다.
- 동일 version이 npm에 있으면 재게시하지 않고 건너뛴다.
- `release:smoke`는 12개 tarball을 빈 임시 프로젝트에 설치하고 public import와 CLI를 실행한다.

## 최초 수동 배포

최초에는 npm에 패키지가 없어서 trusted publisher를 연결할 수 없다. 변경을 commit하고
dry-run 결과를 검토한 뒤 다음 명령으로 의존성 순서대로 게시한다.

```bash
bun run release:publish --confirm
```

순서는 다음과 같다.

1. `@negotium/adapter-sdk`
2. `@negotium/core`
3. `@negotium/mcp-host`
4. `@negotium/module-cron`
5. `@negotium/mcp`
6. `@negotium/node`
7. `@negotium/adapter-testkit`
8. `@negotium/adapter-terminal`
9. `@negotium/adapter-telegram`
10. `@negotium/adapter-otium`
11. `@negotium/cli`
12. `negotium`

중간에 인증이나 registry 반영 문제로 멈춰도 같은 명령을 다시 실행하면 게시된 version은
건너뛰고 나머지부터 계속한다. 필요한 경우 `--from=<package>`로 재개 지점을 지정한다.

## 배포 방식

현재 릴리스는 로컬에서만 실행한다. 저장소에는 npm publish용 GitHub Actions workflow나
장기 npm token을 두지 않는다. 게시 전 `npm whoami`로 계정을 확인하고, 위 검증 명령을 모두
통과한 깨끗한 worktree에서 `bun run release:publish --confirm`을 실행한다.

새 version을 배포할 때는 12개 package manifest의 version을 함께 변경하고 lockfile을
갱신한 뒤 check, test, dry-run, smoke, commit 순서로 진행한다.
