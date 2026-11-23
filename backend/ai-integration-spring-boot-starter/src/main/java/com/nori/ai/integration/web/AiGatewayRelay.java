package com.nori.ai.integration.web;

import com.nori.ai.integration.config.AiIntegrationProperties;
import com.nori.ai.integration.observability.AiRequestLog;
import com.nori.ai.integration.security.AiIdentityService.Failure;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.apache.hc.client5.http.classic.methods.HttpUriRequestBase;
import org.apache.hc.client5.http.config.ConnectionConfig;
import org.apache.hc.client5.http.config.RequestConfig;
import org.apache.hc.client5.http.impl.classic.CloseableHttpClient;
import org.apache.hc.client5.http.impl.classic.HttpClients;
import org.apache.hc.client5.http.impl.io.PoolingHttpClientConnectionManagerBuilder;
import org.apache.hc.core5.http.ClassicHttpResponse;
import org.apache.hc.core5.http.ContentType;
import org.apache.hc.core5.http.io.entity.ByteArrayEntity;
import org.apache.hc.core5.util.Timeout;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

public final class AiGatewayRelay implements AutoCloseable {
    private static final int CONNECT_SECONDS = 2;
    private static final int RESPONSE_SECONDS = 180;
    private static final Set<String> REQUEST_HEADERS = Set.of("Content-Type", "Accept", "Idempotency-Key", "Last-Event-ID");
    private static final Set<String> RESPONSE_HEADERS = Set.of("content-type", "retry-after", "x-request-id",
            "x-gateway-request-id", "x-job-id", "content-disposition", "content-language", "content-encoding", "x-accel-buffering");
    private final AiIntegrationProperties properties;
    private final String serviceToken;
    private final CloseableHttpClient client;
    private final JsonMapper json = JsonMapper.builder().build();
    private final ScheduledThreadPoolExecutor deadlines;

    public AiGatewayRelay(AiIntegrationProperties properties) {
        this(properties, new ScheduledThreadPoolExecutor(1,
                Thread.ofPlatform().daemon().name("nori-ai-http-deadline-", 0).factory()));
    }

    public AiGatewayRelay(AiIntegrationProperties properties, ScheduledThreadPoolExecutor deadlines) {
        this.properties = properties;
        this.deadlines = deadlines;
        deadlines.setRemoveOnCancelPolicy(true);
        try { serviceToken = Files.readString(properties.serviceTokenFile()).strip(); }
        catch (IOException failure) { throw new IllegalStateException("AI 서비스 자격을 읽을 수 없습니다."); }
        var manager = PoolingHttpClientConnectionManagerBuilder.create().setMaxConnTotal(64).setMaxConnPerRoute(64)
                .setDefaultConnectionConfig(ConnectionConfig.custom().setConnectTimeout(Timeout.ofSeconds(CONNECT_SECONDS))
                        .setSocketTimeout(Timeout.ofSeconds(RESPONSE_SECONDS)).build()).build();
        client = HttpClients.custom().setConnectionManager(manager).disableAutomaticRetries().disableRedirectHandling()
                .disableCookieManagement().disableContentCompression()
                .setDefaultRequestConfig(RequestConfig.custom().setConnectionRequestTimeout(Timeout.ofSeconds(CONNECT_SECONDS))
                        .setResponseTimeout(Timeout.ofSeconds(RESPONSE_SECONDS)).build()).build();
    }

    public HttpUriRequestBase prepare(HttpServletRequest browser, String path, byte[] body, String assertion) {
        String query = browser.getQueryString();
        final URI target;
        try { target = URI.create(properties.gatewayBaseUrl() + path + (query == null ? "" : "?" + query)); }
        catch (IllegalArgumentException invalid) { throw new Failure(400, "INPUT_INVALID", "relay"); }
        var request = new HttpUriRequestBase(browser.getMethod(), target);
        Set<String> connectionHeaders = new HashSet<>();
        var connections = browser.getHeaders("Connection");
        while (connections.hasMoreElements()) {
            Arrays.stream(connections.nextElement().split(",")).map(String::strip).map(value -> value.toLowerCase(Locale.ROOT))
                    .forEach(connectionHeaders::add);
        }
        for (String name : REQUEST_HEADERS) {
            if (connectionHeaders.contains(name.toLowerCase(Locale.ROOT))) continue;
            var values = browser.getHeaders(name);
            while (values.hasMoreElements()) request.addHeader(name, values.nextElement());
        }
        request.setHeader("Authorization", "Bearer " + serviceToken);
        request.setHeader("X-Actor-Assertion", assertion);
        if (body.length > 0) request.setEntity(new ByteArrayEntity(body, (ContentType) null));
        return request;
    }

    public ClassicHttpResponse open(HttpUriRequestBase request) throws IOException {
        return client.executeOpen(null, request, null);
    }

    public void copyHeaders(ClassicHttpResponse upstream, HttpServletResponse browser, AiRequestLog log) {
        Set<String> connectionHeaders = new HashSet<>();
        for (var header : upstream.getHeaders("Connection")) {
            Arrays.stream(header.getValue().split(",")).map(String::strip).map(value -> value.toLowerCase(Locale.ROOT))
                    .forEach(connectionHeaders::add);
        }
        browser.setStatus(upstream.getCode());
        for (var header : upstream.getHeaders()) {
            String lower = header.getName().toLowerCase(Locale.ROOT);
            if (RESPONSE_HEADERS.contains(lower) && !connectionHeaders.contains(lower) && !lower.equals("x-request-id")) {
                browser.addHeader(header.getName(), header.getValue());
            }
        }
        browser.setHeader("Cache-Control", "no-store");
        browser.setHeader("X-Request-Id", log.requestId());
    }

    public void ordinary(HttpUriRequestBase request, HttpServletResponse browser, AiRequestLog log) throws IOException {
        var expired = new AtomicBoolean();
        var deadline = deadlines.schedule(() -> { expired.set(true); request.cancel(); }, RESPONSE_SECONDS, TimeUnit.SECONDS);
        final byte[] body;
        try (var upstream = open(request)) {
            body = upstream.getEntity() == null ? new byte[0] : upstream.getEntity().getContent().readAllBytes();
            if (expired.get()) throw new SocketTimeoutException();
            copyHeaders(upstream, browser, log);
            record(upstream.getCode(), body, log);
        } catch (SocketTimeoutException failure) {
            log.error(browser, new Failure(504, "GATEWAY_TIMEOUT", "connect"));
            return;
        } catch (IOException failure) {
            log.error(browser, expired.get() ? new Failure(504, "GATEWAY_TIMEOUT", "connect")
                    : new Failure(503, "GATEWAY_UNAVAILABLE", "connect"));
            return;
        } finally { deadline.cancel(false); request.cancel(); }
        try { browser.getOutputStream().write(body); }
        catch (IOException disconnected) {
            log.record("relay", browser.getStatus(), null, null, null);
            throw disconnected;
        }
    }

    public void record(int status, byte[] body, AiRequestLog log) {
        JsonNode node = null;
        try { if (body.length > 0) node = json.readTree(body); }
        catch (tools.jackson.core.JacksonException invalidJson) {
            // 내보내기·빈 오류 본문은 JSON이 아닐 수 있다. 본문과 파서 예외는 기록하지 않는다.
            log.record("relay", status, null, null, null);
            return;
        }
        String code = text(node, "code");
        if (code == null) code = text(node, "errorCode");
        if (code == null) code = text(node, "error");
        log.record("relay", status, code, status >= 400 ? text(node, "requestId") : null, text(node, "jobId"));
    }

    private static String text(JsonNode node, String field) {
        var value = node == null ? null : node.get(field);
        return value != null && value.isString() ? value.asString() : null;
    }

    @Override public void close() throws IOException {
        deadlines.shutdownNow();
        client.close();
        try {
            if (!deadlines.awaitTermination(5, TimeUnit.SECONDS)) throw new IOException("AI HTTP 타이머가 종료되지 않았습니다.");
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IOException("AI HTTP 타이머 종료가 중단되었습니다.");
        }
    }
}
