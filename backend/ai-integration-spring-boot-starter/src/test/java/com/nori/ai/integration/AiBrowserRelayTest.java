package com.nori.ai.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.nori.ai.integration.api.AiRequestIdentity;
import com.nori.ai.integration.config.AiIntegrationProperties.BrowserCredential;
import com.nori.ai.integration.security.AiDelegationCodec;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.Signature;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.util.Base64;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.web.FilterChainProxy;

@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class AiBrowserRelayTest {
    @TempDir static Path directory;
    PhaseTwoFixtures.Gateway gateway;
    PhaseTwoFixtures.App app;
    PhaseTwoFixtures.Keys keys;
    @BeforeAll void start() throws Exception {
        gateway = new PhaseTwoFixtures.Gateway();
        keys = PhaseTwoFixtures.keys(directory, gateway.base(), BrowserCredential.HEADER, List.of("AI_READ", "AI_REVIEW"));
        app = new PhaseTwoFixtures.App(keys.properties());
    }
    @BeforeEach void reset() {
        PhaseTwoFixtures.reset(); gateway.requests.clear(); gateway.status = 202;
        gateway.contentType = "application/json";
        gateway.contentEncoding = null;
        gateway.body = "{\"jobId\":\"12d55b20-b2e1-42d0-8e6f-fd151206f433\",\"conversationId\":\"conversation\",\"messageId\":\"message\",\"queuePosition\":1}".getBytes(StandardCharsets.UTF_8);
    }
    @AfterAll void stop() {
        if (app != null) app.close();
        if (gateway != null) gateway.close();
        PhaseTwoFixtures.assertNoThreads();
    }
    static Stream<String[]> routes() {
        return Stream.of(new String[]{"POST", "/v1/query"}, new String[]{"POST", "/v1/conversations"},
                new String[]{"GET", "/v1/conversations?after=opaque%2Bcursor&limit=20"}, new String[]{"GET", "/v1/conversations/id"},
                new String[]{"DELETE", "/v1/conversations/id"}, new String[]{"POST", "/v1/conversations/id/messages"},
                new String[]{"POST", "/v1/analyses"}, new String[]{"GET", "/v1/analyses/job"},
                new String[]{"POST", "/v1/analyses/job/cancel"}, new String[]{"GET", "/v1/analyses/job/events"},
                new String[]{"GET", "/v1/analyses/job/evidence/evidence/source"}, new String[]{"GET", "/v1/analyses/job/blocks/block/export"},
                new String[]{"GET", "/v1/audit/jobs/job"}, new String[]{"PUT", "/v1/answers/job/feedback"},
                new String[]{"GET", "/v1/reviews?state=OPEN&after=x&limit=20"}, new String[]{"GET", "/v1/reviews/feedback"},
                new String[]{"POST", "/v1/reviews/feedback/resolve"});
    }
    @ParameterizedTest @MethodSource("routes")
    void everyAllowedMethodPathPreservesBytesQueryHeadersAndSignsAsGatewayExpects(String method, String path) throws Exception {
        boolean creation = path.equals("/v1/conversations");
        byte[] body = method.equals("GET") || method.equals("DELETE") || creation ? new byte[0]
                : "{\"query\":\"질문 표식\",\"context\":{\"timezone\":\"Asia/Seoul\",\"referenceTime\":\"2026-11-23T09:00:00+09:00\"}}".getBytes(StandardCharsets.UTF_8);
        var response = app.send(method, "/api/ai" + path, body, "Content-Type", "application/json", "Accept", "application/json",
                "Idempotency-Key", "same-key", "Last-Event-ID", "last-id", "Authorization", "Bearer browser-credential",
                "X-Actor-Assertion", "browser-signature", "X-Delegation-Id", "browser-delegation", "Cookie", "login=browser-cookie",
                "X-Request-Id", "external-id", "X-Untrusted", "must-not-forward");
        assertThat(response.statusCode()).isEqualTo(202);
        assertThat(response.body()).isEqualTo(gateway.body);
        assertThat(response.headers().firstValue("Retry-After")).contains("7");
        assertThat(response.headers().firstValue("X-Job-Id")).contains("12d55b20-b2e1-42d0-8e6f-fd151206f433");
        assertThat(response.headers().firstValue("Set-Cookie")).isEmpty();
        assertThat(response.headers().firstValue("Authorization")).isEmpty();
        assertThat(response.headers().firstValue("X-Actor-Assertion")).isEmpty();
        String requestId = response.headers().firstValue("X-Request-Id").orElseThrow();
        assertThat(UUID.fromString(requestId).toString()).isEqualTo(requestId);
        assertThat(gateway.requests).hasSize(1);
        var recorded = gateway.requests.getFirst();
        assertThat(recorded.method()).isEqualTo(method); assertThat(recorded.path()).isEqualTo(path);
        assertThat(recorded.body()).isEqualTo(body);
        assertThat(recorded.header("Content-Type")).isEqualTo("application/json");
        assertThat(recorded.header("Accept")).isEqualTo("application/json");
        assertThat(recorded.header("Idempotency-Key")).isEqualTo("same-key");
        assertThat(recorded.header("Last-Event-ID")).isEqualTo("last-id");
        assertThat(recorded.header("Authorization")).isEqualTo("Bearer fixture-service-credential-never-log");
        for (String removed : List.of("Cookie", "X-Untrusted", "X-Request-Id", "X-Delegation-Id")) assertThat(recorded.header(removed)).isNull();
        String[] jws = recorded.header("X-Actor-Assertion").split("\\.");
        var header = PhaseTwoFixtures.JSON.readTree(Base64.getUrlDecoder().decode(jws[0]));
        assertThat(header.size()).isEqualTo(2);
        assertThat(header.get("alg").asString()).isEqualTo("ES256"); assertThat(header.get("kid").asString()).isEqualTo("fixture");
        byte[] signature = Base64.getUrlDecoder().decode(jws[2]); assertThat(signature).hasSize(64);
        var verifier = Signature.getInstance("SHA256withECDSAinP1363Format");
        verifier.initVerify(keys.pair().getPublic()); verifier.update((jws[0] + "." + jws[1]).getBytes(StandardCharsets.US_ASCII));
        assertThat(verifier.verify(signature)).isTrue();
        var claims = PhaseTwoFixtures.JSON.readTree(Base64.getUrlDecoder().decode(jws[1]));
        assertThat(claims.get("iat").asLong()).isEqualTo(PhaseTwoFixtures.NOW.getEpochSecond());
        assertThat(claims.get("exp").asLong()).isEqualTo(PhaseTwoFixtures.NOW.getEpochSecond() + 60);
        assertThat(claims.get("iss").asString()).isEqualTo("example-backend");
        assertThat(claims.get("sys").asString()).isEqualTo("Example_1");
        assertThat(claims.get("aud").asString()).isEqualTo("ai-gateway");
        assertThat(claims.get("scope").asString()).isEqualTo("READ");
        assertThat(claims.get("sub").asString()).isEqualTo("fixture_subject");
        assertThat(claims.get("perm").toString()).isEqualTo("[\"AI_READ\",\"AI_REVIEW\"]");
        assertThat(claims.get("pdg").asString()).isEqualTo(AiDelegationCodec.digest(Set.of("AI_READ", "AI_REVIEW")));
        boolean job = method.equals("POST") && (path.equals("/v1/query") || path.equals("/v1/analyses") || path.endsWith("/messages"));
        assertThat(claims.has("dlg")).isEqualTo(job);
        if (job) assertThat(claims.get("dlg").asString()).hasSize(119);
        if (path.endsWith("/events")) {
            assertThat(response.headers().firstValue("X-Accel-Buffering")).contains("no");
            assertThat(response.headers().firstValue("Cache-Control")).contains("no-cache");
        } else assertThat(response.headers().firstValue("Cache-Control")).contains("no-store");
        assertThat(PhaseTwoFixtures.BUSINESS).hasValue(0);
    }

    @Test void sessionEmptyPermissionsAndCurrentReviewHaveExactHeaderContract() throws Exception {
        var session = app.send("GET", "/api/ai/session", new byte[0]);
        var body = PhaseTwoFixtures.JSON.readTree(session.body());
        assertThat(body.size()).isEqualTo(4); assertThat(body.get("canReview").asBoolean()).isTrue();
        assertThat(body.get("integrationVersion").asString()).isEqualTo("1.0.5");
        assertThat(body.get("csrf").isNull()).isTrue();
        assertThat(session.headers().firstValue("Set-Cookie")).isEmpty();
        var inheritedRequest = new MockHttpServletRequest("GET", "/api/ai/session");
        inheritedRequest.setAttribute(org.springframework.security.web.csrf.CsrfToken.class.getName(),
                new org.springframework.security.web.csrf.DefaultCsrfToken("Host-CSRF", "_csrf", "host-token"));
        var inheritedResponse = new MockHttpServletResponse();
        app.context.getBean(FilterChainProxy.class).doFilter(inheritedRequest, inheritedResponse,
                (request, response) -> { throw new AssertionError("업무 체인 도달"); });
        assertThat(PhaseTwoFixtures.JSON.readTree(inheritedResponse.getContentAsByteArray()).get("csrf").isNull()).isTrue();
        PhaseTwoFixtures.IDENTITY.set(request -> new AiRequestIdentity(true, "fixture_subject", Set.of()));
        session = app.send("GET", "/api/ai/session", new byte[0]);
        assertThat(session.statusCode()).isEqualTo(200);
        assertThat(PhaseTwoFixtures.JSON.readTree(session.body()).get("canReview").asBoolean()).isFalse();
        app.send("POST", "/api/ai/v1/query", "{}".getBytes(StandardCharsets.UTF_8));
        var claims = PhaseTwoFixtures.JSON.readTree(Base64.getUrlDecoder().decode(gateway.requests.getFirst().header("X-Actor-Assertion").split("\\.")[1]));
        assertThat(claims.get("perm").isEmpty()).isTrue();
        assertThat(claims.get("pdg").asString()).isEqualTo("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }

    @Test void resolverFailuresAndSigningFailureHaveFixedEnvelopeAndZeroUpstreamCalls() throws Exception {
        List<AiRequestIdentity> invalid = java.util.Arrays.asList(null,
                new AiRequestIdentity(true, null, Set.of()), new AiRequestIdentity(true, "email@invalid", Set.of()),
                new AiRequestIdentity(true, "x", null), new AiRequestIdentity(false, "x", Set.of()),
                new AiRequestIdentity(false, null, Set.of("AI_READ")));
        for (var identity : invalid) {
            PhaseTwoFixtures.IDENTITY.set(request -> identity);
            assertFailure(app.send("GET", "/api/ai/session", new byte[0]), 500, "AUTH_RESULT_INVALID");
            assertFailure(app.send("POST", "/api/ai/v1/query", new byte[0]), 500, "AUTH_RESULT_INVALID");
        }
        PhaseTwoFixtures.IDENTITY.set(request -> { throw new IllegalStateException("credential-exception-never-log"); });
        assertFailure(app.send("GET", "/api/ai/session", new byte[0]), 503, "AUTH_UNAVAILABLE");
        PhaseTwoFixtures.IDENTITY.set(request -> new AiRequestIdentity(false, null, Set.of()));
        assertFailure(app.send("GET", "/api/ai/session", new byte[0]), 401, "LOGIN_REQUIRED");
        PhaseTwoFixtures.IDENTITY.set(request -> PhaseTwoFixtures.LOGGED_IN);
        PhaseTwoFixtures.SIGN_CLOCK.set(new Clock() {
            @Override public ZoneId getZone() { return java.time.ZoneOffset.UTC; }
            @Override public Clock withZone(ZoneId zone) { return this; }
            @Override public Instant instant() { throw new IllegalStateException("sign-secret-never-log"); }
        });
        assertFailure(app.send("POST", "/api/ai/v1/query", new byte[0]), 500, "SIGNING_FAILED");
        assertThat(gateway.requests).isEmpty();
    }

    @Test void assetAnonymousUnregisteredRoutesRejectedAndBusinessChainUnchanged() throws Exception {
        PhaseTwoFixtures.IDENTITY.set(request -> { throw new IllegalStateException("must-not-resolve-asset"); });
        var asset = app.send("GET", "/api/ai/assets/widget.js", new byte[0]);
        assertThat(asset.statusCode()).isEqualTo(200); assertThat(asset.body()).isNotEmpty();
        assertThat(asset.headers().firstValue("Cache-Control")).contains("no-cache");
        assertThat(asset.headers().firstValue("Set-Cookie")).isEmpty();
        assertThat(PhaseTwoFixtures.RESOLVES).hasValue(0);
        PhaseTwoFixtures.IDENTITY.set(request -> PhaseTwoFixtures.LOGGED_IN);
        for (String[] route : List.of(new String[]{"PATCH", "/api/ai/v1/query"}, new String[]{"GET", "/api/ai/v1/query"},
                new String[]{"POST", "/api/ai/internal/ai/v1/query"}, new String[]{"GET", "/api/ai/http://127.0.0.1/target"})) {
            assertThat(app.send(route[0], route[1], new byte[0]).statusCode()).as("%s %s", route[0], route[1]).isBetween(400, 499);
        }
        for (String body : List.of("{\"contextRef\":\"browser-assertion\"}", "{\"subject\":\"forged\"}", "{\"perm\":[]}", "{\"x\":1,\"x\":2}")) {
            assertFailure(app.send("POST", "/api/ai/v1/query", body.getBytes(StandardCharsets.UTF_8)), 400, "INPUT_INVALID");
        }
        assertThat(gateway.requests).isEmpty();
        assertThat(app.send("GET", "/internal/fixture", new byte[0]).statusCode()).isEqualTo(418);
        assertThat(app.send("GET", "/business", new byte[0]).statusCode()).isEqualTo(202);
        assertThat(app.send("POST", "/business", new byte[0]).statusCode()).isEqualTo(403);
        assertThat(PhaseTwoFixtures.BUSINESS).hasValue(1);
        assertThat(app.send("GET", "/business-protected", new byte[0]).statusCode()).isEqualTo(401);
        assertThat(app.send("GET", "/business-protected", new byte[0], "X-Host-Authenticated", "yes").statusCode()).isEqualTo(202);
        assertThat(app.send("GET", "/business-denied", new byte[0], "X-Host-Authenticated", "yes").statusCode()).isEqualTo(403);
        assertThat(PhaseTwoFixtures.BUSINESS).hasValue(2);
    }

    @Test void outsideTablePermissionFormatsAreIgnoredAndOnlyIntersectionIsSigned() throws Exception {
        for (Set<String> permissions : List.of(Set.of("invalid-code"), Set.of("invalid-code", "AI_READ"),
                Set.of("invalid-code", "시스템:권한", "AI_REVIEW"))) {
            PhaseTwoFixtures.IDENTITY.set(request -> new AiRequestIdentity(true, "x", permissions));
            var session = app.send("GET", "/api/ai/session", new byte[0]);
            assertThat(session.statusCode()).isEqualTo(200);
            var body = PhaseTwoFixtures.JSON.readTree(session.body());
            assertThat(body.get("subject").asString()).isEqualTo("x");
            assertThat(body.get("canReview").asBoolean()).isEqualTo(permissions.contains("AI_REVIEW"));
            int before = gateway.requests.size();
            assertThat(app.send("POST", "/api/ai/v1/query", new byte[0]).statusCode()).isEqualTo(202);
            var request = gateway.requests.get(before);
            var claims = PhaseTwoFixtures.JSON.readTree(Base64.getUrlDecoder().decode(request.header("X-Actor-Assertion").split("\\.")[1]));
            var expected = permissions.stream().filter(keys.properties().permissionCodes()::contains).sorted().toList();
            assertThat(claims.get("perm").toString()).isEqualTo(PhaseTwoFixtures.JSON.writeValueAsString(expected));
            assertThat(claims.get("pdg").asString()).isEqualTo(AiDelegationCodec.digest(Set.copyOf(expected)));
        }
    }

    @Test void cookieCsrfIsStatelessPrefixFrontContractAndSecureOnHttps() throws Exception {
        var cookieKeys = PhaseTwoFixtures.keys(directory.resolve("cookie"), gateway.base(), BrowserCredential.COOKIE, List.of("AI_READ", "AI_REVIEW"));
        try (var cookieApp = new PhaseTwoFixtures.App(cookieKeys.properties())) {
            var session = cookieApp.send("GET", "/api/ai/session", new byte[0]);
            var csrf = PhaseTwoFixtures.JSON.readTree(session.body()).get("csrf");
            assertThat(csrf.get("headerName").asString()).isEqualTo("X-Nori-AI-CSRF");
            String token = csrf.get("token").asString();
            String cookie = session.headers().firstValue("Set-Cookie").orElseThrow();
            assertThat(cookie).startsWith("NORI_AI_XSRF=").contains("Path=/", "SameSite=Strict").doesNotContain("Secure", "JSESSIONID");
            assertFailure(cookieApp.send("POST", "/api/ai/v1/query", new byte[0]), 403, "CSRF_INVALID");
            assertFailure(cookieApp.send("POST", "/api/ai/v1/query", new byte[0], "Cookie", cookie.split(";")[0], "X-Nori-AI-CSRF", "wrong"), 403, "CSRF_INVALID");
            assertThat(gateway.requests).isEmpty();
            assertThat(cookieApp.send("POST", "/api/ai/v1/query", new byte[0], "Cookie", cookie.split(";")[0], "X-Nori-AI-CSRF", token).statusCode()).isEqualTo(202);
            var request = new MockHttpServletRequest("GET", "/api/ai/session");
            request.setSecure(true); request.setScheme("https");
            var response = new MockHttpServletResponse();
            cookieApp.context.getBean(FilterChainProxy.class).doFilter(request, response, (input, output) -> { throw new AssertionError("업무 체인 도달"); });
            assertThat(response.getHeader("Set-Cookie")).contains("Secure", "Path=/");
            assertThat(response.getCookie("NORI_AI_XSRF").getAttribute("SameSite")).isEqualTo("Strict");
            assertThat(request.getSession(false)).isNull();
        }
    }

    @Test void gatewayErrorsEmptyBodiesRedirectAndRetryArePreserved() throws Exception {
        for (int status : List.of(401, 403, 404, 409, 429, 503, 504, 302, 204)) {
            gateway.status = status;
            gateway.body = status == 404 || status == 204 ? new byte[0]
                    : "{\"code\":\"REVIEW_CONFLICT\",\"message\":\"대역 오류\",\"requestId\":\"0f5f4155-cd17-4921-800d-d1b948dbb4a0\"}".getBytes(StandardCharsets.UTF_8);
            int before = gateway.requests.size();
            var response = app.send("POST", "/api/ai/v1/query", new byte[0]);
            assertThat(response.statusCode()).isEqualTo(status); assertThat(response.body()).isEqualTo(gateway.body);
            assertThat(gateway.requests).hasSize(before + 1);
            assertThat(response.headers().firstValue("Retry-After")).contains("7");
        }
    }

    @Test void prefixFrontMapsOnlyPathAndHeaderLoginIsConsumedByResolver() throws Exception {
        PhaseTwoFixtures.IDENTITY.set(request -> "browser-login".equals(request.getHeader("X-Login"))
                ? PhaseTwoFixtures.LOGGED_IN : new AiRequestIdentity(false, null, Set.of()));
        try (var front = new PhaseTwoFixtures.Front(app)) {
            var asset = app.client.send(java.net.http.HttpRequest.newBuilder(front.uri("/assets/widget.js")).GET().build(),
                    java.net.http.HttpResponse.BodyHandlers.ofByteArray());
            assertThat(asset.statusCode()).isEqualTo(200);
            var missing = app.client.send(java.net.http.HttpRequest.newBuilder(front.uri("/session")).GET().build(),
                    java.net.http.HttpResponse.BodyHandlers.ofByteArray());
            assertFailure(missing, 401, "LOGIN_REQUIRED");
            var session = app.client.send(java.net.http.HttpRequest.newBuilder(front.uri("/session")).header("X-Login", "browser-login").GET().build(),
                    java.net.http.HttpResponse.BodyHandlers.ofByteArray());
            assertThat(session.statusCode()).isEqualTo(200);
            assertThat(PhaseTwoFixtures.JSON.readTree(session.body()).get("csrf").isNull()).isTrue();
            var result = app.client.send(java.net.http.HttpRequest.newBuilder(front.uri("/v1/conversations?after=opaque&limit=20"))
                    .header("X-Login", "browser-login").GET().build(), java.net.http.HttpResponse.BodyHandlers.ofByteArray());
            assertThat(result.statusCode()).isEqualTo(202);
            assertThat(gateway.requests).hasSize(1);
            assertThat(gateway.requests.getFirst().path()).isEqualTo("/v1/conversations?after=opaque&limit=20");
            assertThat(gateway.requests.getFirst().header("X-Login")).isNull();
        }
    }

    @Test void droppedGetConnectionIsNotRetried() throws Exception {
        gateway.streaming = exchange -> exchange.close();
        try {
            assertFailure(app.send("GET", "/api/ai/v1/analyses/job", new byte[0]), 503, "GATEWAY_UNAVAILABLE");
            assertThat(gateway.requests).hasSize(1);
        } finally { gateway.streaming = null; }
    }

    @Test void nominatedHopHeadersAndInvalidTargetSyntaxAreRejectedWhileEncodedResponseIsPreserved() throws Exception {
        try (var relay = new com.nori.ai.integration.web.AiGatewayRelay(keys.properties())) {
            var request = new MockHttpServletRequest("GET", "/api/ai/v1/analyses/job");
            request.addHeader("Connection", "Accept, Idempotency-Key"); request.addHeader("Accept", "application/json");
            request.addHeader("Idempotency-Key", "hop-value"); request.addHeader("Content-Type", "application/json");
            var upstream = relay.prepare(request, "/v1/analyses/job", new byte[0], "fixture");
            assertThat(upstream.containsHeader("Accept")).isFalse();
            assertThat(upstream.containsHeader("Idempotency-Key")).isFalse();
            assertThat(upstream.getFirstHeader("Content-Type").getValue()).isEqualTo("application/json");
            request.setQueryString("invalid=%");
            org.assertj.core.api.Assertions.assertThatThrownBy(() -> relay.prepare(request, "/v1/analyses/job", new byte[0], "fixture"))
                    .isInstanceOfSatisfying(com.nori.ai.integration.security.AiIdentityService.Failure.class,
                            failure -> assertThat(failure.code()).isEqualTo("INPUT_INVALID"));
        }
        var encoded = new java.io.ByteArrayOutputStream();
        try (var gzip = new java.util.zip.GZIPOutputStream(encoded)) { gzip.write(gateway.body); }
        gateway.body = encoded.toByteArray(); gateway.contentEncoding = "gzip";
        var response = app.send("GET", "/api/ai/v1/analyses/job", new byte[0]);
        assertThat(response.body()).isEqualTo(gateway.body);
        assertThat(response.headers().firstValue("Content-Encoding")).contains("gzip");
    }

    static void assertFailure(HttpResponse<byte[]> response, int status, String code) {
        assertThat(response.statusCode()).isEqualTo(status);
        var body = PhaseTwoFixtures.JSON.readTree(response.body());
        assertThat(body.size()).isEqualTo(3); assertThat(body.get("code").asString()).isEqualTo(code);
        assertThat(body.get("message").asString()).containsPattern("[가-힣]");
        assertThat(body.get("requestId").asString()).isEqualTo(response.headers().firstValue("X-Request-Id").orElseThrow());
        assertThat(UUID.fromString(body.get("requestId").asString())).isNotNull();
        assertThat(response.headers().firstValue("Cache-Control")).contains("no-store");
    }
}
