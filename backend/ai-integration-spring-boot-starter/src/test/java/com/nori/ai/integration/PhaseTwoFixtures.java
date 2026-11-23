package com.nori.ai.integration;

import com.nori.ai.integration.api.AiRequestIdentity;
import com.nori.ai.integration.api.AiRequestIdentityResolver;
import com.nori.ai.integration.config.AiIntegrationProperties;
import com.nori.ai.integration.security.AiActorSigner;
import com.nori.ai.integration.security.AiDelegationCodec;
import com.nori.ai.integration.security.AiIdentityService;
import com.nori.ai.integration.web.AiGatewayRelay;
import com.nori.ai.integration.web.AiSseRelay;
import com.sun.net.httpserver.HttpServer;
import jakarta.servlet.Filter;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.math.BigInteger;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.interfaces.ECPrivateKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.server.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.access.intercept.AuthorizationFilter;
import tools.jackson.databind.json.JsonMapper;

final class PhaseTwoFixtures {
    static final JsonMapper JSON = JsonMapper.builder().build();
    static final Instant NOW = Instant.parse("2026-11-23T00:00:00Z");
    static final AiRequestIdentity LOGGED_IN = new AiRequestIdentity(true, "fixture_subject", Set.of("AI_READ", "AI_REVIEW", "OTHER"));
    static final AtomicReference<Function<HttpServletRequest, AiRequestIdentity>> IDENTITY = new AtomicReference<>(request -> LOGGED_IN);
    static final AtomicReference<Clock> SIGN_CLOCK = new AtomicReference<>(Clock.fixed(NOW, ZoneOffset.UTC));
    static final AtomicInteger RESOLVES = new AtomicInteger();
    static final AtomicInteger BUSINESS = new AtomicInteger();

    private PhaseTwoFixtures() {}

    record Keys(AiIntegrationProperties properties, KeyPair pair) {}
    static Keys keys(Path directory, String base, AiIntegrationProperties.BrowserCredential mode, List<String> permissions) throws Exception {
        System.out.println("PHASE2_TEMP_DIRECTORY=" + directory.toAbsolutePath());
        Files.createDirectories(directory);
        var generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        var pair = generator.generateKeyPair();
        var pub = (ECPublicKey) pair.getPublic();
        var priv = (ECPrivateKey) pair.getPrivate();
        Files.writeString(directory.resolve("service"), " \nfixture-service-credential-never-log\n ");
        byte[] hmac = new byte[32];
        new java.security.SecureRandom().nextBytes(hmac);
        Files.writeString(directory.resolve("delegation"), Base64.getUrlEncoder().withoutPadding().encodeToString(hmac));
        Files.writeString(directory.resolve("actor"), JSON.writeValueAsString(Map.of("kty", "EC", "crv", "P-256", "alg", "ES256",
                "kid", "fixture", "x", encode(pub.getW().getAffineX()), "y", encode(pub.getW().getAffineY()), "d", encode(priv.getS()))));
        return new Keys(new AiIntegrationProperties(true, mode, "Example_1", "example-backend", base,
                directory.resolve("service"), directory.resolve("actor"), null, directory.resolve("delegation"), permissions,
                permissions.getFirst(), List.of()), pair);
    }
    private static String encode(BigInteger value) {
        byte[] input = value.toByteArray();
        byte[] result = new byte[32];
        int count = Math.min(32, input.length);
        System.arraycopy(input, input.length - count, result, 32 - count, count);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(result);
    }

    record Recorded(String method, String path, Map<String, List<String>> headers, byte[] body) {
        Recorded { headers = Map.copyOf(headers); body = body.clone(); }
        @Override public byte[] body() { return body.clone(); }
        String header(String name) { return headers.entrySet().stream().filter(entry -> entry.getKey().equalsIgnoreCase(name))
                .findFirst().map(entry -> entry.getValue().getFirst()).orElse(null); }
    }

    static final class Gateway implements AutoCloseable {
        final HttpServer server;
        final ExecutorService executor = Executors.newFixedThreadPool(4, Thread.ofPlatform().name("phase2-gateway-", 0).factory());
        final List<Recorded> requests = new CopyOnWriteArrayList<>();
        volatile int status = 202;
        volatile byte[] body = "{\"jobId\":\"12d55b20-b2e1-42d0-8e6f-fd151206f433\",\"conversationId\":\"conversation\",\"messageId\":\"message\",\"queuePosition\":1}".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        volatile String contentType = "application/json";
        volatile String contentEncoding;
        volatile java.util.function.Consumer<com.sun.net.httpserver.HttpExchange> streaming;
        Gateway() throws IOException {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.setExecutor(executor);
            server.createContext("/", exchange -> {
                requests.add(new Recorded(exchange.getRequestMethod(), exchange.getRequestURI().toASCIIString(),
                        exchange.getRequestHeaders(), exchange.getRequestBody().readAllBytes()));
                if (streaming != null) { streaming.accept(exchange); return; }
                try (exchange) {
                    exchange.getResponseHeaders().add("Content-Type", contentType);
                    if (contentEncoding != null) exchange.getResponseHeaders().add("Content-Encoding", contentEncoding);
                    exchange.getResponseHeaders().add("Retry-After", "7");
                    exchange.getResponseHeaders().add("X-Request-Id", "0f5f4155-cd17-4921-800d-d1b948dbb4a0");
                    exchange.getResponseHeaders().add("X-Job-Id", "12d55b20-b2e1-42d0-8e6f-fd151206f433");
                    exchange.getResponseHeaders().add("Set-Cookie", "upstream-secret=never-forward");
                    exchange.getResponseHeaders().add("Authorization", "Bearer never-forward");
                    exchange.getResponseHeaders().add("X-Actor-Assertion", "never-forward");
                    if (status == 302) exchange.getResponseHeaders().add("Location", base() + "/must-not-follow");
                    exchange.getResponseHeaders().add("Connection", "X-Accel-Buffering");
                    exchange.getResponseHeaders().add("X-Accel-Buffering", "upstream-hop-secret");
                    exchange.sendResponseHeaders(status, status == 204 ? -1 : body.length);
                    if (status != 204) exchange.getResponseBody().write(body);
                }
            });
            server.start();
        }
        String base() { return "http://127.0.0.1:" + server.getAddress().getPort(); }
        @Override public void close() {
            server.stop(0);
            executor.shutdownNow();
            try { if (!executor.awaitTermination(5, TimeUnit.SECONDS)) throw new IllegalStateException("대역 스레드 잔여"); }
            catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new IllegalStateException(interrupted); }
        }
    }

    static final class Front implements AutoCloseable {
        final HttpServer server;
        final ExecutorService executor = Executors.newSingleThreadExecutor(Thread.ofPlatform().name("phase2-front").factory());
        final HttpClient client = HttpClient.newHttpClient();
        Front(App app) throws IOException {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.setExecutor(executor);
            server.createContext("/prefix/api/ai/", exchange -> {
                try (exchange) {
                    String target = exchange.getRequestURI().toASCIIString().substring("/prefix".length());
                    var input = HttpRequest.newBuilder(URI.create(app.base + target)).method(exchange.getRequestMethod(),
                            HttpRequest.BodyPublishers.ofByteArray(exchange.getRequestBody().readAllBytes()));
                    for (String name : List.of("Cookie", "X-Nori-AI-CSRF", "X-Login", "Content-Type")) {
                        for (String value : exchange.getRequestHeaders().getOrDefault(name, List.of())) input.header(name, value);
                    }
                    try {
                        var result = client.send(input.build(), HttpResponse.BodyHandlers.ofByteArray());
                        for (String name : List.of("Set-Cookie", "Content-Type", "Cache-Control", "X-Request-Id")) {
                            for (String value : result.headers().allValues(name)) exchange.getResponseHeaders().add(name, value);
                        }
                        exchange.sendResponseHeaders(result.statusCode(), result.body().length);
                        exchange.getResponseBody().write(result.body());
                    } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new IOException("앞단 시험 중단"); }
                }
            });
            server.start();
        }
        URI uri(String suffix) { return URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/prefix/api/ai" + suffix); }
        @Override public void close() {
            server.stop(0); client.close(); executor.shutdownNow();
            try { if (!executor.awaitTermination(5, TimeUnit.SECONDS)) throw new IllegalStateException("앞단 스레드 잔여"); }
            catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new IllegalStateException("앞단 종료 중단"); }
        }
    }

    static final class ManualTimers extends ScheduledThreadPoolExecutor {
        final List<Runnable> ticks = new CopyOnWriteArrayList<>();
        final List<Runnable> deadlines = new CopyOnWriteArrayList<>();
        ManualTimers() { super(1, Thread.ofPlatform().name("phase2-manual-timer-", 0).factory()); }
        @Override public ScheduledFuture<?> scheduleAtFixedRate(Runnable command, long initialDelay, long period, TimeUnit unit) {
            if (unit.toSeconds(initialDelay) != 15 || unit.toSeconds(period) != 15) throw new AssertionError("15초 계약");
            ticks.add(command);
            return super.scheduleAtFixedRate(command, 1, 1, TimeUnit.DAYS);
        }
        @Override public ScheduledFuture<?> schedule(Runnable command, long delay, TimeUnit unit) {
            if (unit.toSeconds(delay) == 180) deadlines.add(command);
            return super.schedule(command, 1, TimeUnit.DAYS);
        }
        void tick() { ticks.forEach(Runnable::run); }
        void expire() { deadlines.forEach(Runnable::run); }
    }

    @Configuration(proxyBeanMethods = false)
    @EnableAutoConfiguration
    static class Host {
        @Bean AiRequestIdentityResolver resolver() {
            return request -> { RESOLVES.incrementAndGet(); return IDENTITY.get().apply(request); };
        }
        @Bean @Primary AiActorSigner controlledSigner(AiIntegrationProperties properties, AiDelegationCodec codec) {
            Clock clock = new Clock() {
                @Override public java.time.ZoneId getZone() { return ZoneOffset.UTC; }
                @Override public Clock withZone(java.time.ZoneId zone) { return this; }
                @Override public Instant instant() { return SIGN_CLOCK.get().instant(); }
            };
            return new AiActorSigner(properties, codec, clock);
        }
        @Bean ManualTimers testTimers() { return new ManualTimers(); }
        @Bean @Primary AiSseRelay controlledSse(AiGatewayRelay gateway, AiIdentityService identities, ManualTimers timers) {
            return new AiSseRelay(gateway, identities, timers);
        }
        @Bean @Order(Ordered.HIGHEST_PRECEDENCE + 50)
        SecurityFilterChain internalFixture(HttpSecurity http) throws Exception {
            return http.securityMatcher("/internal/**").csrf(csrf -> csrf.disable()).authorizeHttpRequests(auth -> auth.anyRequest().permitAll())
                    .addFilterBefore((Filter) (request, response, chain) -> ((HttpServletResponse) response).setStatus(418), AuthorizationFilter.class).build();
        }
        @Bean @Order(Ordered.LOWEST_PRECEDENCE)
        SecurityFilterChain businessFixture(HttpSecurity http) throws Exception {
            return http.authorizeHttpRequests(auth -> auth.requestMatchers("/business-protected").authenticated()
                            .requestMatchers("/business-denied").denyAll().anyRequest().permitAll())
                    .exceptionHandling(errors -> errors.authenticationEntryPoint((request, response, failure) -> response.setStatus(401)))
                    .addFilterBefore((Filter) (request, response, chain) -> {
                        if ("yes".equals(((HttpServletRequest) request).getHeader("X-Host-Authenticated"))) {
                            var context = org.springframework.security.core.context.SecurityContextHolder.createEmptyContext();
                            context.setAuthentication(org.springframework.security.authentication.UsernamePasswordAuthenticationToken
                                    .authenticated("fixture-host", "", List.of()));
                            org.springframework.security.core.context.SecurityContextHolder.setContext(context);
                        }
                        try { chain.doFilter(request, response); }
                        finally { org.springframework.security.core.context.SecurityContextHolder.clearContext(); }
                    }, org.springframework.security.web.access.ExceptionTranslationFilter.class)
                    .addFilterAfter((Filter) (request, response, chain) -> {
                        // Boot의 ERROR 재디스패치에서는 원래 거절 상태를 MVC 오류 처리에 맡긴다.
                        if (request.getDispatcherType() == jakarta.servlet.DispatcherType.ERROR) {
                            chain.doFilter(request, response);
                            return;
                        }
                        BUSINESS.incrementAndGet();
                        ((HttpServletResponse) response).setStatus(202); }, AuthorizationFilter.class).build();
        }
    }

    static final class App implements AutoCloseable {
        final ConfigurableApplicationContext context;
        final String base;
        final HttpClient client = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();
        App(AiIntegrationProperties properties) {
            String prefix = "nori.ai.integration.";
            var inputs = new java.util.LinkedHashMap<String, Object>();
            inputs.put("server.address", "127.0.0.1"); inputs.put("server.port", "0");
            inputs.put("spring.main.banner-mode", "off");
            inputs.put("logging.level.root", "WARN");
            inputs.put(prefix + "enabled", "true");
            inputs.put(prefix + "browser-credential", properties.browserCredential().name());
            inputs.put(prefix + "system-id", properties.systemId()); inputs.put(prefix + "issuer", properties.issuer());
            inputs.put(prefix + "gateway-base-url", properties.gatewayBaseUrl());
            inputs.put(prefix + "service-token-file", properties.serviceTokenFile().toString());
            inputs.put(prefix + "actor-private-jwk-file", properties.actorPrivateJwkFile().toString());
            inputs.put(prefix + "delegation-key-file", properties.delegationKeyFile().toString());
            for (int index = 0; index < properties.permissionCodes().size(); index++) inputs.put(prefix + "permission-codes[" + index + "]", properties.permissionCodes().get(index));
            inputs.put(prefix + "review-permission", "AI_REVIEW");
            context = new SpringApplicationBuilder(Host.class).web(WebApplicationType.SERVLET).properties(inputs).run();
            base = "http://127.0.0.1:" + ((WebServerApplicationContext) context).getWebServer().getPort();
        }
        HttpResponse<byte[]> send(String method, String path, byte[] body, String... headers) throws IOException, InterruptedException {
            var request = HttpRequest.newBuilder(URI.create(base + path)).method(method,
                    body.length == 0 ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofByteArray(body));
            if (headers.length > 0) request.headers(headers);
            return client.send(request.build(), HttpResponse.BodyHandlers.ofByteArray());
        }
        @Override public void close() { client.close(); context.close(); }
    }

    static void reset() {
        IDENTITY.set(request -> LOGGED_IN);
        SIGN_CLOCK.set(Clock.fixed(NOW, ZoneOffset.UTC));
        RESOLVES.set(0); BUSINESS.set(0);
    }
    static void assertNoThreads() {
        org.assertj.core.api.Assertions.assertThat(Thread.getAllStackTraces().keySet()).noneMatch(thread -> thread.isAlive()
                && (thread.getName().startsWith("nori-ai-") || thread.getName().startsWith("phase2-")));
    }
}
