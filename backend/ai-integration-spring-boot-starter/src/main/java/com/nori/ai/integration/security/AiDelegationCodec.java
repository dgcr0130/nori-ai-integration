package com.nori.ai.integration.security;

import com.nori.ai.integration.config.AiIntegrationProperties;
import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Instant;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

public final class AiDelegationCodec {
    private final String system;
    private final List<String> table;
    private final byte[] tableHash;
    private final byte[] key;
    private final Clock clock;
    private final SecureRandom random = new SecureRandom();

    public AiDelegationCodec(AiIntegrationProperties properties, Clock clock) {
        this.system = properties.systemId();
        this.table = properties.permissionCodes().stream().sorted().toList();
        this.tableHash = hash(String.join("\n", table).getBytes(StandardCharsets.UTF_8));
        this.clock = clock;
        try { key = Base64.getUrlDecoder().decode(Files.readString(properties.delegationKeyFile()).strip()); }
        catch (IOException | IllegalArgumentException failure) {
            throw new IllegalStateException("AI 위임 키를 읽을 수 없습니다.");
        }
    }

    public String issue(String subject, Set<String> permissions) {
        if (subject == null || !subject.matches("[A-Za-z0-9_-]{1,64}")) throw denied();
        long issued = clock.instant().getEpochSecond();
        if (issued < 0 || !table.containsAll(permissions)) throw denied();
        byte[] payload = new byte[57];
        payload[0] = 1;
        ByteBuffer.wrap(payload, 1, 8).putLong(issued);
        byte[] nonce = new byte[16];
        random.nextBytes(nonce);
        System.arraycopy(nonce, 0, payload, 9, 16);
        for (int index = 0; index < table.size(); index++) {
            if (permissions.contains(table.get(index))) payload[25 + index / 8] |= (byte) (1 << (index % 8));
        }
        byte[] encoded = Arrays.copyOf(payload, 89);
        System.arraycopy(mac(payload, subject, digest(permissions)), 0, encoded, 57, 32);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(encoded);
    }

    public Verified verify(String encoded, String subject, String permissionDigest) {
        if (subject == null || !subject.matches("[A-Za-z0-9_-]{1,64}")) throw denied();
        if (encoded == null || !encoded.matches("[A-Za-z0-9_-]{119}")) throw denied();
        byte[] bytes = Base64.getUrlDecoder().decode(encoded);
        if (bytes.length != 89 || !Base64.getUrlEncoder().withoutPadding().encodeToString(bytes).equals(encoded)
                || bytes[0] != 1) throw denied();
        long issued = ByteBuffer.wrap(bytes, 1, 8).getLong();
        Instant now = clock.instant();
        if (issued < 0 || issued > now.getEpochSecond() || now.getEpochSecond() - issued >= 180) throw denied();
        Set<String> permissions = new TreeSet<>();
        for (int index = 0; index < 256; index++) {
            if ((bytes[25 + index / 8] & (1 << (index % 8))) != 0) {
                if (index >= table.size()) throw denied();
                permissions.add(table.get(index));
            }
        }
        String pdg = digest(permissions);
        if (!MessageDigest.isEqual(Arrays.copyOfRange(bytes, 57, 89), mac(Arrays.copyOf(bytes, 57), subject, pdg))) {
            throw denied();
        }
        if (!pdg.equals(permissionDigest)) throw new AiIdentityService.Failure(409, "DELEGATION_CHANGED", "delegate");
        return new Verified(permissions, pdg, Instant.ofEpochSecond(issued).plusSeconds(180));
    }

    public record Verified(Set<String> permissions, String permissionDigest, Instant expiresAt) {
        public Verified { permissions = Set.copyOf(permissions); }
    }

    public static String digest(Set<String> permissions) {
        return HexFormat.of().formatHex(hash(String.join("\n", new TreeSet<>(permissions)).getBytes(StandardCharsets.UTF_8)));
    }

    private static byte[] hash(byte[] input) {
        try { return MessageDigest.getInstance("SHA-256").digest(input); }
        catch (GeneralSecurityException failure) { throw new IllegalStateException("SHA-256을 사용할 수 없습니다."); }
    }

    private byte[] mac(byte[] payload, String subject, String pdg) {
        try {
            var bytes = new ByteArrayOutputStream();
            try (var output = new DataOutputStream(bytes)) {
                output.write(payload);
                for (String value : List.of(system, subject, pdg)) {
                    byte[] utf8 = value.getBytes(StandardCharsets.UTF_8);
                    output.writeInt(utf8.length);
                    output.write(utf8);
                }
                output.write(tableHash);
            }
            Mac hmac = Mac.getInstance("HmacSHA256");
            hmac.init(new SecretKeySpec(key, "HmacSHA256"));
            return hmac.doFinal(bytes.toByteArray());
        } catch (GeneralSecurityException | IOException | IllegalArgumentException failure) {
            throw new AiIdentityService.Failure(500, "SIGNING_FAILED", "sign");
        }
    }

    private static AiIdentityService.Failure denied() {
        return new AiIdentityService.Failure(403, "DELEGATION_DENIED", "delegate");
    }
}
