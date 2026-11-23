package com.nori.ai.integration.security;

import com.nori.ai.integration.api.AiRequestIdentity;
import com.nori.ai.integration.api.AiRequestIdentityResolver;
import com.nori.ai.integration.config.AiIntegrationProperties;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Set;
import java.util.TreeSet;

public final class AiIdentityService {
    private final AiRequestIdentityResolver resolver;
    private final Set<String> table;

    public AiIdentityService(AiRequestIdentityResolver resolver, AiIntegrationProperties properties) {
        this.resolver = resolver;
        table = Set.copyOf(properties.permissionCodes());
    }

    public AiRequestIdentity current(HttpServletRequest request) {
        final AiRequestIdentity identity;
        try { identity = resolver.resolve(request); }
        catch (RuntimeException failure) { throw new Failure(503, "AUTH_UNAVAILABLE", "identity"); }
        if (identity == null || identity.permissionCodes() == null
                || (identity.loggedIn() ? identity.subject() == null || !identity.subject().matches("[A-Za-z0-9_-]{1,64}")
                : identity.subject() != null || !identity.permissionCodes().isEmpty())) {
            throw new Failure(500, "AUTH_RESULT_INVALID", "identity");
        }
        if (!identity.loggedIn()) throw new Failure(401, "LOGIN_REQUIRED", "identity");
        var permissions = new TreeSet<>(identity.permissionCodes());
        permissions.retainAll(table);
        return new AiRequestIdentity(true, identity.subject(), permissions);
    }

    public static final class Failure extends RuntimeException {
        private static final long serialVersionUID = 1L;
        private final int status;
        private final String code;
        private final String stage;
        public Failure(int status, String code, String stage) {
            super("AI 요청을 처리할 수 없습니다.", null, false, false);
            this.status = status;
            this.code = code;
            this.stage = stage;
        }
        public int status() { return status; }
        public String code() { return code; }
        public String stage() { return stage; }
    }
}
