package com.nori.ai.integration.api;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;

public record AiToolCall(String systemId, String jobId, String toolId, String subject,
                         Set<String> permissionCodes, Map<String, Object> arguments,
                         List<Target> targets, Instant deadline, Instant observedAt) {
    public AiToolCall {
        permissionCodes = Set.copyOf(permissionCodes);
        arguments = AiToolItem.immutableObject(arguments);
        targets = List.copyOf(targets);
    }

    public record Target(String type, String ref) {}
}
