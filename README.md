# Nori AI 공통 연동 1.0.0

연결 작업은 아래 네 가지입니다. Spring MVC·Spring Security를 사용하는 **Spring Boot 4.0·Java 21** 앱이 대상입니다. MES·HRM은 Boot 4.0으로 올린 뒤 연결해야 합니다. 두 중립 예제는 헤더·쿠키 전달 계약을 확인하며 MES·HRM의 실제 인증·적용을 증명하지 않습니다.

## 1. backend: 의존·설정·사용자 해석·업무 처리기

발행 좌표는 `com.nori.ai:ai-integration-spring-boot-starter:1.0.0`입니다.

```kotlin
implementation("com.nori.ai:ai-integration-spring-boot-starter:1.0.0")
```

GitLab Maven 프로젝트 번호는 **51**입니다. 기존 Nori 공통 settings 규칙을 쓰는 시스템은 `gradle.properties`의 `gitlabPackageProjectIds` 목록에 51을 추가합니다. settings나 leaf 모듈에 저장소를 추가하지 않습니다. 저장소는 `GITLAB_BASE_URL`(TC CI: `https://gitlab.noricloud.org`) 아래 `/api/v4/projects/51/packages/maven`입니다. CI는 `CI_JOB_TOKEN`을 `Job-Token` 헤더로 사용합니다. 로컬은 CI_JOB_TOKEN이 없을 때 `gitlabToken` 또는 `GITLAB_TOKEN`을 `Private-Token` 헤더로 전달하고 값을 파일에 저장하지 않습니다. 로컬 TC 소비 검증은 `-PuseLocalMaven`입니다. 프로젝트 51의 패키지 발행과 소비 CI job token 수신 허용 설정은 설치 담당자의 별도 작업입니다.

다른 Gradle 앱은 자체 저장소 정책 안에서 같은 프로젝트 Maven URL·헤더 인증을 등록합니다. 두 로컬 예제는 `com.nori.ai` 그룹으로 제한한 mavenLocal에서 실제 jar를 해석하며 공통 소스 project에 의존하지 않습니다.

`nori.ai.integration`의 키는 다음이 전부입니다. 활성 설정에서는 읽기 실패·알 수 없는 키·중복 키·빈 필수값을 기동 오류로 처리합니다. 자격 파일은 UTF-8이며 기동 후 자동 갱신하지 않습니다. 모든 인스턴스는 같은 시스템 설정·권한 표·키를 사용해야 합니다.

| 키 | 필수·기본값·허용값 |
|---|---|
| enabled | 기본 `false`. 활성화할 때 `true` |
| browser-credential | 기본 `COOKIE`, `COOKIE`·`HEADER`만 허용. 쿠키로 로그인 자격이 도달하면 COOKIE. 로그인 자격이 헤더로만 도달하고 resolver가 쿠키를 읽지 않을 때 HEADER |
| system-id | 활성 시 필수. `[A-Za-z0-9][A-Za-z0-9_-]{0,63}` |
| issuer | 활성 시 필수. 비어 있지 않은 1~128자 |
| gateway-base-url | 활성 시 필수. http·https 절대 주소. path(끝 `/` 포함)·사용자 정보·query·fragment 금지. 실제 주소는 설치 입력 |
| service-token-file | 활성 시 필수. 앞뒤 공백·개행은 `String.strip()`으로 제거. 이후 빈 값·내부 공백(`\s`) 금지 |
| actor-private-jwk-file | 활성 시 필수. kid가 있는 ES256·P-256 개인 JWK 한 개. 공개·개인키 대응 필수 |
| gateway-token-file | tools가 있으면 필수. tools=[]이면 생략 가능하며 생략 시 내부 요청은 401 SERVICE_AUTH_INVALID·DENIED. 토큰 파일 형식은 service-token-file과 같음 |
| delegation-key-file | 활성 시 필수. 정규 Base64url 무패딩으로 인코딩한 32바이트 키 |
| permission-codes | 활성 시 필수. 중복 없는 1~256개, 각 `[A-Z0-9_]{1,64}` |
| review-permission | 활성 시 필수. permission-codes에 포함하고 Gateway reviewPermission과 같음 |
| tools | 기본 `[]`. 항목은 `id`·`required-permissions`만 허용. id는 `[A-Za-z0-9_.-]{1,128}`, 유일해야 함. required-permissions는 중복 없이 permission-codes에 포함된 코드 배열(빈 배열 허용) |

네 자격 파일의 대응은 다음과 같습니다. 파일 본문·키·자격은 소스·문서·로그에 넣지 않습니다.

| backend 파일 | Gateway 쪽 대응 |
|---|---|
| service-token-file | 토큰 원문의 소문자 SHA-256(64자리)을 담은 serviceTokenSha256File |
| actor-private-jwk-file | 같은 kid의 공개 JWK를 공개 JWKS 집합으로 담은 actorJwksFile |
| gateway-token-file | Gateway가 backend를 부를 때 쓰는 gatewayTokenFile과 같은 Bearer 토큰 |
| delegation-key-file | Gateway는 키를 받지 않음. jar 인스턴스끼리 공유하며 Gateway는 dlg를 불투명 위임으로 전달 |

활성 servlet 앱에는 공통 jar **밖의 업무용 SecurityFilterChain Bean**이 있어야 합니다. 없으면 Boot 기본 체인을 대체해 업무 경로를 열지 않도록 기동에 실패합니다. 공통 체인은 `/api/ai/**`와 `/internal/ai/v1/query`만 담당합니다. 업무 인증·CSRF·URL 권한표는 시스템이 유지합니다.

`AiRequestIdentityResolver` Bean은 정확히 하나만 등록합니다. 기존 로그인 자격이 backend에 실제 도달하는지 확인한 뒤 시스템의 정식 검증 경로로 해석합니다. 브라우저가 보낸 사용자·권한은 신뢰하지 않습니다.

```java
@Bean
AiRequestIdentityResolver aiIdentityResolver(SystemLoginService login) {
    return request -> {
        var user = login.currentUser(request);
        if (user == null) return new AiRequestIdentity(false, null, Set.of());
        return new AiRequestIdentity(true, user.subject(), user.currentAiPermissions());
    };
}
```

위 `SystemLoginService`는 각 시스템이 구현하는 개념 예시이며 공통 jar API가 아닙니다. 실제 컴파일 가능한 구현은 `examples/*-app/src/main/java/example/`에 있습니다. loggedIn=true의 subject는 `[A-Za-z0-9_-]{1,64}`, permissionCodes는 null이 아닌 현재 권한 집합입니다. 빈 권한도 로그인 성공입니다. 표시 이름·이메일을 임의로 subject로 변환하지 않습니다. loggedIn=false이면 subject=null·빈 권한이어야 합니다. 자격 없음·만료는 미로그인, 인증 저장소 장애는 예외로 전달합니다. jar는 매 요청 현재 권한과 permission-codes의 교집합을 사용합니다. 반환 계약 위반은 500 AUTH_RESULT_INVALID, 해석 예외는 503 AUTH_UNAVAILABLE, 서명 실패는 500 SIGNING_FAILED이며 Gateway로 보내지 않습니다.

도구별 `AiToolRegistration.of(toolId, handler)` Bean을 등록합니다. 설정 tools와 정확히 일대일이어야 합니다. 처리기의 사용자별 데이터 범위 판단은 시스템 담당자가 구현합니다. 도구 설명·inputSchema·outputSchema·timeoutMs는 Gateway가 정본이며 backend 설정에 복제하지 않습니다.

```java
@Bean
AiToolRegistration recordRead() {
    return AiToolRegistration.of("demo.record.read", call -> new AiToolResult(
        AiToolResult.Status.SUCCESS,
        List.of(new AiToolItem("demo:record:1", "중립 업무 자료", Map.of("recordId", "1"), null)),
        List.of(), List.of(), new AiToolResult.RetentionMeta(List.of(), List.of())));
}
```

`call`에는 검증한 systemId·jobId·toolId·subject·permissionCodes·arguments·targets·deadline·observedAt이 들어옵니다. targets는 참고 정보이며 거절 사유로 삼지 않습니다. 전체 결과를 자기 정렬 순서(시간 자료는 최신순)로 반환합니다. jar가 외피와 절삭을 소유합니다. missingFields·missingRanges는 각각 99개 이하이며 원천 장애를 정상 0건으로 숨기지 않습니다. 시스템별 위임 저장소·권한 변경 hook·프록시 Controller·별도 내부 도구 라우트는 만들지 않습니다.

로컬 예제의 순서는 **로컬 jar 발행 → 예제 빌드 → 브라우저 시험**입니다. 기존 로컬 jar가 유효하면 첫 명령을 반복할 필요가 없습니다. 이 명령들은 설치·개발 실행 안내이며 원격 발행을 하지 않습니다.

```powershell
# 저장소 루트, Java 21·Node 22.12 이상(Node 22 계열)·npm 필요
.\gradlew.bat :backend:ai-integration-spring-boot-starter:publishToMavenLocal --no-daemon
.\gradlew.bat :examples:cookie-app:build :examples:header-app:build --no-daemon
# 각 task에 옵션을 붙여 발행 좌표 해석을 확인
.\gradlew.bat :examples:cookie-app:dependencyInsight --dependency com.nori.ai:ai-integration-spring-boot-starter --configuration runtimeClasspath :examples:header-app:dependencyInsight --dependency com.nori.ai:ai-integration-spring-boot-starter --configuration runtimeClasspath --no-daemon
```

Java 소비 시험은 실행 때 가짜 자격을 만들고 로컬 HTTP Gateway 대역의 서비스 Bearer·ES256 검증 및 내부 처리기 호출을 확인한 뒤 자원·자격을 정리합니다. 운영 자격은 사용하지 않습니다.

## 2. front: 스크립트와 태그 하나

```html
<script defer src="/api/ai/assets/widget.js"></script>
<nori-ai-widget></nori-ai-widget>
```

스크립트는 자체 React를 포함한 단일 파일입니다. 호스트 React·라우터·store·CSS를 가져오지 않습니다. TC·WM은 기본 `/api/ai`와 로그인 쿠키만 사용하므로 태그에 api-base·requestHeaders를 설정하지 않습니다. fetch는 `credentials=same-origin`입니다. COOKIE는 session의 CSRF를 POST·PUT·DELETE의 X-Nori-AI-CSRF로 보내며 HEADER는 session.csrf=null입니다.

헤더 로그인 시스템은 같은 출처 경로의 `api-base`와 JS 속성 `requestHeaders`를 설정합니다. 경로는 `/`로 시작하고 `//`·`..`·query·fragment·끝 `/`가 없어야 합니다. 잘못된 값은 `/api/ai`로 돌아갑니다. 앞단은 `{api-base}/**`를 backend `/api/ai/**`로 바꿉니다. 함수는 매 backend 요청마다 현재 자격을 읽어 문자열 헤더 객체(또는 Promise)를 반환하며 위젯은 값을 저장하지 않습니다. React 18에서는 ref로 JS 속성을 넣습니다.

```jsx
const widget = useRef(null)
useEffect(() => {
  const element = widget.current
  element.requestHeaders = () => ({ Authorization: `Bearer ${readCurrentLoginToken()}` })
  return () => { element.requestHeaders = undefined }
}, [])
return <nori-ai-widget ref={widget} api-base="/prefix/api/ai" />
```

`readCurrentLoginToken()`은 호스트의 기존 로그인 저장소 읽기로 연결합니다. MES는 localStorage `authToken`, HRM은 `auth-storage`의 token을 Authorization으로 보내는 기존 방식을 사용하되 실제 적용은 별도 작업입니다. Accept·Content-Type·Cookie·Host·Idempotency-Key·Last-Event-ID·X-Nori-AI-CSRF·X-Actor-Assertion·X-Request-Id는 대소문자와 관계없이 무시합니다. 함수 예외·비객체·비문자열 값은 요청을 보내지 않고 "로그인이 필요합니다."를 표시합니다.

script는 requestHeaders를 사용할 수 없으므로 **자산 경로만 로그인 없이 읽혀야 합니다**. 모든 요청에 토큰을 요구하는 앞단은 MES api-gateway의 `/sfapp/api/ai/assets/**`처럼 자산 전용 무인증 예외 route를 둡니다. API의 토큰 검사는 유지합니다. 중립 header 예제의 `proxy.mjs`는 `/prefix/api/ai/**`를 `/api/ai/**`로 바꾸며 assets만 예외로 두고 나머지 AI API에 토큰을 요구합니다. 직접 `/api/**`·`/internal/**` 진입은 앞단에서 거절합니다.

배치는 position=`bottom-right`(기본)·`bottom-left`와 CSS 변수 `--nori-ai-width`(440px), `--nori-ai-height`(600px), `--nori-ai-accent`(#2563eb)만 조정합니다. 크기는 양의 CSS 길이이며 화면 안으로 제한합니다. 기본 모서리 여백은 24px, 좁은 화면은 16px이며 safe-area를 반영합니다. 오류는 기본값입니다. 왼쪽 목록은 넓은 화면에서 224px 확장하고 좁은 화면에서는 키보드로 닫을 수 있는 서랍으로 엽니다. 내부 부품 교체·렌더러 주입·새 메뉴·라우트는 없습니다.

X는 현재 대화·초안·진행 중 질문을 유지한 채 최소화합니다. 재열기와 창 focus에서는 세션 확인이 끝날 때까지 보호 내용을 숨기며 사용자 변경·인증 실패·권한 회수 시 접근할 수 없는 내용을 비웁니다. 태그를 DOM에서 제거하면 요청·스트림·이벤트와 React 화면을 해제합니다. 대화/검토 전환은 `/session`의 `canReview`가 허용한 사용자에게만 보이며 실제 검토 권한은 서버가 계속 검사합니다. 호스트의 `.dark` 클래스 또는 OS 다크 테마를 따릅니다.

```powershell
# front 디렉터리. 브라우저 설치가 필요한 환경에서는 npx playwright install chromium을 먼저 수행
npm ci
npm run build
npm run test:e2e -- tests/e2e/widget-consumers.spec.ts
```

브라우저 시험은 두 bootJar를 직접 띄우고 임시 포트·가짜 자격·로컬 Gateway 대역·header 앞단을 소유합니다. COOKIE 호스트는 React 19.2.8·초록 전역 CSS, HEADER 호스트는 React/React DOM 18.3.1·빨강 전역 CSS이며 ref 연결과 위젯 Shadow DOM 격리를 확인합니다. 끝나면 브라우저·앱·대역·임시 자격을 정리합니다. 수동 실행 시 `EXAMPLE_GATEWAY_URL`(로컬 대역), 네 `EXAMPLE_*_FILE`과 `EXAMPLE_LOGIN_PASSWORD` 또는 `EXAMPLE_LOGIN_TOKEN`을 외부 환경으로 공급합니다. cookie 앱은 기본 18081, header backend는 18082입니다. header 앞단은 `EXAMPLE_BACKEND_URL=http://127.0.0.1:18082`, `EXAMPLE_FRONT_PORT=18083`, 같은 `EXAMPLE_LOGIN_TOKEN`을 공급하고 `node examples/header-app/proxy.mjs`로 실행합니다. 자격 값을 소스·명령 인자에 넣지 않습니다.

네 파일 환경변수는 `EXAMPLE_SERVICE_TOKEN_FILE`, `EXAMPLE_ACTOR_JWK_FILE`, `EXAMPLE_GATEWAY_TOKEN_FILE`, `EXAMPLE_DELEGATION_KEY_FILE`입니다. 환경 입력을 준비한 뒤 저장소 루트에서 `java -jar examples/cookie-app/build/libs/cookie-app-1.0.0.jar` 또는 `java -jar examples/header-app/build/libs/header-app-1.0.0.jar`를 실행합니다. cookie 화면의 "쿠키 로그인"은 사용자 `reader_1`과 외부 공급 비밀번호를 사용하며, header 화면의 "예제 로그인 토큰"에는 외부 공급 테스트 토큰을 입력합니다. 수동 실행한 앱·앞단·대역도 확인 후 종료합니다.

## 3. Gateway: 시스템 항목과 자격 배치

실제 연결은 **006 구현 완료 뒤**, 설치 담당자가 확인한 주소·자격으로 수행합니다. 이 저장소는 Gateway config를 수정하지 않습니다. `ai.gateway.systems`의 시스템 ID는 backend system-id와 같고 `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`입니다.

| 시스템 항목 | 공급 규칙 |
|---|---|
| issuer | backend issuer와 같음, 필수 1~128자 |
| serviceTokenSha256File·actorJwksFile | 필수 읽기 전용 파일. 서비스 토큰 소문자 64자리 SHA-256(시스템 간 중복 금지)·공개 JWKS |
| backendUrl·gatewayTokenFile | tools가 있으면 필수, tools=[]이면 생략. backendUrl은 http·https 절대 주소이며 path·사용자 정보·query·fragment 없음. 호출 토큰은 backend gateway-token-file과 같음 |
| tools | 기본 []. id·description·inputSchema·outputSchema·requiredPermissions·timeoutMs. 설명 1~1024자, schema는 JSON Schema 객체, 입력 additionalProperties=false. timeoutMs 기본 10000·범위 1~10000. ID·권한은 backend 등록과 맞춤 |
| documents | 기본 []. bucket·prefix·requiredPermissions. 같은 시스템·bucket의 prefix 중복·겹침 금지 |
| apps | 기본 []. name·namespace·requiredPermissions |
| repositories | 기본 []. projectId·ref·pathPrefix·requiredPermissions |
| traces | 기본 []. service·namespace·requiredPermissions |
| reviewPermission | 필수. backend review-permission과 같음. **TC 공급값은 AI_REVIEW** |
| glossary | 기본 {}. 키 1~64자·풀이 1~256자, 빈 키·순환 치환 금지 |

원천 권한 배열은 1개 이상이며 코드는 `[A-Z0-9_]{1,64}`입니다. 빈 원천 목록은 조회 금지입니다. 설정 루트 `{}`는 유효하지만 인증할 시스템이 없습니다. 중복·알 수 없는 필드·미등록 참조·빈 필수값은 거절합니다. config 변경은 재기동 후 적용하며 삭제된 시스템의 과거 자료를 삭제한다는 뜻이 아닙니다. TC 문서·앱·trace·repository 설정은 006의 TC 항목을 그대로 공급합니다. 실제 주소·DNS·자격·부여 그룹은 추정하지 않습니다. 질문·답·근거·피드백·검토 본문·토큰·JWS·dlg·키는 **공통 jar 로그에 남기지 않습니다**. Gateway 일반 로그 정책과 구별합니다.

## 4. 권한: 기존 관리 기능으로 등록·부여

각 시스템 담당자는 기존 권한 관리 기능으로 AI 코드를 등록하고 담당자가 정한 그룹에 부여합니다. 공통 jar는 권한 DB·변경 hook을 추가하지 않습니다.

TC는 기존 EQP_READ·MODEL_READ·DLQ_READ·COMM_LOG_READ를 사용합니다. AI_DOC_READ·AI_ADMIN_DOC_READ·AI_LOG_READ·AI_TRACE_READ·AI_REVIEW의 기존 행이 있으면 permId를 재사용하고, 없으면 `POST /api/permission`으로 활성 API 권한을 등록합니다. 이름은 각각 AI 문서 조회·AI 관리 문서 조회·AI 로그 조회·AI 트레이스 조회·AI 답변 검토이며 resource=`/api/ai/permission-codes/{permCode}`, matchType=EXACT, httpMethod=GET, isActive=true입니다. 이 resource는 코드 보관용이며 실제 HTTP API를 열지 않습니다.

기존 TC 정책은 생성·수정 때 ADMIN 그룹이 있으면 그 권한을 ADMIN에 자동 매핑합니다. 그 권한을 가진 ADMIN 사용자가 `POST /api/group/{groupId}/permission/{permId}`로 담당 그룹에 부여합니다. 담당자가 ADMIN에 AI_REVIEW를 두지 않기로 정하면 대상 그룹 부여 뒤 `DELETE /api/group/{groupId}/permission/{permId}`로 ADMIN 매핑을 회수합니다. 이후 `PUT /api/permission/{permId}` 수정 시 ADMIN 매핑이 다시 생깁니다. 이 연동은 해당 정책·코드·Flyway·seed를 바꾸지 않습니다. 권한 회수는 다음 요청의 현재 권한에 반영되며 기존 dlg는 남은 최대 180초 동안 유효합니다.
