package com.nori.ai.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.nori.ai.integration.config.AiIntegrationProperties.BrowserCredential;
import com.nori.ai.integration.observability.AiRequestLog;
import com.nori.ai.integration.web.AiGatewayRelay;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.slf4j.LoggerFactory;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class AiLogSafetyTest {
    @TempDir Path directory;
    private static final List<Path> DIRECTORIES = new java.util.concurrent.CopyOnWriteArrayList<>();
    @AfterAll static void noResourcesOrTemporaryKeysRemain() {
        assertThat(DIRECTORIES).noneMatch(Files::exists);
        PhaseTwoFixtures.assertNoThreads();
    }

    private record BrowserError(String code, int status, String stage, String message) {}

    @Test void everyJarBrowserErrorHasAnExplicitKoreanMessage() throws Exception {
        DIRECTORIES.add(directory);
        var properties = PhaseTwoFixtures.keys(directory, "http://127.0.0.1:1", BrowserCredential.HEADER,
                List.of("AI_READ", "AI_REVIEW")).properties();
        for (var error : List.of(
                new BrowserError("LOGIN_REQUIRED", 401, "identity", "로그인이 필요합니다."),
                new BrowserError("AUTH_UNAVAILABLE", 503, "identity", "로그인 정보를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요."),
                new BrowserError("AUTH_RESULT_INVALID", 500, "identity", "로그인 정보 처리에 오류가 발생했습니다."),
                new BrowserError("SIGNING_FAILED", 500, "sign", "AI 요청 인증 정보를 만들 수 없습니다."),
                new BrowserError("CSRF_INVALID", 403, "identity", "요청 보안 정보를 확인해 주세요."),
                new BrowserError("GATEWAY_TIMEOUT", 504, "connect", "AI 응답 대기 시간이 초과되었습니다."),
                new BrowserError("GATEWAY_UNAVAILABLE", 503, "connect", "AI 서비스에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요."),
                new BrowserError("INPUT_INVALID", 400, "relay", "요청 입력을 확인해 주세요."),
                new BrowserError("ROUTE_NOT_FOUND", 404, "relay", "요청한 AI 경로를 찾을 수 없습니다."))) {
            var response = new MockHttpServletResponse();
            var log = new AiRequestLog(properties);
            log.error(response, new com.nori.ai.integration.security.AiIdentityService.Failure(error.status(), error.code(), error.stage()));
            var body = PhaseTwoFixtures.JSON.readTree(response.getContentAsByteArray());
            assertThat(response.getStatus()).isEqualTo(error.status());
            assertThat(body.size()).isEqualTo(3);
            assertThat(body.get("code").asString()).isEqualTo(error.code());
            assertThat(body.get("message").asString()).isEqualTo(error.message());
            assertThat(body.get("requestId").asString()).isEqualTo(log.requestId());
        }
    }

    @Test void unknownErrorCodeThrowsBeforeChangingResponseEvenAfterCommit() throws Exception {
        DIRECTORIES.add(directory);
        var properties = PhaseTwoFixtures.keys(directory, "http://127.0.0.1:1", BrowserCredential.HEADER,
                List.of("AI_READ", "AI_REVIEW")).properties();
        for (boolean committed : List.of(false, true)) {
            var response = new MockHttpServletResponse(); response.setStatus(202);
            response.getOutputStream().write("unchanged".getBytes(StandardCharsets.UTF_8));
            if (committed) response.flushBuffer();
            assertThatThrownBy(() -> new AiRequestLog(properties).error(response,
                    new com.nori.ai.integration.security.AiIdentityService.Failure(500, "UNREGISTERED_CODE", "relay")))
                    .isInstanceOf(IllegalArgumentException.class).hasMessage("AI 오류 메시지가 정의되지 않았습니다.");
            assertThat(response.getStatus()).isEqualTo(202);
            assertThat(response.getContentAsByteArray()).isEqualTo("unchanged".getBytes(StandardCharsets.UTF_8));
        }
    }

    @Test void identitySignRelayRequestIdsAndSecretsAreSeparated() throws Exception {
        DIRECTORIES.add(directory); PhaseTwoFixtures.reset();
        try (var gateway = new PhaseTwoFixtures.Gateway()) {
            var keys = PhaseTwoFixtures.keys(directory, gateway.base(), BrowserCredential.HEADER, List.of("AI_READ", "AI_REVIEW"));
            try (var app = new PhaseTwoFixtures.App(keys.properties())) {
                var logger = (Logger) LoggerFactory.getLogger(AiRequestLog.class);
                Level originalLevel = logger.getLevel();
                var events = new ListAppender<ILoggingEvent>(); events.start(); logger.addAppender(events); logger.setLevel(Level.INFO);
                try {
                    byte[] body = "{\"query\":\"질문_SECRET_MARKER\",\"context\":{\"timezone\":\"Asia/Seoul\"}}".getBytes(StandardCharsets.UTF_8);
                    var accepted = app.send("POST", "/api/ai/v1/query", body);
                    String jarId = accepted.headers().firstValue("X-Request-Id").orElseThrow();
                    String assertion = gateway.requests.getFirst().header("X-Actor-Assertion");
                    var claims = PhaseTwoFixtures.JSON.readTree(Base64.getUrlDecoder().decode(assertion.split("\\.")[1]));
                    gateway.status = 409;
                    gateway.body = "{\"code\":\"REVIEW_CONFLICT\",\"message\":\"답변_근거_피드백_검토_SECRET_MARKER\",\"requestId\":\"0f5f4155-cd17-4921-800d-d1b948dbb4a0\"}".getBytes(StandardCharsets.UTF_8);
                    var conflict = app.send("POST", "/api/ai/v1/reviews/feedback/resolve", "{}".getBytes(StandardCharsets.UTF_8));
                    assertThat(conflict.body()).isEqualTo(gateway.body);
                    assertThat(conflict.headers().firstValue("X-Request-Id").orElseThrow()).isNotEqualTo("0f5f4155-cd17-4921-800d-d1b948dbb4a0");
                    PhaseTwoFixtures.IDENTITY.set(request -> { throw new IllegalStateException("exception_SECRET_MARKER"); });
                    AiBrowserRelayTest.assertFailure(app.send("GET", "/api/ai/session", new byte[0]), 503, "AUTH_UNAVAILABLE");
                    PhaseTwoFixtures.IDENTITY.set(request -> null);
                    AiBrowserRelayTest.assertFailure(app.send("GET", "/api/ai/session", new byte[0]), 500, "AUTH_RESULT_INVALID");
                    PhaseTwoFixtures.IDENTITY.set(request -> PhaseTwoFixtures.LOGGED_IN);
                    PhaseTwoFixtures.SIGN_CLOCK.set(new Clock() {
                        @Override public ZoneId getZone() { return java.time.ZoneOffset.UTC; }
                        @Override public Clock withZone(ZoneId zone) { return this; }
                        @Override public Instant instant() { throw new IllegalStateException("sign_SECRET_MARKER"); }
                    });
                    AiBrowserRelayTest.assertFailure(app.send("POST", "/api/ai/v1/query", new byte[0]), 500, "SIGNING_FAILED");
                    new AiRequestLog(keys.properties()).record("relay", 400, "BODY_SECRET_MARKER", "subject_SECRET_MARKER", "job_SECRET_MARKER");
                    var committed = new MockHttpServletResponse(); committed.setStatus(202); committed.flushBuffer();
                    new AiRequestLog(keys.properties()).error(committed,
                            new com.nori.ai.integration.security.AiIdentityService.Failure(503, "GATEWAY_UNAVAILABLE", "connect"));
                    assertThat(committed.getStatus()).isEqualTo(202); assertThat(committed.getContentAsByteArray()).isEmpty();
                    String output = String.join("\n", events.list.stream().map(ILoggingEvent::getFormattedMessage).toList());
                    assertThat(output).contains("requestId=" + jarId, "jobId=12d55b20-b2e1-42d0-8e6f-fd151206f433",
                            "gatewayRequestId=0f5f4155-cd17-4921-800d-d1b948dbb4a0", "stage=identity httpStatus=503 code=AUTH_UNAVAILABLE",
                            "stage=identity httpStatus=500 code=AUTH_RESULT_INVALID", "stage=sign httpStatus=500 code=SIGNING_FAILED",
                            "stage=relay httpStatus=409 code=REVIEW_CONFLICT", "stage=connect httpStatus=202 code=GATEWAY_UNAVAILABLE",
                            "integrationVersion=1.0.4", "direction=browser-to-gateway");
                    for (String secret : List.of("SECRET_MARKER", "fixture_subject", "fixture-service-credential-never-log", assertion,
                            claims.get("dlg").asString(), claims.get("pdg").asString(), Files.readString(keys.properties().delegationKeyFile()),
                            PhaseTwoFixtures.JSON.readTree(Files.readString(keys.properties().actorPrivateJwkFile())).get("d").asString())) {
                        assertThat(output.contains(secret)).as("본문·자격·사용자·예외·키 로그 부재").isFalse();
                    }
                    assertThat(events.list).allMatch(event -> event.getThrowableProxy() == null);
                } finally { logger.detachAppender(events); events.stop(); logger.setLevel(originalLevel); PhaseTwoFixtures.reset(); }
            }
        }
    }

    @Test void connectFailureAndAbsolute180SecondDeadlineHaveFixedErrorsNoRetriesAndNoTimerResidue() throws Exception {
        DIRECTORIES.add(directory);
        final int closedPort;
        try (var port = new ServerSocket(0, 0, java.net.InetAddress.getByName("127.0.0.1"))) { closedPort = port.getLocalPort(); }
        var props = PhaseTwoFixtures.keys(directory, "http://127.0.0.1:" + closedPort, BrowserCredential.HEADER,
                List.of("AI_READ", "AI_REVIEW")).properties();
        var logger = (Logger) LoggerFactory.getLogger(AiRequestLog.class);
        Level originalLevel = logger.getLevel(); var events = new ListAppender<ILoggingEvent>(); events.start();
        logger.addAppender(events); logger.setLevel(Level.INFO);
        try {
            try (var relay = new AiGatewayRelay(props)) {
                var request = new MockHttpServletRequest("POST", "/api/ai/v1/query");
                var response = new MockHttpServletResponse();
                var log = new AiRequestLog(props);
                relay.ordinary(relay.prepare(request, "/v1/query", new byte[0], "assertion_SECRET_MARKER"), response, log);
                assertThat(response.getStatus()).isEqualTo(503);
                assertThat(PhaseTwoFixtures.JSON.readTree(response.getContentAsByteArray()).get("code").asString()).isEqualTo("GATEWAY_UNAVAILABLE");
            }
            var started = new CountDownLatch(1); var release = new CountDownLatch(1); var finished = new CountDownLatch(1);
            try (var gateway = new PhaseTwoFixtures.Gateway()) {
                gateway.streaming = exchange -> {
                    try (exchange) {
                        exchange.sendResponseHeaders(200, 0);
                        exchange.getResponseBody().write("pending".getBytes(StandardCharsets.UTF_8)); exchange.getResponseBody().flush(); started.countDown();
                        release.await();
                    } catch (java.io.IOException disconnected) { finished.countDown(); }
                    catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
                    finally { finished.countDown(); }
                };
                var streaming = new com.nori.ai.integration.config.AiIntegrationProperties(true, BrowserCredential.HEADER,
                        props.systemId(), props.issuer(), gateway.base(), props.serviceTokenFile(), props.actorPrivateJwkFile(), null,
                        props.delegationKeyFile(), props.permissionCodes(), props.reviewPermission(), List.of());
                var timers = new PhaseTwoFixtures.ManualTimers();
                var executor = Executors.newSingleThreadExecutor(Thread.ofPlatform().name("phase2-timeout-test").factory());
                try (var relay = new AiGatewayRelay(streaming, timers)) {
                    var request = new MockHttpServletRequest("POST", "/api/ai/v1/query");
                    var response = new MockHttpServletResponse();
                    var task = executor.submit(() -> {
                        relay.ordinary(relay.prepare(request, "/v1/query", new byte[0], "fixture"), response, new AiRequestLog(streaming));
                        return response;
                    });
                    assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();
                    timers.expire();
                    assertThat(task.get().getStatus()).isEqualTo(504);
                    assertThat(PhaseTwoFixtures.JSON.readTree(response.getContentAsByteArray()).get("code").asString()).isEqualTo("GATEWAY_TIMEOUT");
                    assertThat(gateway.requests).hasSize(1); assertThat(timers.getQueue()).isEmpty();
                } finally {
                    release.countDown(); assertThat(finished.await(5, TimeUnit.SECONDS)).isTrue();
                    executor.shutdownNow(); assertThat(executor.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
                }
            }
            String logs = String.join("\n", events.list.stream().map(ILoggingEvent::getFormattedMessage).toList());
            assertThat(logs).contains("stage=connect httpStatus=503 code=GATEWAY_UNAVAILABLE", "stage=connect httpStatus=504 code=GATEWAY_TIMEOUT");
            assertThat(logs.contains("SECRET_MARKER")).isFalse();
        } finally { logger.detachAppender(events); events.stop(); logger.setLevel(originalLevel); }
        await().atMost(Duration.ofSeconds(5)).untilAsserted(PhaseTwoFixtures::assertNoThreads);
    }
}
