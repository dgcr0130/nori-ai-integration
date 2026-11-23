package com.nori.ai.integration.api;

import java.time.Instant;
import java.util.List;

public record AiToolResult(Status status, List<AiToolItem> items, List<String> missingFields,
                           List<Warning> warnings, RetentionMeta retentionMeta) {
    public AiToolResult {
        // 반환 위반 판정은 공통 외피 경계가 맡고, 여기서는 가변 참조만 차단한다.
        items = items == null ? null : List.copyOf(items);
        missingFields = missingFields == null ? null : List.copyOf(missingFields);
        warnings = warnings == null ? null : List.copyOf(warnings);
    }

    public enum Status {
        SUCCESS, EMPTY, PARTIAL, OUT_OF_RETENTION, STALE, CONFLICT, DENIED, UNSUPPORTED,
        SOURCE_UNAVAILABLE, TIMEOUT, FAILED
    }

    public enum Warning { RETENTION_UNVERIFIED }

    public record RetentionMeta(List<TimeRange> missingRanges, List<TimeRange> unverifiedRanges) {
        public RetentionMeta {
            missingRanges = missingRanges == null ? null : List.copyOf(missingRanges);
            unverifiedRanges = unverifiedRanges == null ? null : List.copyOf(unverifiedRanges);
        }
    }

    public record TimeRange(Instant from, Instant to) {}
}
