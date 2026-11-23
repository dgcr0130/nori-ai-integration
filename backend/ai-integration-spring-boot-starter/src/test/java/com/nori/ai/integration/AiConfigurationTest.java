package com.nori.ai.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.nori.ai.integration.api.AiRequestIdentity;
import com.nori.ai.integration.api.AiRequestIdentityResolver;
import com.nori.ai.integration.api.AiToolCall;
import com.nori.ai.integration.api.AiToolItem;
import com.nori.ai.integration.api.AiToolRegistration;
import com.nori.ai.integration.api.AiToolResult;
import com.nori.ai.integration.config.AiIntegrationAutoConfiguration;
import com.nori.ai.integration.config.AiIntegrationProperties;
import java.io.IOException;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.interfaces.ECPrivateKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.env.PropertiesPropertySourceLoader;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.boot.security.autoconfigure.SecurityAutoConfiguration;
import org.springframework.boot.security.autoconfigure.web.servlet.ServletWebSecurityAutoConfiguration;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Bean;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.web.servlet.config.annotation.EnableWebMvc;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.io.FileSystemResource;

@ExtendWith(OutputCaptureExtension.class)
class AiConfigurationTest {
    private static final String PREFIX = "nori.ai.integration.";
    private static final String TOKEN_MARKER = "fixture-service-token-never-log";
    private static final List<Path> TEMPORARY_DIRECTORIES = new ArrayList<>();
    private static final AiRequestIdentityResolver RESOLVER = request -> new AiRequestIdentity(false, null, Set.of());
    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(AiIntegrationAutoConfiguration.class));
    @TempDir
    Path directory;
    private Map<String, Object> valid;
    private String jwk;

    @BeforeEach
    void prepare() throws IOException, GeneralSecurityException {
        TEMPORARY_DIRECTORIES.add(directory);
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair pair = generator.generateKeyPair();
        ECPublicKey publicKey = (ECPublicKey) pair.getPublic();
        ECPrivateKey privateKey = (ECPrivateKey) pair.getPrivate();
        jwk = "{\"kty\":\"EC\",\"crv\":\"P-256\",\"alg\":\"ES256\",\"kid\":\"fixture\","
                + "\"x\":\"" + encode(publicKey.getW().getAffineX()) + "\",\"y\":\""
                + encode(publicKey.getW().getAffineY()) + "\",\"d\":\"" + encode(privateKey.getS()) + "\"}";
        valid = new LinkedHashMap<>();
        valid.put(PREFIX + "enabled", "true");
        valid.put(PREFIX + "system-id", "Example_1");
        valid.put(PREFIX + "issuer", "example-backend");
        valid.put(PREFIX + "gateway-base-url", "https://gateway.test:443");
        valid.put(PREFIX + "service-token-file", file("service-token", " \r\n" + TOKEN_MARKER + "\t\n").toString());
        valid.put(PREFIX + "actor-private-jwk-file", file("actor.jwk", jwk).toString());
        valid.put(PREFIX + "delegation-key-file", file("delegation-key", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").toString());
        valid.put(PREFIX + "permission-codes[0]", "AI_READ");
        valid.put(PREFIX + "permission-codes[1]", "AI_REVIEW");
        valid.put(PREFIX + "review-permission", "AI_REVIEW");
    }

    @AfterAll
    static void temporaryDirectoriesWereRemoved() {
        assertThat(TEMPORARY_DIRECTORIES).allMatch(path -> !Files.exists(path));
    }

    @Test
    void disabledByDefaultDoesNotAddBeansOrReadInvalidConfiguration() {
        ApplicationContextRunner baseline = new ApplicationContextRunner().withBean("existingBusinessBean", Object.class, Object::new);
        baseline.run(original -> baseline.withConfiguration(AutoConfigurations.of(AiIntegrationAutoConfiguration.class))
                .withPropertyValues(PREFIX + "service-token-file=missing", PREFIX + "unknown=ignored-while-disabled")
                .run(context -> {
                    assertThat(context).hasNotFailed().doesNotHaveBean(AiIntegrationProperties.class);
                    assertThat(context.getBeanDefinitionNames()).containsExactlyInAnyOrder(original.getBeanDefinitionNames());
                }));
    }

    @Test
    void explicitDisabledDoesNotRequireResolver() {
        runner.withPropertyValues(PREFIX + "enabled=false").run(context ->
                assertThat(context).hasNotFailed().doesNotHaveBean(AiIntegrationProperties.class));
    }

    @Test
    void emptyToolsAndNoHandlersStartAndCollectionsAreImmutable() {
        configured(valid).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.containsBean("aiHostSecurityChainValidator")).isFalse();
            AiIntegrationProperties properties = context.getBean(AiIntegrationProperties.class);
            assertThat(properties.tools()).isEmpty();
            assertThat(properties.browserCredential()).isEqualTo(AiIntegrationProperties.BrowserCredential.COOKIE);
            assertThatThrownBy(() -> properties.permissionCodes().add("OTHER")).isInstanceOf(UnsupportedOperationException.class);
            assertThatThrownBy(() -> properties.tools().add(new AiIntegrationProperties.Tool("x", List.of())))
                    .isInstanceOf(UnsupportedOperationException.class);
        });
    }

    @Test
    void headerCredentialAndMaximumPermissionTableStart() {
        valid.put(PREFIX + "browser-credential", "HEADER");
        for (int index = 2; index < 256; index++) valid.put(PREFIX + "permission-codes[" + index + "]", "CODE_" + index);
        configured(valid).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(AiIntegrationProperties.class).permissionCodes()).hasSize(256);
        });
    }

    @ParameterizedTest(name = "[{index}]")
    @ValueSource(strings = {"system-id", "issuer", "gateway-base-url", "service-token-file", "actor-private-jwk-file",
            "delegation-key-file", "review-permission"})
    void missingRequiredConfigurationFails(String key) {
        valid.remove(PREFIX + key);
        assertFailure(valid);
    }

    @ParameterizedTest(name = "[{index}]")
    @ValueSource(strings = {"system-id", "issuer", "gateway-base-url", "service-token-file", "actor-private-jwk-file",
            "delegation-key-file", "review-permission"})
    void blankRequiredConfigurationFails(String key) {
        valid.put(PREFIX + key, " ");
        assertFailure(valid);
    }

    static Stream<String[]> invalidSettings() {
        return Stream.of(
                new String[]{"enabled", "yes"}, new String[]{"browser-credential", "BOTH"},
                new String[]{"system-id", "_invalid"}, new String[]{"system-id", "x".repeat(65)},
                new String[]{"issuer", "x".repeat(129)}, new String[]{"gateway-base-url", "/relative"},
                new String[]{"gateway-base-url", "ftp://gateway.test"}, new String[]{"gateway-base-url", "https://user:pass@gateway.test"},
                new String[]{"gateway-base-url", "https://gateway.test/path"}, new String[]{"gateway-base-url", "https://gateway.test/"},
                new String[]{"gateway-base-url", "https://gateway.test?query"}, new String[]{"gateway-base-url", "https://gateway.test#fragment"},
                new String[]{"gateway-base-url", "https://gateway.test:99999"}, new String[]{"gateway-base-url", "http://"},
                new String[]{"permission-codes[0]", "lowercase"}, new String[]{"permission-codes[0]", "X".repeat(65)},
                new String[]{"permission-codes[1]", "AI_READ"}, new String[]{"review-permission", "NOT_REGISTERED"},
                new String[]{"unknown-field", "unexpected"}, new String[]{"tools[0].id", "bad/id"});
    }

    @ParameterizedTest(name = "[{index}]")
    @MethodSource("invalidSettings")
    void malformedOrUnknownSettingsFail(String key, String value) {
        valid.put(PREFIX + key, value);
        assertFailure(valid);
    }

    @Test
    void permissionTableMustHaveOneTo256UniqueCodes() {
        Map<String, Object> empty = new LinkedHashMap<>(valid);
        empty.keySet().removeIf(key -> key.startsWith(PREFIX + "permission-codes"));
        assertFailure(empty);
        for (int index = 2; index < 257; index++) valid.put(PREFIX + "permission-codes[" + index + "]", "CODE_" + index);
        assertFailure(valid);
    }

    @ParameterizedTest(name = "[{index}]")
    @ValueSource(strings = {"service-token-file", "actor-private-jwk-file", "delegation-key-file", "gateway-token-file"})
    void unreadableMissingOrDirectoryCredentialsFail(String key) {
        valid.put(PREFIX + key, directory.resolve("missing").toString());
        assertFailure(valid);
        valid.put(PREFIX + key, directory.toString());
        assertFailure(valid);
    }

    @ParameterizedTest(name = "[{index}]")
    @ValueSource(strings = {"", " \n\t", "two tokens", "two\ttokens", "two\ntokens", "two\rtokens", "two\ftokens"})
    void blankOrWhitespaceInsideServiceTokenFails(String content) throws IOException {
        valid.put(PREFIX + "service-token-file", file("bad-token", content).toString());
        assertFailure(valid);
    }

    @Test
    void utf8ReadFailureDoesNotExposeCredential(CapturedOutput output) throws IOException {
        Path malformed = directory.resolve("malformed-utf8");
        Files.write(malformed, new byte[]{(byte) 0xc3, 0x28});
        valid.put(PREFIX + "service-token-file", malformed.toString());
        assertFailure(valid);
        assertThat(output.getAll()).doesNotContain(TOKEN_MARKER).doesNotContain(jwk);
    }

    @ParameterizedTest(name = "[{index}]")
    @ValueSource(strings = {"", "not-base64", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "AAAA AAAA"})
    void delegationKeyMustBeCanonical32ByteBase64url(String content) throws IOException {
        valid.put(PREFIX + "delegation-key-file", file("bad-delegation", content).toString());
        assertFailure(valid);
    }

    @ParameterizedTest(name = "[{index}]")
    @ValueSource(strings = {"not-json", "[]", "{}", "{\"keys\":[]}", "{\"kty\":\"EC\",\"kty\":\"EC\"}"})
    void invalidJwkDocumentFails(String content) throws IOException {
        valid.put(PREFIX + "actor-private-jwk-file", file("bad-jwk", content).toString());
        assertFailure(valid);
    }

    static Stream<String[]> invalidJwkFields() {
        return Stream.of(new String[]{"EC", "RSA"}, new String[]{"P-256", "P-384"},
                new String[]{"ES256", "ES384"}, new String[]{"fixture", " "});
    }

    @ParameterizedTest(name = "[{index}]")
    @MethodSource("invalidJwkFields")
    void wrongJwkAlgorithmCurveOrKidFails(String original, String replacement) throws IOException {
        valid.put(PREFIX + "actor-private-jwk-file", file("bad-jwk", jwk.replace(original, replacement)).toString());
        assertFailure(valid);
    }

    @Test
    void missingPrivateKeyInvalidPointOrMismatchedKeyFails(CapturedOutput output) throws IOException {
        String publicOnly = jwk.substring(0, jwk.indexOf(",\"d\"")) + "}";
        valid.put(PREFIX + "actor-private-jwk-file", file("public-only", publicOnly).toString());
        assertFailure(valid);
        String zero = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        String invalidPoint = jwk.replaceFirst("\"x\":\"[^\"]+\"", "\"x\":\"" + zero + "\"");
        valid.put(PREFIX + "actor-private-jwk-file", file("invalid-point", invalidPoint).toString());
        assertFailure(valid);
        String mismatched = jwk.replaceFirst("\"d\":\"[^\"]+\"", "\"d\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE\"");
        valid.put(PREFIX + "actor-private-jwk-file", file("mismatched", mismatched).toString());
        assertFailure(valid);
        assertThat(output.getAll()).doesNotContain(TOKEN_MARKER).doesNotContain(jwk)
                .doesNotContain(invalidPoint).doesNotContain(mismatched);
    }

    @Test
    void resolverMustBeExactlyOneIncludingPrimaryBeans() {
        withSettings(runner, valid).run(context -> assertThat(context).hasFailed());
        configured(valid).withBean("secondResolver", AiRequestIdentityResolver.class, () -> RESOLVER)
                .run(context -> assertThat(context).hasFailed());
    }

    @Test
    void matchingToolsAndHandlersStart() throws IOException {
        addTool(valid, 0, "example.read", "AI_READ");
        valid.put(PREFIX + "gateway-token-file", file("gateway-token", "fixture-gateway-token").toString());
        configured(valid).withBean("tool", AiToolRegistration.class, () -> registration("example.read"))
                .run(context -> assertThat(context).hasNotFailed());
    }

    @Test
    void explicitEmptyToolsAndEmptyRequiredPermissionsAreAllowed() throws IOException {
        valid.put(PREFIX + "tools", "");
        configured(valid).run(context -> assertThat(context).hasNotFailed());
        valid.remove(PREFIX + "tools");
        valid.put(PREFIX + "tools[0].id", "example.read");
        valid.put(PREFIX + "tools[0].required-permissions", "");
        valid.put(PREFIX + "gateway-token-file", file("gateway-token", "fixture-gateway-token").toString());
        configured(valid).withBean("tool", AiToolRegistration.class, () -> registration("example.read"))
                .run(context -> assertThat(context).hasNotFailed());
        valid.remove(PREFIX + "tools[0].required-permissions");
        configured(valid).withBean("tool", AiToolRegistration.class, () -> registration("example.read"))
                .run(context -> assertThat(context).hasFailed());
    }

    @Test
    void handlerMismatchMissingTokenAndDuplicatesFail() throws IOException {
        configured(valid).withBean("extra", AiToolRegistration.class, () -> registration("extra"))
                .run(context -> assertThat(context).hasFailed());
        addTool(valid, 0, "example.read", "AI_READ");
        assertFailure(valid);
        valid.put(PREFIX + "gateway-token-file", file("gateway-token", "fixture-gateway-token").toString());
        assertFailure(valid);
        configured(valid).withBean("wrong", AiToolRegistration.class, () -> registration("wrong"))
                .run(context -> assertThat(context).hasFailed());
        configured(valid).withBean("tool1", AiToolRegistration.class, () -> registration("example.read"))
                .withBean("tool2", AiToolRegistration.class, () -> registration("example.read"))
                .run(context -> assertThat(context).hasFailed());
        addTool(valid, 1, "example.read", "AI_READ");
        assertFailure(valid);
    }

    @Test
    void unknownToolFieldsAndInvalidRequiredPermissionsFail() throws IOException {
        addTool(valid, 0, "example.read", "NOT_REGISTERED");
        valid.put(PREFIX + "gateway-token-file", file("gateway-token", "fixture-gateway-token").toString());
        assertFailure(valid);
        valid.put(PREFIX + "tools[0].required-permissions[0]", "AI_READ");
        valid.put(PREFIX + "tools[0].required-permissions[1]", "AI_READ");
        assertFailure(valid);
        valid.remove(PREFIX + "tools[0].required-permissions[1]");
        valid.put(PREFIX + "tools[0].description", "not-owned-here");
        assertFailure(valid);
    }

    @Test
    void duplicatePropertiesKeysIncludingRelaxedNamesFail() throws IOException {
        Path duplicate = file("duplicate.properties", PREFIX + "system-id=first\n" + PREFIX + "system-id=second\n");
        assertDuplicateSourceFails(duplicate);
        Path relaxed = file("relaxed.properties", PREFIX + "system-id=first\n" + PREFIX + "systemId=second\n");
        assertDuplicateSourceFails(relaxed);
    }

    @Test
    void duplicateYamlKeysAreRejectedByBootConfigLoader() throws IOException {
        Path duplicate = file("duplicate.yaml", "nori:\n  ai:\n    integration:\n      enabled: true\n      enabled: false\n");
        assertThatThrownBy(() -> new YamlPropertySourceLoader().load("duplicate", new FileSystemResource(duplicate)))
                .isInstanceOf(org.yaml.snakeyaml.constructor.DuplicateKeyException.class);
    }

    @Test
    void bootDiscoversAutoConfigurationWithoutComponentScan() throws IOException {
        Path config = file("application.properties", valid.entrySet().stream()
                .map(entry -> entry.getKey() + "=" + entry.getValue().toString().replace("\\", "/") + "\n")
                .reduce("", String::concat));
        try (var context = new SpringApplicationBuilder(ConsumerApplication.class)
                .web(WebApplicationType.NONE).initializers(application -> application.getBeanFactory()
                        .registerSingleton("resolver", RESOLVER))
                .run("--spring.config.location=" + config.toUri(), "--spring.main.banner-mode=off")) {
            assertThat(context.getBean(AiIntegrationProperties.class).systemId()).isEqualTo("Example_1");
            assertThat(context.getBeanNamesForType(AiIntegrationAutoConfiguration.class)).hasSize(1);
        }
    }

    @Test
    void publicInputsAndResultsDefensivelyCopyNestedValues() {
        List<Object> nested = new ArrayList<>(Arrays.asList("value", null));
        Map<String, Object> values = new HashMap<>();
        values.put("nested", nested);
        Map<String, Object> object = new HashMap<>();
        object.put("child", values);
        AiToolItem item = new AiToolItem("ref", "text", object, null);
        Set<String> permissions = new HashSet<>(Set.of("AI_READ"));
        List<AiToolCall.Target> targets = new ArrayList<>(List.of(new AiToolCall.Target("type", "ref")));
        AiToolCall call = new AiToolCall("Example_1", "job", "example.read", "user", permissions, object, targets,
                Instant.EPOCH.plusSeconds(10), Instant.EPOCH);
        AiRequestIdentity identity = new AiRequestIdentity(true, "user", permissions);
        List<AiToolItem> items = new ArrayList<>(List.of(item));
        AiToolResult result = new AiToolResult(AiToolResult.Status.SUCCESS, items, List.of(), List.of(),
                new AiToolResult.RetentionMeta(List.of(), List.of()));
        nested.clear();
        values.clear();
        object.clear();
        permissions.clear();
        targets.clear();
        items.clear();
        assertThat(item.values()).hasSize(1);
        assertThat(call.arguments()).isEqualTo(item.values());
        assertThat(call.permissionCodes()).containsExactly("AI_READ");
        assertThat(identity.permissionCodes()).containsExactly("AI_READ");
        assertThat(call.targets()).hasSize(1);
        assertThat(result.items()).containsExactly(item);
        assertThatThrownBy(() -> call.arguments().clear()).isInstanceOf(UnsupportedOperationException.class);
        assertThatThrownBy(() -> result.items().clear()).isInstanceOf(UnsupportedOperationException.class);
        Object child = item.values().get("child");
        assertThat(child).isInstanceOf(Map.class);
        if (!(child instanceof Map<?, ?> childMap)) throw new AssertionError("중첩 객체가 없습니다.");
        assertThatThrownBy(childMap::clear).isInstanceOf(UnsupportedOperationException.class);
        Object array = childMap.get("nested");
        if (!(array instanceof List<?> arrayList)) throw new AssertionError("중첩 배열이 없습니다.");
        assertThat(arrayList).hasSize(2);
        assertThatThrownBy(arrayList::clear).isInstanceOf(UnsupportedOperationException.class);
        assertThatThrownBy(() -> new AiToolItem("ref", "text", Map.of("mutable", new StringBuilder()), null))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Configuration(proxyBeanMethods = false)
    @EnableAutoConfiguration
    static class ConsumerApplication {}

    @Test
    void enabledServletWithoutHostChainFailsInsteadOfRemovingBootProtection() {
        servletRunner().withConfiguration(AutoConfigurations.of(AiIntegrationAutoConfiguration.class))
                .withInitializer(context -> context.getEnvironment().getPropertySources()
                        .addFirst(new MapPropertySource("fixture", new LinkedHashMap<>(valid))))
                .run(context -> assertThat(context).hasFailed().getFailure()
                        .hasStackTraceContaining("AI 연동을 켜려면 호스트 앱에 기존 업무 Spring Security 체인이 필요합니다."));
    }

    @Test
    void enabledServletWithHostChainKeepsThatChainAndStarts() {
        servletRunner().withConfiguration(AutoConfigurations.of(AiIntegrationAutoConfiguration.class))
                .withUserConfiguration(HostSecurity.class)
                .withInitializer(context -> context.getEnvironment().getPropertySources()
                        .addFirst(new MapPropertySource("fixture", new LinkedHashMap<>(valid))))
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    assertThat(context.getBeanNamesForType(SecurityFilterChain.class))
                            .containsExactlyInAnyOrder("aiInternalSecurityFilterChain", "aiBrowserSecurityFilterChain", "hostSecurityFilterChain");
                    assertThat(context.containsBean("aiHostSecurityChainValidator")).isTrue();
                });
    }

    @Test
    void disabledServletKeepsBootDefaultSecurityBeansUnchanged() {
        var baseline = servletRunner();
        baseline.run(original -> {
            assertThat(original).hasNotFailed();
            assertThat(original.getBeansOfType(SecurityFilterChain.class)).hasSize(1);
            baseline.withConfiguration(AutoConfigurations.of(AiIntegrationAutoConfiguration.class))
                    .withPropertyValues(PREFIX + "enabled=false")
                    .run(context -> {
                        assertThat(context).hasNotFailed();
                        assertThat(context.getBeanDefinitionNames()).containsExactlyInAnyOrder(original.getBeanDefinitionNames());
                        assertThat(context.containsBean("aiHostSecurityChainValidator")).isFalse();
                        assertThat(context.getBeanNamesForType(SecurityFilterChain.class))
                                .containsExactlyInAnyOrder(original.getBeanNamesForType(SecurityFilterChain.class));
                    });
        });
    }

    private WebApplicationContextRunner servletRunner() {
        return new WebApplicationContextRunner()
                .withConfiguration(AutoConfigurations.of(SecurityAutoConfiguration.class, ServletWebSecurityAutoConfiguration.class))
                .withUserConfiguration(MvcHost.class)
                .withBean("resolver", AiRequestIdentityResolver.class, () -> RESOLVER)
                .withBean(UserDetailsService.class, () -> new InMemoryUserDetailsManager(
                        User.withUsername("fixture-host").password("{noop}fixture-password").roles("USER").build()));
    }

    @Configuration(proxyBeanMethods = false)
    @EnableWebMvc
    static class MvcHost {}

    @Configuration(proxyBeanMethods = false)
    static class HostSecurity {
        @Bean SecurityFilterChain hostSecurityFilterChain(HttpSecurity http) throws Exception {
            return http.securityMatcher("/business/**").authorizeHttpRequests(authorize -> authorize.anyRequest().denyAll()).build();
        }
    }

    private void assertDuplicateSourceFails(Path path) throws IOException {
        var sources = new PropertiesPropertySourceLoader().load("duplicate", new FileSystemResource(path));
        configured(valid).withInitializer(context -> sources.forEach(source -> context.getEnvironment()
                .getPropertySources().addFirst(source))).run(context -> assertThat(context).hasFailed());
    }

    private void assertFailure(Map<String, Object> settings) {
        configured(settings).run(context -> assertThat(context).hasFailed());
    }

    private ApplicationContextRunner configured(Map<String, Object> settings) {
        return withSettings(runner, settings).withBean("resolver", AiRequestIdentityResolver.class, () -> RESOLVER);
    }

    private static ApplicationContextRunner withSettings(ApplicationContextRunner source, Map<String, Object> settings) {
        return source.withInitializer(context -> context.getEnvironment().getPropertySources()
                .addFirst(new MapPropertySource("fixture", new LinkedHashMap<>(settings))));
    }

    private static void addTool(Map<String, Object> settings, int index, String id, String permission) {
        settings.put(PREFIX + "tools[" + index + "].id", id);
        settings.put(PREFIX + "tools[" + index + "].required-permissions[0]", permission);
    }

    private static AiToolRegistration registration(String id) {
        return AiToolRegistration.of(id, call -> new AiToolResult(AiToolResult.Status.EMPTY, List.of(),
                List.of(), List.of(), new AiToolResult.RetentionMeta(List.of(), List.of())));
    }

    private Path file(String name, String content) throws IOException {
        return Files.writeString(directory.resolve(name), content, StandardCharsets.UTF_8);
    }

    private static String encode(BigInteger integer) {
        byte[] source = integer.toByteArray();
        byte[] result = new byte[32];
        int length = Math.min(source.length, result.length);
        System.arraycopy(source, source.length - length, result, result.length - length, length);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(result);
    }
}
