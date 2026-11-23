package com.nori.ai.integration.api;

import java.util.Set;

public record AiRequestIdentity(boolean loggedIn, String subject, Set<String> permissionCodes) {
    public AiRequestIdentity {
        // 잘못된 resolver 반환은 요청 경계에서 구별할 수 있도록 null을 보존한다.
        permissionCodes = permissionCodes == null ? null : Set.copyOf(permissionCodes);
    }
}
