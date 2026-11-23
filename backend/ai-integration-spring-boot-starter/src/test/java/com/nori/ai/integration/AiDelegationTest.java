package com.nori.ai.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.nori.ai.integration.config.AiIntegrationProperties;
import com.nori.ai.integration.config.AiIntegrationProperties.BrowserCredential;
import com.nori.ai.integration.security.AiDelegationCodec;
import com.nori.ai.integration.security.AiIdentityService.Failure;
import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.IntStream;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class AiDelegationTest {
    @TempDir Path directory;
    static final List<Path> DIRECTORIES = new java.util.concurrent.CopyOnWriteArrayList<>();
    private AiIntegrationProperties properties(List<String> table) throws Exception {
        DIRECTORIES.add(directory);
        return PhaseTwoFixtures.keys(directory, "http://127.0.0.1:1", BrowserCredential.HEADER, table).properties();
    }
    private static AiDelegationCodec codec(AiIntegrationProperties properties, Instant instant) {
        return new AiDelegationCodec(properties, Clock.fixed(instant, ZoneOffset.UTC));
    }
    @AfterAll static void temporaryKeysWereRemoved() { assertThat(DIRECTORIES).noneMatch(Files::exists); }

    @Test void payloadLengthPrefixHmacSortedPermissionTableAndEmptyHashMatchIndependentOracle() throws Exception {
        var properties = properties(List.of("Z", "A", "M"));
        var codec = codec(properties, PhaseTwoFixtures.NOW);
        for (Set<String> permissions : List.of(Set.<String>of(), Set.of("A", "Z"), Set.of("A", "M", "Z"))) {
            String digest = AiDelegationCodec.digest(permissions);
            String token = codec.issue("actor", permissions);
            assertThat(token).hasSize(119).doesNotContain("=");
            byte[] bytes = Base64.getUrlDecoder().decode(token);
            assertThat(bytes).hasSize(89); assertThat(bytes[0]).isEqualTo((byte) 1);
            assertThat(ByteBuffer.wrap(bytes, 1, 8).getLong()).isEqualTo(PhaseTwoFixtures.NOW.getEpochSecond());
            assertThat(bytes[25]).isEqualTo((byte) (permissions.isEmpty() ? 0 : permissions.size() == 2 ? 5 : 7));
            assertThat(Arrays.copyOfRange(bytes, 26, 57)).containsOnly((byte) 0);
            assertThat(independentToken(properties, Arrays.copyOf(bytes, 57), "actor", digest)).isEqualTo(token);
            assertThat(codec.verify(token, "actor", digest).permissions()).isEqualTo(permissions);
        }
        assertThat(AiDelegationCodec.digest(Set.of())).isEqualTo("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assertThat(AiDelegationCodec.digest(Set.of("Z", "A"))).isEqualTo(java.util.HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest("A\nZ".getBytes(StandardCharsets.UTF_8))));
        assertThat(codec.issue("actor", Set.of())).isNotEqualTo(codec.issue("actor", Set.of()));
    }

    @Test void maximum256BitsAndSortedReorderedConfigurationRoundTrip() throws Exception {
        var table = IntStream.range(0, 256).mapToObj(index -> "P_%03d".formatted(index)).toList();
        var properties = properties(table);
        var permissions = new HashSet<>(table);
        var codec = codec(properties, PhaseTwoFixtures.NOW);
        String token = codec.issue("actor", permissions);
        assertThat(Arrays.copyOfRange(Base64.getUrlDecoder().decode(token), 25, 57)).containsOnly((byte) 0xff);
        var reordered = new AiIntegrationProperties(true, BrowserCredential.HEADER, properties.systemId(), properties.issuer(),
                properties.gatewayBaseUrl(), properties.serviceTokenFile(), properties.actorPrivateJwkFile(), null,
                properties.delegationKeyFile(), table.reversed(), table.getFirst(), List.of());
        assertThat(codec(reordered, PhaseTwoFixtures.NOW).verify(token, "actor", AiDelegationCodec.digest(permissions)).permissions()).isEqualTo(permissions);
    }

    @Test void exact180SecondBoundariesFutureNegativeIssueAndUnusedBitsAreRejected() throws Exception {
        var properties = properties(List.of("AI_READ"));
        var now = PhaseTwoFixtures.NOW;
        var current = codec(properties, now);
        String pdg = AiDelegationCodec.digest(Set.of("AI_READ"));
        String token = current.issue("actor", Set.of("AI_READ"));
        assertThat(codec(properties, now.plusSeconds(179).plusNanos(999_999_999)).verify(token, "actor", pdg).expiresAt()).isEqualTo(now.plusSeconds(180));
        deny(() -> codec(properties, now.minusNanos(1)).verify(token, "actor", pdg), "DELEGATION_DENIED");
        deny(() -> codec(properties, now.plusSeconds(180)).verify(token, "actor", pdg), "DELEGATION_DENIED");
        byte[] payload = Arrays.copyOf(Base64.getUrlDecoder().decode(token), 57);
        payload[56] |= (byte) 0x80;
        String unused = independentToken(properties, payload, "actor", pdg);
        deny(() -> current.verify(unused, "actor", pdg), "DELEGATION_DENIED");
        payload[56] = 0;
        for (long issued : List.of(-1L, now.getEpochSecond() + 1)) {
            ByteBuffer.wrap(payload, 1, 8).putLong(issued);
            String invalid = independentToken(properties, payload, "actor", pdg);
            deny(() -> current.verify(invalid, "actor", pdg), "DELEGATION_DENIED");
        }
    }

    @Test void tamperingSubjectSystemKeyTableFormatAndPdgAreDistinguishedWithoutCurrentLookup() throws Exception {
        var properties = properties(List.of("AI_READ", "AI_REVIEW"));
        var current = codec(properties, PhaseTwoFixtures.NOW);
        String pdg = AiDelegationCodec.digest(Set.of("AI_READ"));
        String token = current.issue("actor", Set.of("AI_READ"));
        deny(() -> current.verify(token, "other_actor", pdg), "DELEGATION_DENIED");
        deny(() -> current.verify(token, "actor", "0".repeat(64)), "DELEGATION_CHANGED");
        for (String malformed : List.of("", token + "=", token.substring(1), "!" + token.substring(1))) {
            deny(() -> current.verify(malformed, "actor", pdg), "DELEGATION_DENIED");
        }
        for (int index : List.of(0, 1, 9, 25, 57, 88)) {
            byte[] bytes = Base64.getUrlDecoder().decode(token); bytes[index] ^= 1;
            String modified = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
            deny(() -> current.verify(modified, "actor", pdg), "DELEGATION_DENIED");
        }
        var otherSystem = copy(properties, "Other", properties.permissionCodes(), properties.delegationKeyFile());
        deny(() -> codec(otherSystem, PhaseTwoFixtures.NOW).verify(token, "actor", pdg), "DELEGATION_DENIED");
        var otherTable = copy(properties, properties.systemId(), List.of("AI_READ", "CHANGED"), properties.delegationKeyFile());
        deny(() -> codec(otherTable, PhaseTwoFixtures.NOW).verify(token, "actor", pdg), "DELEGATION_DENIED");
        Path otherKey = directory.resolve("other-key");
        Files.writeString(otherKey, Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[32]));
        var changedKey = copy(properties, properties.systemId(), properties.permissionCodes(), otherKey);
        deny(() -> codec(changedKey, PhaseTwoFixtures.NOW).verify(token, "actor", pdg), "DELEGATION_DENIED");
    }

    @Test void sameFilesVerifyInTwoNewJvmProcessesAndAfterRestart() throws Exception {
        var properties = properties(List.of("AI_READ", "AI_REVIEW"));
        String token = codec(properties, PhaseTwoFixtures.NOW).issue("actor", Set.of("AI_READ"));
        for (int index = 0; index < 2; index++) {
            var process = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java.exe").toString(), "-cp",
                    System.getProperty("ai.integration.test.classpath"), VerifierProcess.class.getName()).start();
            try {
                try (var input = process.getOutputStream()) {
                    input.write(PhaseTwoFixtures.JSON.writeValueAsBytes(Map.of("keyFile", properties.delegationKeyFile().toString(),
                            "token", token, "now", PhaseTwoFixtures.NOW.toString())));
                }
                byte[] output = process.getInputStream().readAllBytes();
                byte[] errors = process.getErrorStream().readAllBytes();
                assertThat(process.waitFor()).isZero(); assertThat(errors).isEmpty();
                assertThat(new String(output, StandardCharsets.UTF_8)).isEqualTo("VERIFIED");
            } finally { if (process.isAlive()) process.destroy(); }
            assertThat(process.isAlive()).isFalse();
        }
    }

    @Test void delegationIssuanceFailuresBecomeSigningFailedAndMaximumPermissionsAreSigned() throws Exception {
        var table = IntStream.range(0, 256).mapToObj(index -> "P_%03d".formatted(index)).toList();
        var properties = properties(table);
        var identity = new com.nori.ai.integration.api.AiRequestIdentity(true, "actor", Set.copyOf(table));
        var failing = new com.nori.ai.integration.security.AiActorSigner(properties,
                codec(properties, Instant.ofEpochSecond(-1)), Clock.fixed(PhaseTwoFixtures.NOW, ZoneOffset.UTC));
        deny(() -> failing.signJob(identity), "SIGNING_FAILED");
        var signer = new com.nori.ai.integration.security.AiActorSigner(properties,
                codec(properties, PhaseTwoFixtures.NOW), Clock.fixed(PhaseTwoFixtures.NOW, ZoneOffset.UTC));
        String[] jws = signer.signJob(identity).split("\\.");
        var claims = PhaseTwoFixtures.JSON.readTree(Base64.getUrlDecoder().decode(jws[1]));
        assertThat(claims.get("perm").size()).isEqualTo(256);
        assertThat(claims.get("perm").get(0).asString()).isEqualTo("P_000");
        assertThat(claims.get("perm").get(255).asString()).isEqualTo("P_255");
        assertThat(claims.get("dlg").asString()).hasSize(119);
    }

    public static final class VerifierProcess {
        private VerifierProcess() {}
        public static void main(String[] arguments) {
            var input = PhaseTwoFixtures.JSON.readTree(System.in);
            var properties = new AiIntegrationProperties(true, BrowserCredential.HEADER, "Example_1", "example-backend", "http://127.0.0.1:1",
                    null, null, null, Path.of(input.get("keyFile").asString()), List.of("AI_READ", "AI_REVIEW"), "AI_REVIEW", List.of());
            var result = codec(properties, Instant.parse(input.get("now").asString())).verify(input.get("token").asString(), "actor", AiDelegationCodec.digest(Set.of("AI_READ")));
            if (!result.permissions().equals(Set.of("AI_READ"))) throw new IllegalStateException("위임 복원 실패");
            System.out.print("VERIFIED");
        }
    }

    private static AiIntegrationProperties copy(AiIntegrationProperties original, String system, List<String> table, Path key) {
        return new AiIntegrationProperties(true, BrowserCredential.HEADER, system, original.issuer(), original.gatewayBaseUrl(),
                original.serviceTokenFile(), original.actorPrivateJwkFile(), null, key, table, table.getFirst(), List.of());
    }
    private static void deny(Runnable action, String code) {
        assertThatThrownBy(action::run).isInstanceOfSatisfying(Failure.class, failure -> assertThat(failure.code()).isEqualTo(code));
    }
    private static String independentToken(AiIntegrationProperties properties, byte[] payload, String subject, String pdg) throws Exception {
        var bytes = new ByteArrayOutputStream();
        try (var stream = new DataOutputStream(bytes)) {
            stream.write(payload);
            for (String value : List.of(properties.systemId(), subject, pdg)) {
                byte[] text = value.getBytes(StandardCharsets.UTF_8); stream.writeInt(text.length); stream.write(text);
            }
            stream.write(MessageDigest.getInstance("SHA-256").digest(String.join("\n", properties.permissionCodes().stream().sorted().toList()).getBytes(StandardCharsets.UTF_8)));
        }
        var mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(Base64.getUrlDecoder().decode(Files.readString(properties.delegationKeyFile()).strip()), "HmacSHA256"));
        var token = new ByteArrayOutputStream(); token.write(payload); token.write(mac.doFinal(bytes.toByteArray()));
        return Base64.getUrlEncoder().withoutPadding().encodeToString(token.toByteArray());
    }
}
