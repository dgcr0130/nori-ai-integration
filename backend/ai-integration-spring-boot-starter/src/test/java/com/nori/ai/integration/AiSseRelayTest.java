package com.nori.ai.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.nori.ai.integration.api.AiRequestIdentity;
import com.nori.ai.integration.config.AiIntegrationProperties.BrowserCredential;
import com.nori.ai.integration.web.AiSseRelay;
import com.sun.net.httpserver.HttpExchange;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Set;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class AiSseRelayTest {
    @TempDir static Path directory;
    PhaseTwoFixtures.Gateway gateway;
    PhaseTwoFixtures.App app;
    AiSseRelay relay;
    PhaseTwoFixtures.ManualTimers timers;

    @BeforeAll void start() throws Exception {
        gateway = new PhaseTwoFixtures.Gateway();
        app = new PhaseTwoFixtures.App(PhaseTwoFixtures.keys(directory, gateway.base(), BrowserCredential.HEADER,
                List.of("AI_READ", "AI_REVIEW")).properties());
        relay = app.context.getBean("controlledSse", AiSseRelay.class);
        timers = app.context.getBean(PhaseTwoFixtures.ManualTimers.class);
    }
    @BeforeEach void reset() { PhaseTwoFixtures.reset(); gateway.requests.clear(); }
    @AfterAll void stop() {
        if (app != null) app.close();
        if (gateway != null) gateway.close();
        PhaseTwoFixtures.assertNoThreads();
    }

    private HttpResponse<InputStream> connect() throws Exception {
        return app.client.send(HttpRequest.newBuilder(URI.create(app.base + "/api/ai/v1/analyses/job/events"))
                .header("Last-Event-ID", "prior-id").GET().build(), HttpResponse.BodyHandlers.ofInputStream());
    }

    @Test void delayedFirstEventKeepaliveReplayAndTerminalFlushArePreserved() throws Exception {
        try (var source = new Source()) {
            gateway.streaming = source;
            var response = connect();
            try (var input = response.body(); var lines = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
                assertThat(response.statusCode()).isEqualTo(200);
                assertThat(response.headers().firstValue("Cache-Control")).contains("no-cache");
                assertThat(response.headers().firstValue("X-Accel-Buffering")).contains("no");
                assertThat(response.headers().firstValue("Content-Type")).contains("text/event-stream");
                assertThat(response.headers().firstValue("Set-Cookie")).isEmpty();
                assertThat(gateway.requests.getFirst().header("Last-Event-ID")).isEqualTo("prior-id");
                assertThat(lines.readLine()).isEqualTo(": connected"); assertThat(lines.readLine()).isEmpty();
                int before = PhaseTwoFixtures.RESOLVES.get();
                timers.tick();
                assertThat(lines.readLine()).isEqualTo(": keepalive"); assertThat(lines.readLine()).isEmpty();
                assertThat(PhaseTwoFixtures.RESOLVES.get()).isEqualTo(before + 1);
                source.send("id: event-1\nevent: job.progress\ndata: 한글\ndata: second\n\n");
                assertThat(lines.readLine()).isEqualTo("id: event-1");
                assertThat(lines.readLine()).isEqualTo("event: job.progress");
                assertThat(lines.readLine()).isEqualTo("data: 한글"); assertThat(lines.readLine()).isEqualTo("data: second"); assertThat(lines.readLine()).isEmpty();
                source.send("id: event-2\nevent: job.completed\ndata: {\"result\":1}\n\n");
                assertThat(lines.readLine()).isEqualTo("id: event-2"); assertThat(lines.readLine()).isEqualTo("event: job.completed");
                assertThat(lines.readLine()).isEqualTo("data: {\"result\":1}"); assertThat(lines.readLine()).isEmpty();
                assertThat(lines.readLine()).isNull();
            }
            assertClean();
            source.detectDisconnect();
        } finally { gateway.streaming = null; }
    }

    @ParameterizedTest @ValueSource(strings = {"permissions", "subject", "logout", "exception", "invalid"})
    void continuousEventsCannotPostponeIndependentIdentityRecheck(String change) throws Exception {
        try (var source = new Source()) {
            gateway.streaming = source;
            var response = connect();
            try (var input = response.body(); var lines = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
                assertThat(lines.readLine()).isEqualTo(": connected"); assertThat(lines.readLine()).isEmpty();
                for (int index = 0; index < 5; index++) {
                    source.send("event: job.progress\ndata: continuous-" + index + "\n\n");
                    assertThat(lines.readLine()).isEqualTo("event: job.progress"); assertThat(lines.readLine()).isEqualTo("data: continuous-" + index); assertThat(lines.readLine()).isEmpty();
                }
                switch (change) {
                    case "permissions" -> PhaseTwoFixtures.IDENTITY.set(request -> new AiRequestIdentity(true, "fixture_subject", Set.of("AI_READ")));
                    case "subject" -> PhaseTwoFixtures.IDENTITY.set(request -> new AiRequestIdentity(true, "another_subject", Set.of("AI_READ", "AI_REVIEW")));
                    case "logout" -> PhaseTwoFixtures.IDENTITY.set(request -> new AiRequestIdentity(false, null, Set.of()));
                    case "exception" -> PhaseTwoFixtures.IDENTITY.set(request -> { throw new IllegalStateException("identity-secret-never-log"); });
                    case "invalid" -> PhaseTwoFixtures.IDENTITY.set(request -> null);
                    default -> throw new AssertionError(change);
                }
                timers.tick();
                assertThat(lines.readLine()).isNull();
            }
            assertClean(); source.detectDisconnect();
        } finally { gateway.streaming = null; }
    }

    @Test void outsideIntersectionPermissionChangesDoNotCloseStreamAnd180SecondDeadlineDoes() throws Exception {
        try (var source = new Source()) {
            gateway.streaming = source;
            var response = connect();
            try (var input = response.body(); var lines = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
                lines.readLine(); lines.readLine();
                PhaseTwoFixtures.IDENTITY.set(request -> new AiRequestIdentity(true, "fixture_subject", Set.of("AI_READ", "AI_REVIEW", "NEW_OUTSIDE")));
                timers.tick();
                assertThat(lines.readLine()).isEqualTo(": keepalive"); assertThat(lines.readLine()).isEmpty();
                assertThat(relay.activeConnections()).isEqualTo(1);
                timers.expire();
                assertThat(lines.readLine()).isNull();
            }
            assertClean(); source.detectDisconnect();
        } finally { gateway.streaming = null; }
    }

    @Test void browserDisconnectUpstreamEofAndErrorsReleaseTimersAndConnections() throws Exception {
        try (var source = new Source()) {
            gateway.streaming = source;
            disconnectAfterFirstEvent(connect());
            for (int index = 0; index < 20 && relay.activeConnections() > 0; index++) {
                source.send("data: " + "x".repeat(4096) + "\n\n");
            }
            await().atMost(Duration.ofSeconds(5)).until(() -> relay.activeConnections() == 0);
            assertClean();
        } finally { gateway.streaming = null; }
        try (var source = new Source()) {
            gateway.streaming = source;
            var response = connect();
            source.end();
            try (var input = response.body()) { assertThat(new String(input.readAllBytes(), StandardCharsets.UTF_8)).isEqualTo(": connected\n\n"); }
            assertClean();
        } finally { gateway.streaming = null; }
    }

    @Test void idleBrowserDisconnectIsReleasedByKeepaliveAndCompletedOnlyOnce() throws Exception {
        try (var source = new Source()) {
            gateway.streaming = source;
            disconnectAfterFirstEvent(connect());
            // 상류가 조용하면 브라우저 끊김은 다음 keepalive 쓰기에서만 드러난다. 그 쓰기 실패로 시작된 컨테이너 onError와
            // 타이머 스레드의 종료가 경합해도 AsyncContext 사용 오류 없이 자리와 상류 연결을 반납해야 한다.
            await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> {
                timers.tick();
                assertThat(relay.activeConnections()).isZero();
            });
            assertClean(); source.detectDisconnect();
        } finally { gateway.streaming = null; }
    }

    /** 첫 이벤트를 읽어 응답 구독이 생긴 뒤 닫는다. 구독 전 close()는 JDK가 연결 종료를 구독 시점으로 미루므로 브라우저가 닫힌 시점을 정할 수 없다. */
    private static void disconnectAfterFirstEvent(HttpResponse<InputStream> response) throws IOException {
        try (var input = response.body()) {
            assertThat(new String(input.readNBytes(13), StandardCharsets.UTF_8)).isEqualTo(": connected\n\n");
        }
    }

    @Test void slowNonblockingBrowserHasBoundedQueueAndNoLateWrites() throws Exception {
        var properties = PhaseTwoFixtures.keys(directory.resolve("slow"), gateway.base(), BrowserCredential.HEADER,
                List.of("AI_READ", "AI_REVIEW")).properties();
        try (var source = new Source(); var ownGateway = new com.nori.ai.integration.web.AiGatewayRelay(properties)) {
            gateway.streaming = source;
            var identities = new com.nori.ai.integration.security.AiIdentityService(request -> PhaseTwoFixtures.LOGGED_IN, properties);
            try (var own = new AiSseRelay(ownGateway, identities, new PhaseTwoFixtures.ManualTimers())) {
                var request = new MockHttpServletRequest("GET", "/api/ai/v1/analyses/job/events"); request.setAsyncSupported(true);
                var writes = new AtomicReference<jakarta.servlet.WriteListener>();
                var count = new java.util.concurrent.atomic.AtomicInteger();
                var response = new MockHttpServletResponse() {
                    @Override public jakarta.servlet.ServletOutputStream getOutputStream() {
                        return new jakarta.servlet.ServletOutputStream() {
                            @Override public boolean isReady() { return false; }
                            @Override public void setWriteListener(jakarta.servlet.WriteListener listener) { writes.set(listener); }
                            @Override public void write(int value) { count.incrementAndGet(); }
                        };
                    }
                };
                var log = new com.nori.ai.integration.observability.AiRequestLog(properties);
                own.start(request, response, ownGateway.prepare(request, "/v1/analyses/job/events", new byte[0], "fixture"),
                        identities.current(request), log);
                assertThat(source.started.await(5, TimeUnit.SECONDS)).isTrue();
                for (int index = 0; index < 20; index++) source.send("data: " + "x".repeat(4096) + "\n\n");
                await().atMost(Duration.ofSeconds(5)).until(() -> own.activeConnections() == 0);
                assertThat(own.pendingTimers()).isZero();
                writes.get().onWritePossible();
                assertThat(count).hasValue(0);
            }
        } finally { gateway.streaming = null; }
    }

    private void assertClean() {
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> {
            assertThat(relay.activeConnections()).isZero(); assertThat(relay.pendingTimers()).isZero();
        });
    }

    @Test void cleanupFailureStillReturnsConnectionSlotAndTimers() throws Exception {
        var properties = PhaseTwoFixtures.keys(directory.resolve("cleanup"), gateway.base(), BrowserCredential.HEADER,
                List.of("AI_READ", "AI_REVIEW")).properties();
        try (var source = new Source(); var ownGateway = new com.nori.ai.integration.web.AiGatewayRelay(properties)) {
            gateway.streaming = source;
            var identities = new com.nori.ai.integration.security.AiIdentityService(request -> PhaseTwoFixtures.LOGGED_IN, properties);
            var timers = new PhaseTwoFixtures.ManualTimers();
            try (var own = new AiSseRelay(ownGateway, identities, timers)) {
                var request = new MockHttpServletRequest("GET", "/api/ai/v1/analyses/job/events"); request.setAsyncSupported(true);
                var prepared = ownGateway.prepare(request, "/v1/analyses/job/events", new byte[0], "fixture");
                // 정리가 시작되면 ended가 되어 다시 정리할 기회가 없으므로, 정리 단계 하나가 실패해도 자리를 잃으면 안 됩니다.
                var failing = new org.apache.hc.client5.http.classic.methods.HttpUriRequestBase("GET", prepared.getUri()) {
                    @Override public boolean cancel() { super.cancel(); throw new IllegalStateException("cleanup-failure"); }
                };
                prepared.headerIterator().forEachRemaining(failing::addHeader);
                own.start(request, new MockHttpServletResponse(), failing, identities.current(request),
                        new com.nori.ai.integration.observability.AiRequestLog(properties));
                assertThat(source.started.await(5, TimeUnit.SECONDS)).isTrue();
                assertThat(own.activeConnections()).isEqualTo(1);
                org.assertj.core.api.Assertions.assertThatThrownBy(timers::expire).hasMessage("cleanup-failure");
                assertThat(own.activeConnections()).isZero();
                assertThat(own.pendingTimers()).isZero();
            }
        } finally { gateway.streaming = null; }
    }

    @Test void streamAdmissionDoesNotAccumulateMoreThan32ReadersOrTimers() throws Exception {
        var properties = PhaseTwoFixtures.keys(directory.resolve("bounded"), gateway.base(), BrowserCredential.HEADER,
                List.of("AI_READ", "AI_REVIEW")).properties();
        var release = new CountDownLatch(1);
        gateway.streaming = exchange -> {
            try (exchange) { release.await(); }
            catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
        };
        try (var ownGateway = new com.nori.ai.integration.web.AiGatewayRelay(properties)) {
            var identities = new com.nori.ai.integration.security.AiIdentityService(request -> PhaseTwoFixtures.LOGGED_IN, properties);
            try (var own = new AiSseRelay(ownGateway, identities, new PhaseTwoFixtures.ManualTimers())) {
                for (int index = 0; index < 34; index++) {
                    var request = new MockHttpServletRequest("GET", "/api/ai/v1/analyses/job/events"); request.setAsyncSupported(true);
                    var response = new MockHttpServletResponse();
                    own.start(request, response, ownGateway.prepare(request, "/v1/analyses/job/events", new byte[0], "fixture"),
                            identities.current(request), new com.nori.ai.integration.observability.AiRequestLog(properties));
                    if (index >= 32) assertThat(response.getStatus()).isEqualTo(503);
                }
                assertThat(own.activeConnections()).isEqualTo(32);
                assertThat(own.pendingTimers()).isEqualTo(64);
            }
        } finally { release.countDown(); gateway.streaming = null; }
    }

    private static final class Source implements Consumer<HttpExchange>, AutoCloseable {
        private static final String END = "\u0000END";
        private final BlockingQueue<String> frames = new LinkedBlockingQueue<>();
        private final CountDownLatch started = new CountDownLatch(1);
        private final CountDownLatch done = new CountDownLatch(1);
        private final CountDownLatch disconnected = new CountDownLatch(1);
        private final AtomicReference<Throwable> unexpected = new AtomicReference<>();
        @Override public void accept(HttpExchange exchange) {
            try (exchange) {
                exchange.getResponseHeaders().add("Content-Type", "text/event-stream");
                exchange.getResponseHeaders().add("Set-Cookie", "must-not-forward=true");
                exchange.sendResponseHeaders(200, 0);
                var output = exchange.getResponseBody();
                output.write(": connected\n\n".getBytes(StandardCharsets.UTF_8)); output.flush(); started.countDown();
                for (;;) {
                    String frame = frames.take(); if (frame.equals(END)) break;
                    output.write(frame.getBytes(StandardCharsets.UTF_8)); output.flush();
                }
            } catch (IOException closed) { disconnected.countDown(); }
            catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); unexpected.set(interrupted); }
            finally { done.countDown(); }
        }
        void send(String frame) { frames.add(frame); }
        void end() { frames.add(END); }
        void detectDisconnect() throws InterruptedException {
            for (int index = 0; index < 16; index++) send("data: " + "x".repeat(4096) + "\n\n");
            assertThat(disconnected.await(5, TimeUnit.SECONDS)).isTrue();
        }
        @Override public void close() {
            end();
            try { if (started.getCount() == 0) assertThat(done.await(5, TimeUnit.SECONDS)).isTrue(); }
            catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new AssertionError(interrupted); }
            assertThat(unexpected.get()).isNull();
        }
    }
}
