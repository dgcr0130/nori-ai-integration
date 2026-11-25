package example;

import static org.assertj.core.api.Assertions.assertThat;

import com.nori.ai.integration.api.AiRequestIdentityResolver;
import com.nori.ai.integration.api.AiToolRegistration;
import com.sun.net.httpserver.HttpServer;
import java.math.BigInteger;
import java.net.CookieManager;
import java.net.CookiePolicy;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.interfaces.ECPrivateKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.server.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.stereotype.Controller;
import tools.jackson.databind.json.JsonMapper;

/** 발행된 jar와 시스템의 최소 연결만 사용하는 HTTP 계약 시험이다. */
abstract class ConsumerContract {
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final List<Path> DIRECTORIES = new CopyOnWriteArrayList<>();
    @TempDir Path directory;
    abstract Class<?> application();
    abstract String systemId();
    abstract String issuer();
    abstract boolean cookie();

    @AfterAll static void temporaryCredentialsAndThreadsWereRemoved() {
        assertThat(DIRECTORIES).noneMatch(Files::exists);
        assertThat(Thread.getAllStackTraces().keySet()).noneMatch(thread -> thread.isAlive()
                && (thread.getName().startsWith("consumer-gateway-") || thread.getName().startsWith("nori-ai-")));
    }

    @Test void publishedJarOnlyConnectsIdentityCsrfSignedGatewayAndDelegatedHandler() throws Exception {
        DIRECTORIES.add(directory);
        var generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        var pair = generator.generateKeyPair();
        var pub = (ECPublicKey) pair.getPublic();
        var priv = (ECPrivateKey) pair.getPrivate();
        String service = UUID.randomUUID().toString();
        String gatewayToken = UUID.randomUUID().toString();
        String login = UUID.randomUUID().toString();
        byte[] key = new byte[32]; new java.security.SecureRandom().nextBytes(key);
        Files.writeString(directory.resolve("service"), service);
        Files.writeString(directory.resolve("gateway"), gatewayToken);
        Files.writeString(directory.resolve("delegation"), Base64.getUrlEncoder().withoutPadding().encodeToString(key));
        Files.writeString(directory.resolve("actor"), JSON.writeValueAsString(Map.of("kty", "EC", "crv", "P-256", "alg", "ES256",
                "kid", "example-test", "x", encode(pub.getW().getAffineX()), "y", encode(pub.getW().getAffineY()), "d", encode(priv.getS()))));
        var executor = Executors.newFixedThreadPool(2, Thread.ofPlatform().name("consumer-gateway-", 0).factory());
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(executor);
        var base = new AtomicReference<String>();
        var failures = new CopyOnWriteArrayList<Throwable>();
        var requests = new CopyOnWriteArrayList<String>();
        try (var callback = HttpClient.newHttpClient()) {
            server.createContext("/v1/query", exchange -> {
                try (exchange) {
                    assertThat(exchange.getRequestMethod()).isEqualTo("POST");
                    assertThat(exchange.getRequestHeaders().getFirst("Authorization")).isEqualTo("Bearer " + service);
                    assertThat(exchange.getRequestHeaders().getFirst("Cookie")).isNull();
                    String[] jws = exchange.getRequestHeaders().getFirst("X-Actor-Assertion").split("\\.");
                    var header = JSON.readTree(Base64.getUrlDecoder().decode(jws[0]));
                    assertThat(header.size()).isEqualTo(2);
                    assertThat(header.get("alg").asString()).isEqualTo("ES256");
                    assertThat(header.get("kid").asString()).isEqualTo("example-test");
                    var verifier = Signature.getInstance("SHA256withECDSAinP1363Format");
                    verifier.initVerify(pub); verifier.update((jws[0] + "." + jws[1]).getBytes(StandardCharsets.US_ASCII));
                    assertThat(verifier.verify(Base64.getUrlDecoder().decode(jws[2]))).isTrue();
                    var claims = JSON.readTree(Base64.getUrlDecoder().decode(jws[1]));
                    assertThat(claims.get("sys").asString()).isEqualTo(systemId());
                    assertThat(claims.get("iss").asString()).isEqualTo(issuer());
                    assertThat(claims.get("aud").asString()).isEqualTo("ai-gateway");
                    assertThat(claims.get("scope").asString()).isEqualTo("READ");
                    assertThat(claims.get("sub").asString()).isEqualTo("reader_1");
                    assertThat(claims.get("perm").toString()).isEqualTo("[\"DEMO_READ\"]");
                    assertThat(claims.get("exp").asLong() - claims.get("iat").asLong()).isEqualTo(60);
                    assertThat(claims.get("dlg").asString()).hasSize(119);
                    requests.add(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
                    String job = UUID.randomUUID().toString();
                    var body = JSON.createObjectNode().put("version", "1").put("systemId", systemId()).put("jobId", job)
                            .put("toolId", "demo.record.read").put("subject", claims.get("sub").asString())
                            .put("delegationId", claims.get("dlg").asString()).put("permissionDigest", claims.get("pdg").asString())
                            .put("deadline", Instant.now().plusSeconds(10).toString());
                    body.putObject("arguments"); body.putArray("targets");
                    var result = callback.send(HttpRequest.newBuilder(URI.create(base.get() + "/internal/ai/v1/query"))
                            .header("Authorization", "Bearer " + gatewayToken).header("Content-Type", "application/json")
                            .header("X-Request-Id", job).header("X-Actor-Subject", "reader_1")
                            .header("X-Delegation-Id", claims.get("dlg").asString())
                            .POST(HttpRequest.BodyPublishers.ofByteArray(JSON.writeValueAsBytes(body))).build(), HttpResponse.BodyHandlers.ofByteArray());
                    assertThat(result.statusCode()).isEqualTo(200);
                    var envelope = JSON.readTree(result.body());
                    assertThat(envelope.get("status").asString()).isEqualTo("SUCCESS");
                    assertThat(envelope.get("data").get("items").get(0).get("values").get("recordId").asString()).isEqualTo("1");
                    byte[] accepted = JSON.writeValueAsBytes(Map.of("jobId", job, "conversationId", "conversation_1", "messageId", "message_1", "queuePosition", 1));
                    exchange.getResponseHeaders().add("Content-Type", "application/json");
                    exchange.sendResponseHeaders(202, accepted.length); exchange.getResponseBody().write(accepted);
                } catch (Exception | AssertionError failure) {
                    // 별도 HTTP 스레드의 실패는 본 시험에서 다시 단언한다. 비밀을 로그에 출력하지 않는다.
                    failures.add(failure);
                }
            });
            server.start();
            var inputs = Map.<String, Object>ofEntries(
                    Map.entry("server.port", "0"), Map.entry("logging.level.root", "WARN"),
                    Map.entry("EXAMPLE_GATEWAY_URL", "http://127.0.0.1:" + server.getAddress().getPort()),
                    Map.entry("EXAMPLE_SERVICE_TOKEN_FILE", directory.resolve("service").toString()),
                    Map.entry("EXAMPLE_GATEWAY_TOKEN_FILE", directory.resolve("gateway").toString()),
                    Map.entry("EXAMPLE_ACTOR_JWK_FILE", directory.resolve("actor").toString()),
                    Map.entry("EXAMPLE_DELEGATION_KEY_FILE", directory.resolve("delegation").toString()),
                    Map.entry("EXAMPLE_LOGIN_PASSWORD", login), Map.entry("EXAMPLE_LOGIN_TOKEN", login));
            try (ConfigurableApplicationContext app = new SpringApplicationBuilder(application()).properties(inputs).run("--server.port=0")) {
                base.set("http://127.0.0.1:" + ((WebServerApplicationContext) app).getWebServer().getPort());
                assertThat(app.getBeansOfType(AiRequestIdentityResolver.class)).hasSize(1);
                assertThat(app.getBeansOfType(AiToolRegistration.class)).hasSize(1);
                assertThat(app.getBeansWithAnnotation(Controller.class).values()).noneMatch(bean -> bean.getClass().getPackageName().equals("example"));
                assertThat(app.getBeanDefinitionNames()).noneMatch(name -> name.toLowerCase(java.util.Locale.ROOT).matches(".*(delegationstore|permissionhook|proxycontroller).*"));
                String location = AiRequestIdentityResolver.class.getProtectionDomain().getCodeSource().getLocation().toString();
                assertThat(location.replace('\\', '/')).contains("/.m2/repository/com/nori/ai/ai-integration-spring-boot-starter/1.0.6/")
                        .endsWith("ai-integration-spring-boot-starter-1.0.6.jar");
                var cookies = new CookieManager(null, CookiePolicy.ACCEPT_ALL);
                try (var browser = HttpClient.newBuilder().cookieHandler(cookies).followRedirects(HttpClient.Redirect.NEVER).build()) {
                    assertThat(send(browser, base.get(), "GET", "/api/ai/assets/widget.js", "", List.of()).statusCode()).isEqualTo(200);
                    assertThat(send(browser, base.get(), "GET", "/api/ai/session", "", List.of()).statusCode()).isEqualTo(401);
                    List<String> auth = cookie() ? List.of() : List.of("Authorization", "Bearer " + login);
                    if (cookie()) login(browser, base.get(), login);
                    var session = send(browser, base.get(), "GET", "/api/ai/session", "", auth);
                    assertThat(session.statusCode()).isEqualTo(200);
                    var info = JSON.readTree(session.body());
                    assertThat(info.get("subject").asString()).isEqualTo("reader_1");
                    assertThat(info.get("canReview").asBoolean()).isFalse();
                    assertThat(info.get("integrationVersion").asString()).isEqualTo("1.0.6");
                    var headers = new java.util.ArrayList<>(auth);
                    if (cookie()) {
                        assertThat(send(browser, base.get(), "POST", "/api/ai/v1/query", "{}", auth).statusCode()).isEqualTo(403);
                        assertThat(requests).isEmpty();
                        assertThat(info.get("csrf").get("headerName").asString()).isEqualTo("X-Nori-AI-CSRF");
                        headers.add("X-Nori-AI-CSRF"); headers.add(info.get("csrf").get("token").asString());
                        assertThat(cookies.getCookieStore().getCookies()).anyMatch(value -> value.getName().equals("NORI_AI_XSRF") && value.getPath().equals("/"));
                    } else assertThat(info.get("csrf").isNull()).isTrue();
                    String query = "{\"query\":\"중립 자료 조회\",\"context\":{\"timezone\":\"UTC\",\"referenceTime\":\"2026-11-23T00:00:00+00:00\"}}";
                    var accepted = send(browser, base.get(), "POST", "/api/ai/v1/query", query, headers);
                    assertThat(failures).isEmpty(); assertThat(accepted.statusCode()).isEqualTo(202);
                    assertThat(requests).containsExactly(query);
                }
            }
        } finally {
            server.stop(0); executor.shutdownNow();
            assertThat(executor.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
        }
        assertThat(failures).isEmpty();
    }

    private static void login(HttpClient client, String base, String password) throws Exception {
        String html = send(client, base, "GET", "/login", "", List.of()).body();
        var matcher = Pattern.compile("name=\"_csrf\"[^>]*value=\"([^\"]+)\"").matcher(html);
        assertThat(matcher.find()).isTrue();
        String form = "username=reader_1&password=" + URLEncoder.encode(password, StandardCharsets.UTF_8)
                + "&_csrf=" + URLEncoder.encode(matcher.group(1), StandardCharsets.UTF_8);
        var result = client.send(HttpRequest.newBuilder(URI.create(base + "/login")).header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(form)).build(), HttpResponse.BodyHandlers.ofString());
        assertThat(result.statusCode()).isEqualTo(302);
        assertThat(result.headers().firstValue("Location").orElseThrow()).doesNotContain("error");
    }

    private static HttpResponse<String> send(HttpClient client, String base, String method, String path, String body, List<String> headers) throws Exception {
        var request = HttpRequest.newBuilder(URI.create(base + path)).header("Content-Type", "application/json")
                .method(method, body.isEmpty() ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body));
        if (!headers.isEmpty()) request.headers(headers.toArray(String[]::new));
        return client.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    private static String encode(BigInteger value) {
        byte[] input = value.toByteArray(); byte[] result = new byte[32]; int count = Math.min(32, input.length);
        System.arraycopy(input, input.length - count, result, 32 - count, count);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(result);
    }
}
