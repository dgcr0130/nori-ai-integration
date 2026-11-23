package com.nori.ai.integration.security;

import com.nori.ai.integration.api.AiRequestIdentity;
import com.nori.ai.integration.config.AiIntegrationProperties;
import java.io.IOException;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.AlgorithmParameters;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPrivateKeySpec;
import java.time.Clock;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import tools.jackson.databind.json.JsonMapper;

public final class AiActorSigner {
    private final AiIntegrationProperties properties;
    private final AiDelegationCodec delegations;
    private final Clock clock;
    private final PrivateKey key;
    private final String kid;
    private final JsonMapper json = JsonMapper.builder().build();

    public AiActorSigner(AiIntegrationProperties properties, AiDelegationCodec delegations, Clock clock) {
        this.properties = properties;
        this.delegations = delegations;
        this.clock = clock;
        try {
            var jwk = json.readTree(Files.readString(properties.actorPrivateJwkFile()));
            kid = jwk.get("kid").asString();
            var parameters = AlgorithmParameters.getInstance("EC");
            parameters.init(new ECGenParameterSpec("secp256r1"));
            key = KeyFactory.getInstance("EC").generatePrivate(new ECPrivateKeySpec(
                    new BigInteger(1, Base64.getUrlDecoder().decode(jwk.get("d").asString())),
                    parameters.getParameterSpec(ECParameterSpec.class)));
        } catch (IOException | GeneralSecurityException | RuntimeException failure) {
            throw new IllegalStateException("AI 서명 키를 읽을 수 없습니다.");
        }
    }

    public String sign(AiRequestIdentity identity, String delegation) {
        try {
            long issued = clock.instant().getEpochSecond();
            Map<String, Object> claims = new LinkedHashMap<>();
            claims.put("iss", properties.issuer());
            claims.put("aud", "ai-gateway");
            claims.put("sys", properties.systemId());
            claims.put("iat", issued);
            claims.put("exp", Math.addExact(issued, 60));
            claims.put("sub", identity.subject());
            claims.put("scope", "READ");
            claims.put("perm", identity.permissionCodes().stream().sorted().toList());
            claims.put("pdg", AiDelegationCodec.digest(identity.permissionCodes()));
            if (delegation != null) claims.put("dlg", delegation);
            String input = encode(json.writeValueAsBytes(Map.of("alg", "ES256", "kid", kid))) + "."
                    + encode(json.writeValueAsBytes(claims));
            // JOSE는 DER 대신 고정 길이 R || S를 요구한다. JDK P1363 구현을 사용한다.
            Signature signature = Signature.getInstance("SHA256withECDSAinP1363Format");
            signature.initSign(key);
            signature.update(input.getBytes(StandardCharsets.US_ASCII));
            return input + "." + encode(signature.sign());
        } catch (GeneralSecurityException | RuntimeException failure) {
            throw new AiIdentityService.Failure(500, "SIGNING_FAILED", "sign");
        }
    }

    public String signJob(AiRequestIdentity identity) {
        try { return sign(identity, delegations.issue(identity.subject(), identity.permissionCodes())); }
        catch (RuntimeException failure) { throw new AiIdentityService.Failure(500, "SIGNING_FAILED", "sign"); }
    }

    private static String encode(byte[] bytes) { return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes); }
}
