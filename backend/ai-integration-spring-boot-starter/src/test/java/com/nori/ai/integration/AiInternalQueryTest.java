package com.nori.ai.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.nori.ai.integration.api.AiRequestIdentityResolver;
import com.nori.ai.integration.api.AiToolCall;
import com.nori.ai.integration.api.AiToolHandler;
import com.nori.ai.integration.api.AiToolRegistration;
import com.nori.ai.integration.api.AiToolResult;
import com.nori.ai.integration.config.AiIntegrationProperties;
import com.nori.ai.integration.config.AiIntegrationProperties.BrowserCredential;
import com.nori.ai.integration.observability.AiRequestLog;
import com.nori.ai.integration.security.AiDelegationCodec;
import com.nori.ai.integration.tool.AiToolDispatcher;
import com.nori.ai.integration.tool.AiToolEnvelopeAssembler;
import com.nori.ai.integration.web.AiInternalQueryController;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.slf4j.LoggerFactory;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.server.context.WebServerApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;
import tools.jackson.databind.node.ObjectNode;

class AiInternalQueryTest {
    @TempDir Path directory;
    static final List<Path> DIRECTORIES = new java.util.concurrent.CopyOnWriteArrayList<>();
    static final AtomicInteger HOST_RESOLVES = new AtomicInteger(), HOST_HANDLES = new AtomicInteger();
    @AfterAll static void noTemporaryFilesOrThreadsRemain() {
        assertThat(DIRECTORIES).noneMatch(Files::exists);
        PhaseTwoFixtures.assertNoThreads();
    }
    static final class MutableClock extends Clock {
        final AtomicReference<Instant> now = new AtomicReference<>(PhaseTwoFixtures.NOW);
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return this; }
        @Override public Instant instant() { return now.get(); }
    }
    static final class Fixture implements AutoCloseable {
        final AiIntegrationProperties properties;
        final MutableClock clock = new MutableClock();
        final AiDelegationCodec codec;
        final AiToolDispatcher dispatcher = new AiToolDispatcher(clock);
        final AtomicInteger calls = new AtomicInteger();
        final AtomicReference<AiToolHandler> handler = new AtomicReference<>(call -> AiToolResultBoundaryTest.success());
        final AtomicReference<AiToolCall> input = new AtomicReference<>();
        final AiInternalQueryController controller;
        final String token;
        Fixture(Path directory) throws Exception {
            DIRECTORIES.add(directory);
            var original = PhaseTwoFixtures.keys(directory, "http://127.0.0.1:1", BrowserCredential.COOKIE, List.of("AI_READ", "AI_REVIEW")).properties();
            Path gateway = directory.resolve("gateway");
            token = java.util.UUID.randomUUID().toString(); Files.writeString(gateway, token);
            properties = new AiIntegrationProperties(true, original.browserCredential(), original.systemId(), original.issuer(), original.gatewayBaseUrl(),
                    original.serviceTokenFile(), original.actorPrivateJwkFile(), gateway, original.delegationKeyFile(), original.permissionCodes(), "AI_REVIEW",
                    List.of(new AiIntegrationProperties.Tool("example.read", List.of("AI_READ")), new AiIntegrationProperties.Tool("public.read", List.of())));
            codec = new AiDelegationCodec(properties, clock);
            controller = new AiInternalQueryController(properties, codec, dispatcher, new AiToolEnvelopeAssembler(),
                    List.of(AiToolRegistration.of("example.read", call -> { calls.incrementAndGet(); input.set(call); return handler.get().handle(call); }),
                            AiToolRegistration.of("public.read", call -> { calls.incrementAndGet(); input.set(call); return handler.get().handle(call); })), clock);
        }
        ObjectNode body() { return body(Set.of("AI_READ")); }
        ObjectNode body(Set<String> permissions) {
            var body = PhaseTwoFixtures.JSON.createObjectNode().put("version", "1").put("systemId", "Example_1")
                    .put("jobId", AiToolResultBoundaryTest.ID.jobId()).put("toolId", "example.read").put("subject", "actor_SECRET_MARKER")
                    .put("delegationId", codec.issue("actor_SECRET_MARKER", permissions)).put("permissionDigest", AiDelegationCodec.digest(permissions))
                    .put("deadline", clock.instant().plusSeconds(10).toString());
            body.putObject("arguments"); body.putArray("targets"); return body;
        }
        MockHttpServletRequest request(ObjectNode body) {
            var request = new MockHttpServletRequest("POST", AiInternalQueryController.PATH);
            request.setContentType("application/json"); request.addHeader("Authorization", "Bearer " + token);
            request.addHeader("X-Request-Id", body.get("jobId").asString()); request.addHeader("X-Actor-Subject", body.get("subject").asString());
            request.addHeader("X-Delegation-Id", body.get("delegationId").asString()); request.setContent(PhaseTwoFixtures.JSON.writeValueAsBytes(body));
            return request;
        }
        MockHttpServletResponse send(ObjectNode body) throws Exception { return send(request(body)); }
        MockHttpServletResponse send(MockHttpServletRequest request) throws Exception {
            var response = new MockHttpServletResponse(); controller.handle(request, response); return response;
        }
        @Override public void close() { dispatcher.close(); assertThat(dispatcher.activeCount()).isZero(); }
    }
    static void assertFailure(MockHttpServletResponse response, int http, String code, String status) {
        assertThat(response.getStatus()).isEqualTo(http);
        var body = PhaseTwoFixtures.JSON.readTree(response.getContentAsByteArray());
        assertThat(body.size()).isEqualTo(11); assertThat(body.get("status").asString()).isEqualTo(status);
        assertThat(body.get("errorCode").asString()).isEqualTo(code); assertThat(body.get("data").isNull()).isTrue();
        assertThat(body.get("missingFields").isEmpty()).isTrue(); assertThat(body.get("warnings").isEmpty()).isTrue();
        assertThat(body.get("retentionMeta").get("missingRanges").isEmpty()).isTrue();
        assertThat(body.get("retentionMeta").get("unverifiedRanges").isEmpty()).isTrue();
        assertThat(body.get("observedAt").asString()).isEqualTo(PhaseTwoFixtures.NOW.toString());
    }

    @Test void authenticationWinsOverInvalidBodyAndRecoversOnlyAvailableIdentifiersWithin64KiB() throws Exception {
        try (var f = new Fixture(directory)) {
            for (String authorization : List.of("", "Bearer wrong_SECRET_MARKER", "bearer wrong", "Bearer a b", "Bearer a,b")) {
                var body = f.body(); var request = f.request(body); request.removeHeader("Authorization");
                if (!authorization.isEmpty()) request.addHeader("Authorization", authorization);
                var response = f.send(request); assertFailure(response, 401, "SERVICE_AUTH_INVALID", "DENIED");
                assertThat(PhaseTwoFixtures.JSON.readTree(response.getContentAsByteArray()).get("jobId").asString()).isEqualTo(body.get("jobId").asString());
            }
            var duplicate = f.request(f.body()); duplicate.addHeader("Authorization", "Bearer " + f.token);
            assertFailure(f.send(duplicate), 401, "SERVICE_AUTH_INVALID", "DENIED");
            for (byte[] bytes : List.of("not json".getBytes(StandardCharsets.UTF_8), new byte[65537])) {
                var request = f.request(f.body()); request.removeHeader("Authorization"); request.setContent(bytes);
                var response = f.send(request); assertFailure(response, 401, "SERVICE_AUTH_INVALID", "DENIED");
                assertThat(PhaseTwoFixtures.JSON.readTree(response.getContentAsByteArray()).get("version").isNull()).isTrue();
            }
            var request = f.request(f.body()); request.removeHeader("Authorization"); request.setContent("{\"version\":\"bad\",\"systemId\":null,\"jobId\":17,\"toolId\":\"unknown\"}".getBytes(StandardCharsets.UTF_8));
            var recovered = PhaseTwoFixtures.JSON.readTree(f.send(request).getContentAsByteArray());
            assertThat(recovered.get("version").asString()).isEqualTo("bad"); assertThat(recovered.get("toolId").asString()).isEqualTo("unknown");
            assertThat(recovered.get("systemId").isNull()).isTrue(); assertThat(recovered.get("jobId").isNull()).isTrue();
            assertThat(f.calls).hasValue(0);
        }
    }

    @Test void inputSyntaxTypesUnknownFieldsUtf8AndExact64KiBLimit() throws Exception {
        try (var f = new Fixture(directory)) {
            for (String mutation : List.of("duplicate", "unknown", "versionType", "missing", "trailing", "unicode")) {
                var body = f.body(); String text = body.toString();
                switch (mutation) {
                    case "duplicate" -> text = text.replace("\"version\":\"1\"", "\"version\":\"1\",\"version\":\"1\"");
                    case "unknown" -> { body.put("unknown", 1); text = body.toString(); }
                    case "versionType" -> { body.put("version", 1); text = body.toString(); }
                    case "missing" -> { body.remove("targets"); text = body.toString(); }
                    case "trailing" -> text += " {}";
                    case "unicode" -> text = text.replace("\"arguments\":{}", "\"arguments\":{\"x\":\"\\ud800\"}");
                    default -> throw new AssertionError();
                }
                var request = f.request(body); request.setContent(text.getBytes(StandardCharsets.UTF_8));
                assertFailure(f.send(request), 400, "INPUT_INVALID", "FAILED");
            }
            var badUtf8 = f.request(f.body()); badUtf8.setContent(new byte[]{(byte) 0xc3, 0x28});
            assertFailure(f.send(badUtf8), 400, "INPUT_INVALID", "FAILED");
            assertThat(f.calls).hasValue(0);
            for (int size : List.of(65535, 65536, 65537)) {
                var body = f.body(); int base = PhaseTwoFixtures.JSON.writeValueAsBytes(body).length;
                // JSON 뒤 공백도 실제 UTF-8 요청 바이트에 포함한다.
                var request = f.request(body); request.setContent((body + " ".repeat(size - base)).getBytes(StandardCharsets.UTF_8));
                var response = f.send(request); assertThat(response.getStatus()).isEqualTo(size > 65536 ? 400 : 200);
            }
            assertThat(f.calls).hasValue(2);
        }
    }

    @Test void orderedVersionSystemHeadersPdgDelegationToolPermissionArgumentsTargetsAndDeadline() throws Exception {
        try (var f = new Fixture(directory)) {
            var body = f.body(); body.put("version", "2").put("systemId", "other").put("permissionDigest", "bad");
            assertFailure(f.send(body), 400, "INPUT_INVALID", "FAILED");
            body.put("version", "1"); assertFailure(f.send(body), 403, "DELEGATION_DENIED", "DENIED");
            for (String name : List.of("X-Request-Id", "X-Actor-Subject", "X-Delegation-Id")) {
                for (String mode : List.of("missing", "mismatch", "duplicate")) {
                    var request = f.request(f.body());
                    if (!mode.equals("duplicate")) request.removeHeader(name);
                    if (!mode.equals("missing")) request.addHeader(name, "mismatch");
                    assertFailure(f.send(request), 400, "INPUT_INVALID", "FAILED");
                }
            }
            body = f.body(); body.put("permissionDigest", "A".repeat(64)); assertFailure(f.send(body), 400, "INPUT_INVALID", "FAILED");
            body.put("permissionDigest", "0".repeat(64)); assertFailure(f.send(body), 409, "DELEGATION_CHANGED", "DENIED");
            body = f.body(); body.put("subject", "other"); assertFailure(f.send(body), 403, "DELEGATION_DENIED", "DENIED");
            body = f.body(); body.put("delegationId", "a".repeat(119)).put("toolId", "unknown"); assertFailure(f.send(body), 403, "DELEGATION_DENIED", "DENIED");
            body = f.body(); body.put("toolId", "unknown").put("arguments", "bad"); assertFailure(f.send(body), 404, "TOOL_NOT_FOUND", "FAILED");
            body = f.body(Set.of()); body.put("arguments", "bad"); assertFailure(f.send(body), 403, "DELEGATION_DENIED", "DENIED");
            body.put("toolId", "public.read"); assertFailure(f.send(body), 400, "INPUT_INVALID", "FAILED");
            body = f.body(); body.put("arguments", "bad"); assertFailure(f.send(body), 400, "INPUT_INVALID", "FAILED");
            for (String deadline : List.of("bad", "2026-11-23T00:00:10+00:00", "2026-99-23T00:00:10Z")) {
                body = f.body(); body.put("deadline", deadline); assertFailure(f.send(body), 400, "INPUT_INVALID", "FAILED");
            }
            for (Instant deadline : List.of(PhaseTwoFixtures.NOW, PhaseTwoFixtures.NOW.minusNanos(1))) {
                body = f.body(); body.put("deadline", deadline.toString()); assertFailure(f.send(body), 504, "TIMEOUT", "TIMEOUT");
            }
            assertThat(f.calls).hasValue(0);
            body = f.body(Set.of()); body.put("toolId", "public.read"); assertThat(f.send(body).getStatus()).isEqualTo(200);
            assertThat(f.input.get().permissionCodes()).isEmpty();
        }
    }

    @Test void targetsBoundariesAreReferencesOnlyAndInputsAreDeeplyImmutable() throws Exception {
        try (var f = new Fixture(directory)) {
            for (int count : List.of(0, 16, 17)) for (int length : List.of(0, 1, 256, 257)) {
                var body = f.body(); var targets = body.putArray("targets");
                for (int i = 0; i < count; i++) targets.addObject().put("type", "😀".repeat(length)).put("ref", "x".repeat(length));
                boolean valid = count == 0 || count <= 16 && length >= 1 && length <= 256;
                assertThat(f.send(body).getStatus()).isEqualTo(valid ? 200 : 400);
            }
            for (String json : List.of("null", "{}", "[null]", "[{\"type\":\"x\",\"ref\":\"x\",\"extra\":1}]", "[{\"type\":1,\"ref\":\"x\"}]")) {
                var body = f.body(); body.set("targets", PhaseTwoFixtures.JSON.readTree(json)); assertFailure(f.send(body), 400, "INPUT_INVALID", "FAILED");
            }
            f.handler.set(call -> {
                assertThatThrownBy(() -> call.permissionCodes().clear()).isInstanceOf(UnsupportedOperationException.class);
                assertThatThrownBy(() -> call.arguments().clear()).isInstanceOf(UnsupportedOperationException.class);
                assertThatThrownBy(() -> ((Map<?, ?>) call.arguments().get("nested")).clear()).isInstanceOf(UnsupportedOperationException.class);
                assertThatThrownBy(() -> call.targets().clear()).isInstanceOf(UnsupportedOperationException.class);
                return AiToolResultBoundaryTest.success();
            });
            var body = f.body(); body.putObject("arguments").putObject("nested").put("notInAnySchema", true);
            body.putArray("targets").addObject().put("type", "arbitrary").put("ref", "reference-only");
            body.put("deadline", PhaseTwoFixtures.NOW.plusSeconds(300).toString());
            assertThat(f.send(body).getStatus()).isEqualTo(200);
            assertThat(f.input.get().deadline()).isEqualTo(PhaseTwoFixtures.NOW.plusSeconds(180));
            assertThat(f.input.get().observedAt()).isEqualTo(PhaseTwoFixtures.NOW);
        }
    }

    @Test void overloadDeadlineLateResultsAndReleaseAreMeasured() throws Exception {
        try (var f = new Fixture(directory); var callers = Executors.newFixedThreadPool(8)) {
            var started = new CountDownLatch(8); var release = new CountDownLatch(1);
            f.handler.set(call -> { started.countDown(); try { release.await(); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); } return AiToolResultBoundaryTest.success(); });
            var futures = new ArrayList<java.util.concurrent.Future<MockHttpServletResponse>>();
            try {
                for (int i = 0; i < 8; i++) futures.add(callers.submit(() -> f.send(f.body())));
                assertThat(started.await(5, TimeUnit.SECONDS)).isTrue(); assertThat(f.dispatcher.activeCount()).isEqualTo(8);
                assertFailure(f.send(f.body()), 429, "SOURCE_BUSY", "SOURCE_UNAVAILABLE");
            } finally { release.countDown(); }
            for (var future : futures) assertThat(future.get().getStatus()).isEqualTo(200);
            await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(f.dispatcher.activeCount()).isZero());
            var interrupted = new CountDownLatch(1);
            f.handler.set(call -> { try { new CountDownLatch(1).await(); } catch (InterruptedException expected) { interrupted.countDown(); } return AiToolResultBoundaryTest.success(); });
            var body = f.body(); body.put("deadline", f.clock.instant().plusMillis(30).toString());
            assertFailure(f.send(body), 504, "TIMEOUT", "TIMEOUT");
            assertThat(interrupted.await(5, TimeUnit.SECONDS)).isTrue();
            await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(f.dispatcher.activeCount()).isZero());
            f.handler.set(call -> { f.clock.now.set(PhaseTwoFixtures.NOW.plusSeconds(10)); return AiToolResultBoundaryTest.success(); });
            assertFailure(f.send(f.body()), 504, "TIMEOUT", "TIMEOUT");
        }
    }

    @Test void logsDistinguishHandlerExceptionAndRelayViolationAndNeverExposeSecrets() throws Exception {
        try (var f = new Fixture(directory)) {
            var logger = (Logger) LoggerFactory.getLogger(AiRequestLog.class); Level original = logger.getLevel();
            var events = new ListAppender<ILoggingEvent>(); events.start(); logger.addAppender(events); logger.setLevel(Level.INFO);
            try {
                f.handler.set(call -> { throw new IllegalStateException("exception_SECRET_MARKER"); });
                assertFailure(f.send(f.body()), 503, "SOURCE_UNAVAILABLE", "SOURCE_UNAVAILABLE");
                f.handler.set(call -> new AiToolResult(AiToolResult.Status.SUCCESS, AiToolResultBoundaryTest.success().items(), List.of("missing_SECRET_MARKER"), List.of(), AiToolResultBoundaryTest.NONE));
                assertFailure(f.send(f.body()), 503, "SOURCE_UNAVAILABLE", "SOURCE_UNAVAILABLE");
                String text = String.join("\n", events.list.stream().map(ILoggingEvent::getFormattedMessage).toList());
                assertThat(text).contains("direction=gateway-to-system", "stage=handler httpStatus=503 code=SOURCE_UNAVAILABLE", "stage=relay httpStatus=503 code=SOURCE_UNAVAILABLE", "toolId=example.read");
                for (String secret : List.of("SECRET_MARKER", f.token, f.body().get("delegationId").asString(), AiDelegationCodec.digest(Set.of("AI_READ")), Files.readString(f.properties.delegationKeyFile()))) assertThat(text).doesNotContain(secret);
                assertThat(events.list).allMatch(event -> event.getThrowableProxy() == null);
                assertThatThrownBy(() -> new AiRequestLog(f.properties).internal("relay", 503, "unknown", null, null)).isInstanceOf(IllegalArgumentException.class);
            } finally { logger.detachAppender(events); events.stop(); logger.setLevel(original); }
        }
    }

    @Test void ignoredInterruptRetainsSlotUntilActualHandlerExitAndErrorsUseQueryStart() throws Exception {
        try (var f = new Fixture(directory)) {
            var release = new CountDownLatch(1); var entered = new CountDownLatch(1); var cancelled = new CountDownLatch(1);
            f.handler.set(call -> {
                entered.countDown();
                while (release.getCount() != 0) try { release.await(); }
                    catch (InterruptedException expected) { cancelled.countDown(); }
                return AiToolResultBoundaryTest.success();
            });
            try (var caller = Executors.newSingleThreadExecutor()) {
                try {
                    var body = f.body(); body.put("deadline", PhaseTwoFixtures.NOW.plusMillis(100).toString());
                    var result = caller.submit(() -> f.send(body));
                    assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
                    assertFailure(result.get(), 504, "TIMEOUT", "TIMEOUT");
                    assertThat(cancelled.await(5, TimeUnit.SECONDS)).isTrue(); assertThat(f.dispatcher.activeCount()).isEqualTo(1);
                } finally { release.countDown(); }
            }
            await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(f.dispatcher.activeCount()).isZero());
            // 본문 검사 뒤 시작한 조회의 실패 시각도 실제 호출 입력과 같다.
            f.handler.set(call -> { f.clock.now.set(PhaseTwoFixtures.NOW.plusSeconds(3)); throw new IllegalStateException("비공개"); });
            var response = f.send(f.body());
            assertFailure(response, 503, "SOURCE_UNAVAILABLE", "SOURCE_UNAVAILABLE");
            assertThat(PhaseTwoFixtures.JSON.readTree(response.getContentAsByteArray()).get("observedAt").asString()).isEqualTo(f.input.get().observedAt().toString());
            f.clock.now.set(PhaseTwoFixtures.NOW);
            f.handler.set(call -> { throw new com.nori.ai.integration.security.AiIdentityService.Failure(504, "TIMEOUT", "handler"); });
            assertFailure(f.send(f.body()), 503, "SOURCE_UNAVAILABLE", "SOURCE_UNAVAILABLE");
        }
    }

    @Test void emptyToolsWithoutTokenDenyAuthenticationAndInternalMacFailureIs503() throws Exception {
        try (var f = new Fixture(directory)) {
            var p = f.properties;
            var empty = new AiIntegrationProperties(true, p.browserCredential(), p.systemId(), p.issuer(), p.gatewayBaseUrl(), p.serviceTokenFile(), p.actorPrivateJwkFile(), null, p.delegationKeyFile(), p.permissionCodes(), p.reviewPermission(), List.of());
            var controller = new AiInternalQueryController(empty, f.codec, f.dispatcher, new AiToolEnvelopeAssembler(), List.of(), f.clock);
            var response = new MockHttpServletResponse(); controller.handle(f.request(f.body()), response);
            assertFailure(response, 401, "SERVICE_AUTH_INVALID", "DENIED");
            var request = f.request(f.body());
            var key = AiDelegationCodec.class.getDeclaredField("key"); key.setAccessible(true); key.set(f.codec, new byte[0]);
            assertFailure(f.send(request), 503, "SOURCE_UNAVAILABLE", "SOURCE_UNAVAILABLE"); assertThat(f.calls).hasValue(0);
        }
    }

    @Test void twoNewJvmProcessesAndRestartUseForeignDelegationThroughInternalEndpointAt180SecondBoundary() throws Exception {
        try (var f = new Fixture(directory)) {
            var body = f.body(); body.put("deadline", PhaseTwoFixtures.NOW.plusSeconds(300).toString());
            for (int processIndex = 0; processIndex < 2; processIndex++) {
                var process = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(), "-cp", System.getProperty("ai.integration.test.classpath"), QueryProcess.class.getName()).start();
                try {
                    try (var stdin = process.getOutputStream()) {
                        stdin.write(PhaseTwoFixtures.JSON.writeValueAsBytes(Map.of("body", body, "key", f.properties.delegationKeyFile().toString(), "gateway", f.properties.gatewayTokenFile().toString())));
                    }
                    byte[] stdout = process.getInputStream().readAllBytes(), stderr = process.getErrorStream().readAllBytes();
                    assertThat(process.waitFor()).isZero(); assertThat(stderr).isEmpty();
                    assertThat(new String(stdout, StandardCharsets.UTF_8)).contains("INTERNAL_200_200_403");
                } finally { if (process.isAlive()) process.destroy(); }
                assertThat(process.isAlive()).isFalse();
            }
        }
    }
    public static final class QueryProcess {
        public static void main(String[] args) throws Exception {
            var input = PhaseTwoFixtures.JSON.readTree(System.in);
            var p = new AiIntegrationProperties(true, BrowserCredential.COOKIE, "Example_1", "issuer", "http://127.0.0.1:1", null, null,
                    Path.of(input.get("gateway").asString()), Path.of(input.get("key").asString()), List.of("AI_READ", "AI_REVIEW"), "AI_REVIEW",
                    List.of(new AiIntegrationProperties.Tool("example.read", List.of("AI_READ"))));
            var clock = new MutableClock(); var codec = new AiDelegationCodec(p, clock);
            try (var dispatcher = new AiToolDispatcher(clock)) {
                var controller = new AiInternalQueryController(p, codec, dispatcher, new AiToolEnvelopeAssembler(), List.of(AiToolRegistration.of("example.read", call -> AiToolResultBoundaryTest.success())), clock);
                var statuses = new ArrayList<Integer>();
                var server = com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);
                try (var workers = Executors.newSingleThreadExecutor(Thread.ofPlatform().name("phase3-process-http").factory());
                        var client = java.net.http.HttpClient.newHttpClient()) {
                    server.setExecutor(workers);
                    server.createContext(AiInternalQueryController.PATH, exchange -> {
                        try (exchange) {
                            var request = new MockHttpServletRequest(exchange.getRequestMethod(), exchange.getRequestURI().getPath());
                            request.setContentType(exchange.getRequestHeaders().getFirst("Content-Type"));
                            exchange.getRequestHeaders().forEach((name, values) -> values.forEach(value -> request.addHeader(name, value)));
                            request.setContent(exchange.getRequestBody().readAllBytes());
                            var response = new MockHttpServletResponse(); controller.handle(request, response);
                            byte[] bytes = response.getContentAsByteArray();
                            exchange.sendResponseHeaders(response.getStatus(), bytes.length); exchange.getResponseBody().write(bytes);
                        }
                    });
                    server.start();
                    try {
                        for (Instant now : List.of(PhaseTwoFixtures.NOW, PhaseTwoFixtures.NOW.plusSeconds(179), PhaseTwoFixtures.NOW.plusSeconds(180))) {
                            clock.now.set(now); var body = input.get("body");
                            var request = java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://127.0.0.1:" + server.getAddress().getPort() + AiInternalQueryController.PATH))
                                    .header("Content-Type", "application/json").header("Authorization", "Bearer " + Files.readString(p.gatewayTokenFile()))
                                    .header("X-Request-Id", body.get("jobId").asString()).header("X-Actor-Subject", body.get("subject").asString()).header("X-Delegation-Id", body.get("delegationId").asString())
                                    .POST(java.net.http.HttpRequest.BodyPublishers.ofByteArray(PhaseTwoFixtures.JSON.writeValueAsBytes(body))).build();
                            var response = client.send(request, java.net.http.HttpResponse.BodyHandlers.ofByteArray());
                            AiToolResultBoundaryTest.GatewayContract.accept(response.statusCode(), response.body()); statuses.add(response.statusCode());
                        }
                    } finally { server.stop(0); }
                }
                if (!statuses.equals(List.of(200, 200, 403))) throw new IllegalStateException("내부 위임 경계 검증 실패");
                System.out.print("INTERNAL_200_200_403");
            }
            PhaseTwoFixtures.assertNoThreads();
        }
    }

    @Configuration(proxyBeanMethods = false) @EnableAutoConfiguration
    static class Host {
        @Bean AiRequestIdentityResolver resolver() { return request -> { HOST_RESOLVES.incrementAndGet(); throw new IllegalStateException("호출 금지"); }; }
        @Bean AiToolRegistration registration() { return AiToolRegistration.of("example.read", call -> { HOST_HANDLES.incrementAndGet(); return AiToolResultBoundaryTest.success(); }); }
        @Bean @Order(Ordered.LOWEST_PRECEDENCE) SecurityFilterChain business(HttpSecurity http) throws Exception {
            return http.authorizeHttpRequests(auth -> auth.anyRequest().denyAll()).build();
        }
    }
    @Test void realServletSecurityChainPrecedesHostAndDoesNotResolveCookieCsrfOrCreateSession() throws Exception {
        try (var f = new Fixture(directory)) {
            var p = f.properties; var properties = new LinkedHashMap<String, Object>(); String prefix = "nori.ai.integration.";
            properties.put("server.address", "127.0.0.1"); properties.put("server.port", "0"); properties.put("logging.level.root", "WARN"); properties.put("spring.main.banner-mode", "off");
            properties.put(prefix + "enabled", true); properties.put(prefix + "system-id", p.systemId()); properties.put(prefix + "issuer", p.issuer());
            properties.put(prefix + "gateway-base-url", p.gatewayBaseUrl()); properties.put(prefix + "service-token-file", p.serviceTokenFile().toString()); properties.put(prefix + "actor-private-jwk-file", p.actorPrivateJwkFile().toString());
            properties.put(prefix + "gateway-token-file", p.gatewayTokenFile().toString()); properties.put(prefix + "delegation-key-file", p.delegationKeyFile().toString());
            properties.put(prefix + "permission-codes[0]", "AI_READ"); properties.put(prefix + "permission-codes[1]", "AI_REVIEW"); properties.put(prefix + "review-permission", "AI_REVIEW");
            properties.put(prefix + "tools[0].id", "example.read"); properties.put(prefix + "tools[0].required-permissions[0]", "AI_READ");
            HOST_RESOLVES.set(0); HOST_HANDLES.set(0);
            try (var context = new SpringApplicationBuilder(Host.class).web(WebApplicationType.SERVLET).properties(properties).run(); var client = java.net.http.HttpClient.newHttpClient()) {
                String base = "http://127.0.0.1:" + ((WebServerApplicationContext) context).getWebServer().getPort();
                var now = Clock.systemUTC(); var codec = new AiDelegationCodec(p, now);
                var body = f.body(); body.put("delegationId", codec.issue("actor_SECRET_MARKER", Set.of("AI_READ"))).put("deadline", now.instant().plusSeconds(10).toString());
                var request = java.net.http.HttpRequest.newBuilder(java.net.URI.create(base + AiInternalQueryController.PATH))
                        .header("Content-Type", "application/json").header("Authorization", "Bearer " + f.token).header("Cookie", "JSESSIONID=ignored; token=SECRET_MARKER")
                        .header("X-Request-Id", body.get("jobId").asString()).header("X-Actor-Subject", body.get("subject").asString()).header("X-Delegation-Id", body.get("delegationId").asString())
                        .POST(java.net.http.HttpRequest.BodyPublishers.ofByteArray(PhaseTwoFixtures.JSON.writeValueAsBytes(body))).build();
                var response = client.send(request, java.net.http.HttpResponse.BodyHandlers.ofByteArray());
                assertThat(response.statusCode()).isEqualTo(200); assertThat(response.headers().allValues("Set-Cookie")).isEmpty();
                AiToolResultBoundaryTest.GatewayContract.accept(200, response.body());
                assertThat(HOST_RESOLVES).hasValue(0); assertThat(HOST_HANDLES).hasValue(1);
                var denied = client.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create(base + AiInternalQueryController.PATH)).GET().build(), java.net.http.HttpResponse.BodyHandlers.ofByteArray());
                assertThat(denied.statusCode()).isBetween(400, 499);
            }
        }
    }
}
