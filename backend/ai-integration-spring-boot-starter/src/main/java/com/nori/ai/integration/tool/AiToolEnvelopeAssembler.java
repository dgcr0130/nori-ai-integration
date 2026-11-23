package com.nori.ai.integration.tool;

import com.nori.ai.integration.api.AiToolItem;
import com.nori.ai.integration.api.AiToolResult;
import com.nori.ai.integration.api.AiToolResult.Status;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

/** 처리기 반환 검사를 절삭보다 먼저 끝내어 버린 자료에도 위반이 숨지 않게 한다. */
public final class AiToolEnvelopeAssembler {
    public static final int MAX_BYTES = 1024 * 1024;
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final Set<Status> DATA = Set.of(Status.SUCCESS, Status.EMPTY, Status.PARTIAL, Status.STALE, Status.CONFLICT);

    public record Identity(String version, String systemId, String jobId, String toolId) {}
    public record Response(int http, String code, byte[] body) {
        public Response { body = body.clone(); }
        @Override public byte[] body() { return body.clone(); }
    }
    public static final class InvalidResult extends RuntimeException {
        private static final long serialVersionUID = 1L;
        public InvalidResult() { super("처리기 반환 계약 위반"); }
    }

    public Response failure(Identity id, Instant observed, int http, String code) {
        Status status = switch (http) {
            case 400, 404 -> Status.FAILED;
            case 401, 403, 409 -> Status.DENIED;
            case 429, 503 -> Status.SOURCE_UNAVAILABLE;
            case 504 -> Status.TIMEOUT;
            default -> throw new IllegalArgumentException("정의되지 않은 내부 HTTP 상태입니다.");
        };
        return new Response(http, code, JSON.writeValueAsBytes(envelope(id, observed, status, null,
                List.of(), List.of(), List.of(), List.of(), code)));
    }

    public Response assemble(Identity id, Instant observed, AiToolResult result) {
        validate(result);
        int http = switch (result.status()) {
            case DENIED -> 403;
            case SOURCE_UNAVAILABLE -> 503;
            case TIMEOUT -> 504;
            case FAILED -> 400;
            default -> 200;
        };
        String code = switch (result.status()) {
            case DENIED -> "DELEGATION_DENIED";
            case SOURCE_UNAVAILABLE -> "SOURCE_UNAVAILABLE";
            case TIMEOUT -> "TIMEOUT";
            case FAILED -> "INPUT_INVALID";
            default -> null;
        };
        if (http != 200) {
            // 적법한 실패 반환의 누락 정보는 보존하며 위반 반환의 전부 폐기와 구별한다.
            return new Response(http, code, JSON.writeValueAsBytes(envelope(id, observed, result.status(), null,
                    result.missingFields(), result.warnings().stream().map(Enum::name).toList(),
                    result.retentionMeta().missingRanges(), result.retentionMeta().unverifiedRanges(), code)));
        }
        List<AiToolItem> kept = new ArrayList<>(), dropped = new ArrayList<>();
        var items = result.items();
        for (int index = 0; index < items.size(); index++) {
            AiToolItem item = items.get(index);
            if (length(item.text()) > 4000) { dropped.add(item); continue; }
            if (kept.size() == 100) { dropped.addAll(items.subList(index, items.size())); break; }
            kept.add(item);
            if (bytes(id, observed, result, kept, dropped).length > MAX_BYTES) {
                kept.removeLast();
                dropped.addAll(items.subList(index, items.size()));
                break;
            }
        }
        byte[] bytes = bytes(id, observed, result, kept, dropped);
        // 절삭 표식과 최종 누락 구간이 추가된 뒤의 실제 UTF-8 크기로 다시 닫는다.
        while (bytes.length > MAX_BYTES && !kept.isEmpty()) {
            dropped.add(kept.removeLast());
            bytes = bytes(id, observed, result, kept, dropped);
        }
        if (bytes.length > MAX_BYTES) throw new InvalidResult();
        return new Response(200, null, bytes);
    }

    private byte[] bytes(Identity id, Instant observed, AiToolResult result,
            List<AiToolItem> kept, List<AiToolItem> dropped) {
        var missing = new ArrayList<>(result.missingFields());
        var ranges = new ArrayList<>(result.retentionMeta().missingRanges());
        Status status = result.status();
        if (!dropped.isEmpty()) {
            missing.add("truncatedItems");
            if (status == Status.SUCCESS) status = Status.PARTIAL;
            if (dropped.stream().allMatch(item -> item.time() != null)) {
                Instant from = dropped.stream().map(AiToolItem::time).min(Instant::compareTo).orElseThrow();
                Instant to = dropped.stream().map(AiToolItem::time).max(Instant::compareTo).orElseThrow().plusNanos(1);
                if (!utc(to)) throw new InvalidResult();
                ranges.add(new AiToolResult.TimeRange(from, to));
            }
        }
        ObjectNode data = null;
        if (DATA.contains(status)) {
            data = JSON.createObjectNode();
            var array = data.putArray("items");
            for (var item : kept) {
                var value = array.addObject().put("ref", item.ref()).put("text", item.text());
                value.set("values", JSON.valueToTree(item.values()));
            }
        }
        return JSON.writeValueAsBytes(envelope(id, observed, status, data, missing,
                result.warnings().stream().map(Enum::name).toList(), ranges, result.retentionMeta().unverifiedRanges(), null));
    }

    private ObjectNode envelope(Identity id, Instant observed, Status status, ObjectNode data,
            List<String> missing, List<String> warnings, List<AiToolResult.TimeRange> ranges,
            List<AiToolResult.TimeRange> unverified, String code) {
        var node = JSON.createObjectNode().put("version", id.version()).put("systemId", id.systemId())
                .put("jobId", id.jobId()).put("toolId", id.toolId()).put("status", status.name())
                .put("observedAt", observed.toString());
        node.set("data", data == null ? JSON.nullNode() : data);
        node.set("missingFields", JSON.valueToTree(missing));
        node.set("warnings", JSON.valueToTree(warnings));
        var retention = node.putObject("retentionMeta");
        addRanges(retention, "missingRanges", ranges); addRanges(retention, "unverifiedRanges", unverified);
        node.put("errorCode", code);
        return node;
    }

    private void addRanges(ObjectNode node, String name, List<AiToolResult.TimeRange> ranges) {
        var array = node.putArray(name);
        ranges.forEach(range -> array.addObject().put("from", range.from().toString()).put("to", range.to().toString()));
    }

    private void validate(AiToolResult value) {
        require(value != null && value.status() != null && value.items() != null && value.missingFields() != null
                && value.warnings() != null && value.retentionMeta() != null);
        var retention = value.retentionMeta();
        require(retention.missingRanges() != null && retention.unverifiedRanges() != null);
        require(value.missingFields().size() <= 99 && retention.missingRanges().size() <= 99 && retention.unverifiedRanges().size() <= 100);
        value.missingFields().forEach(field -> require(text(field, 128)));
        require(value.warnings().size() <= 1 && value.warnings().stream().allMatch(w -> w == AiToolResult.Warning.RETENTION_UNVERIFIED));
        for (var ranges : List.of(retention.missingRanges(), retention.unverifiedRanges())) for (var range : ranges) {
            require(range != null && utc(range.from()) && utc(range.to()) && range.from().isBefore(range.to()));
        }
        if (value.status() == Status.SUCCESS) require(!value.items().isEmpty() && value.missingFields().isEmpty()
                && retention.missingRanges().isEmpty() && retention.unverifiedRanges().isEmpty());
        if (value.status() == Status.PARTIAL) require(!value.missingFields().isEmpty() || !retention.missingRanges().isEmpty());
        if (!DATA.contains(value.status()) || value.status() == Status.EMPTY) require(value.items().isEmpty());
        for (var item : value.items()) {
            require(item != null && text(item.ref(), 256) && item.text() != null && !item.text().isEmpty()
                    && unicode(item.text()) && item.values() != null && (item.time() == null || utc(item.time())));
            require(validUnicode(JSON.valueToTree(item.values())));
        }
    }

    public static boolean utc(Instant instant) {
        return instant != null && instant.toString().matches("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,9})?Z");
    }
    public static boolean text(String value, int max) { return value != null && unicode(value) && length(value) >= 1 && length(value) <= max; }
    private static int length(String value) { return value.codePointCount(0, value.length()); }
    public static boolean validUnicode(JsonNode value) {
        if (value.isString()) return unicode(value.asString());
        if (value.isObject()) {
            for (var entry : value.properties()) if (!unicode(entry.getKey()) || !validUnicode(entry.getValue())) return false;
        } else if (value.isArray()) for (var item : value) if (!validUnicode(item)) return false;
        return true;
    }
    private static boolean unicode(String value) {
        for (int index = 0; index < value.length(); index++) {
            char ch = value.charAt(index);
            if (Character.isHighSurrogate(ch)) {
                if (++index >= value.length() || !Character.isLowSurrogate(value.charAt(index))) return false;
            } else if (Character.isLowSurrogate(ch)) return false;
        }
        return true;
    }
    private static void require(boolean condition) { if (!condition) throw new InvalidResult(); }
}
