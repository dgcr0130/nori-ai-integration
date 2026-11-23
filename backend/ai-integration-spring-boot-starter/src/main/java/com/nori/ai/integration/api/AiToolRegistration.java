package com.nori.ai.integration.api;

import java.util.Objects;

public record AiToolRegistration(String toolId, AiToolHandler handler) {
    public AiToolRegistration {
        if (toolId == null || !toolId.matches("[A-Za-z0-9_.-]{1,128}")) {
            throw new IllegalArgumentException("도구 등록 ID 형식이 올바르지 않습니다.");
        }
        Objects.requireNonNull(handler, "도구 처리기는 필수입니다.");
    }

    public static AiToolRegistration of(String toolId, AiToolHandler handler) {
        return new AiToolRegistration(toolId, handler);
    }
}
