package com.nori.ai.integration.api;

@FunctionalInterface
public interface AiToolHandler {
    AiToolResult handle(AiToolCall call);
}
