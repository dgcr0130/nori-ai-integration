package com.nori.ai.integration.api;

import jakarta.servlet.http.HttpServletRequest;

@FunctionalInterface
public interface AiRequestIdentityResolver {
    AiRequestIdentity resolve(HttpServletRequest request);
}
