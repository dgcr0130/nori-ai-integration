package com.nori.ai.integration.config;

import java.io.IOException;
import java.io.InputStreamReader;
import java.io.Reader;
import java.math.BigInteger;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.AlgorithmParameters;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPrivateKeySpec;
import java.security.spec.ECPublicKeySpec;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Properties;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.boot.origin.Origin;
import org.springframework.boot.origin.OriginLookup;
import org.springframework.boot.origin.TextResourceOrigin;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.EnumerablePropertySource;
import org.springframework.core.env.PropertySource;
import org.springframework.core.io.Resource;
import tools.jackson.core.JacksonException;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

public record AiIntegrationProperties(
        @DefaultValue("false") boolean enabled,
        @DefaultValue("COOKIE") BrowserCredential browserCredential,
        String systemId, String issuer, String gatewayBaseUrl,
        Path serviceTokenFile, Path actorPrivateJwkFile, Path gatewayTokenFile, Path delegationKeyFile,
        List<String> permissionCodes, String reviewPermission, List<Tool> tools) {
    private static final Pattern WHITESPACE = Pattern.compile("\\s");
    private static final JsonMapper JWK_MAPPER = JsonMapper.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .build();

    public AiIntegrationProperties {
        permissionCodes = permissionCodes == null ? List.of() : List.copyOf(permissionCodes);
        tools = tools == null ? List.of() : List.copyOf(tools);
    }

    public enum BrowserCredential { COOKIE, HEADER }

    public record Tool(String id, List<String> requiredPermissions) {
        public Tool {
            requiredPermissions = requiredPermissions == null ? null : List.copyOf(requiredPermissions);
        }
    }

    void validate() {
        require(systemId != null && systemId.matches("[A-Za-z0-9][A-Za-z0-9_-]{0,63}"), "system-id 형식");
        require(issuer != null && !issuer.isBlank() && issuer.codePointCount(0, issuer.length()) <= 128,
                "issuer는 1~128자");
        validateGatewayUrl();
        require(browserCredential != null, "browser-credential은 COOKIE 또는 HEADER");
        require(!permissionCodes.isEmpty() && permissionCodes.size() <= 256, "permission-codes는 1~256개");
        Set<String> permissions = validatePermissionCodes(permissionCodes, "permission-codes");
        require(reviewPermission != null && permissions.contains(reviewPermission),
                "review-permission은 permission-codes에 포함");
        Set<String> ids = new HashSet<>();
        for (Tool tool : tools) {
            require(tool.id() != null && tool.id().matches("[A-Za-z0-9_.-]{1,128}"), "tools.id 형식");
            require(ids.add(tool.id()), "tools.id 중복 금지");
            require(tool.requiredPermissions() != null, "tools.required-permissions 필수");
            Set<String> required = validatePermissionCodes(tool.requiredPermissions(), "tools.required-permissions");
            require(permissions.containsAll(required), "tools.required-permissions는 permission-codes에 포함");
        }
        readToken(serviceTokenFile, "service-token-file");
        validatePrivateJwk(readFile(actorPrivateJwkFile, "actor-private-jwk-file"));
        decodeKey(readFile(delegationKeyFile, "delegation-key-file").strip(), "delegation-key-file");
        if (!tools.isEmpty()) {
            readToken(gatewayTokenFile, "gateway-token-file");
        } else if (gatewayTokenFile != null) {
            readToken(gatewayTokenFile, "gateway-token-file");
        }
    }

    private void validateGatewayUrl() {
        require(gatewayBaseUrl != null && !gatewayBaseUrl.isBlank(), "gateway-base-url 필수");
        try {
            URI uri = new URI(gatewayBaseUrl);
            require(("http".equals(uri.getScheme()) || "https".equals(uri.getScheme())) && uri.getHost() != null
                    && uri.getRawUserInfo() == null && uri.getRawQuery() == null && uri.getRawFragment() == null
                    && (uri.getRawPath() == null || uri.getRawPath().isEmpty())
                    && uri.getPort() >= -1 && uri.getPort() <= 65535, "gateway-base-url 주소 형식");
        } catch (URISyntaxException exception) {
            throw invalid("gateway-base-url 주소 형식");
        }
    }

    private static Set<String> validatePermissionCodes(List<String> codes, String key) {
        Set<String> seen = new HashSet<>();
        for (String code : codes) {
            require(code != null && code.matches("[A-Z0-9_]{1,64}"), key + " 코드 형식");
            require(seen.add(code), key + " 중복 금지");
        }
        return seen;
    }

    private static void readToken(Path path, String key) {
        String token = readFile(path, key).strip();
        require(!token.isEmpty() && !WHITESPACE.matcher(token).find(), key + " 토큰 형식");
    }

    private static String readFile(Path path, String key) {
        require(path != null, key + " 필수");
        try {
            require(Files.isRegularFile(path) && Files.isReadable(path), key + " 읽기 가능한 파일 필수");
            return Files.readString(path, StandardCharsets.UTF_8);
        } catch (IOException | SecurityException exception) {
            throw invalid(key + " 읽기 실패 (" + exception.getClass().getSimpleName() + ")");
        }
    }

    private static byte[] decodeKey(String encoded, String key) {
        require(encoded.matches("[A-Za-z0-9_-]{43}"), key + " Base64url 무패딩 32바이트 형식");
        byte[] decoded = Base64.getUrlDecoder().decode(encoded);
        require(decoded.length == 32 && Base64.getUrlEncoder().withoutPadding().encodeToString(decoded).equals(encoded),
                key + " 정규 Base64url 형식");
        return decoded;
    }

    private static void validatePrivateJwk(String content) {
        final JsonNode jwk;
        try {
            jwk = JWK_MAPPER.readTree(content);
        } catch (JacksonException exception) {
            throw invalid("actor-private-jwk-file JSON 형식 또는 중복 키");
        }
        require(jwk != null && jwk.isObject(), "actor-private-jwk-file 개인 JWK 한 개 필수");
        require("EC".equals(text(jwk, "kty")) && "P-256".equals(text(jwk, "crv")),
                "actor-private-jwk-file EC P-256 필수");
        require(!text(jwk, "kid").isBlank(), "actor-private-jwk-file kid 필수");
        require(!jwk.has("alg") || "ES256".equals(text(jwk, "alg")), "actor-private-jwk-file ES256 필수");
        require(!jwk.has("use") || "sig".equals(text(jwk, "use")), "actor-private-jwk-file 서명 용도 필수");
        byte[] x = decodeKey(text(jwk, "x"), "actor-private-jwk-file x");
        byte[] y = decodeKey(text(jwk, "y"), "actor-private-jwk-file y");
        byte[] d = decodeKey(text(jwk, "d"), "actor-private-jwk-file d");
        try {
            AlgorithmParameters parameters = AlgorithmParameters.getInstance("EC");
            parameters.init(new ECGenParameterSpec("secp256r1"));
            ECParameterSpec curve = parameters.getParameterSpec(ECParameterSpec.class);
            BigInteger scalar = new BigInteger(1, d);
            require(scalar.signum() > 0 && scalar.compareTo(curve.getOrder()) < 0,
                    "actor-private-jwk-file 개인키 범위");
            KeyFactory factory = KeyFactory.getInstance("EC");
            var privateKey = factory.generatePrivate(new ECPrivateKeySpec(scalar, curve));
            var publicKey = factory.generatePublic(new ECPublicKeySpec(
                    new ECPoint(new BigInteger(1, x), new BigInteger(1, y)), curve));
            // 형식만 맞는 손상 키가 기동을 통과하지 않도록 공개·개인키 대응도 확인한다.
            byte[] probe = "nori-ai-integration-key-check".getBytes(StandardCharsets.US_ASCII);
            Signature signature = Signature.getInstance("SHA256withECDSA");
            signature.initSign(privateKey);
            signature.update(probe);
            byte[] signed = signature.sign();
            signature.initVerify(publicKey);
            signature.update(probe);
            require(signature.verify(signed), "actor-private-jwk-file 공개·개인키 불일치");
        } catch (GeneralSecurityException exception) {
            throw invalid("actor-private-jwk-file 키 검증 실패 (" + exception.getClass().getSimpleName() + ")");
        }
    }

    private static String text(JsonNode object, String name) {
        JsonNode value = object.get(name);
        require(value != null && value.isString(), "actor-private-jwk-file " + name + " 문자열 필수");
        return value.asString();
    }

    static void checkDuplicateKeys(ConfigurableEnvironment environment) {
        Set<Resource> checked = new HashSet<>();
        for (PropertySource<?> source : environment.getPropertySources()) {
            if (!(source instanceof EnumerablePropertySource<?> enumerable)) continue;
            for (String name : enumerable.getPropertyNames()) {
                if (!canonicalKey(name).startsWith("noriaiintegration")) continue;
                Origin origin = OriginLookup.getOrigin(source, name);
                if (origin instanceof TextResourceOrigin textOrigin) {
                    Resource resource = textOrigin.getResource();
                    String filename = resource.getFilename();
                    if (filename != null && filename.endsWith(".properties") && checked.add(resource)) {
                        checkPropertiesResource(resource);
                    }
                }
            }
        }
    }

    private static void checkPropertiesResource(Resource resource) {
        Properties properties = new Properties() {
            private static final long serialVersionUID = 1L;
            private final Set<String> seen = new HashSet<>();

            @Override
            public synchronized Object put(Object key, Object value) {
                String name = canonicalKey(key.toString());
                if (name.startsWith("noriaiintegration") && !seen.add(name)) {
                    throw invalid("설정 파일의 AI 연동 키 중복");
                }
                return super.put(key, value);
            }
        };
        try (Reader reader = new InputStreamReader(resource.getInputStream(), StandardCharsets.UTF_8.newDecoder())) {
            properties.load(reader);
        } catch (IOException exception) {
            throw invalid("AI 연동 설정 원본 읽기 실패 (" + exception.getClass().getSimpleName() + ")");
        }
    }

    private static String canonicalKey(String key) {
        return key.replace("-", "").replace("_", "").replace(".", "").toLowerCase(Locale.ROOT);
    }

    private static void require(boolean condition, String rule) {
        if (!condition) throw invalid(rule);
    }

    private static IllegalStateException invalid(String rule) {
        return new IllegalStateException("AI 연동 설정 오류: " + rule);
    }
}
