package com.nori.ai.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.nori.ai.integration.api.AiToolItem;
import com.nori.ai.integration.api.AiToolResult;
import com.nori.ai.integration.api.AiToolResult.RetentionMeta;
import com.nori.ai.integration.api.AiToolResult.Status;
import com.nori.ai.integration.api.AiToolResult.TimeRange;
import com.nori.ai.integration.api.AiToolResult.Warning;
import com.nori.ai.integration.tool.AiToolEnvelopeAssembler;
import com.nori.ai.integration.tool.AiToolEnvelopeAssembler.Identity;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.IntStream;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

class AiToolResultBoundaryTest {
    @org.junit.jupiter.api.io.TempDir java.nio.file.Path directory;
    @org.junit.jupiter.api.AfterAll static void noTemporaryFilesOrThreadsRemain() {
        assertThat(AiInternalQueryTest.DIRECTORIES).noneMatch(java.nio.file.Files::exists);
        PhaseTwoFixtures.assertNoThreads();
    }
    static final Instant NOW = PhaseTwoFixtures.NOW;
    static final RetentionMeta NONE = new RetentionMeta(List.of(), List.of());
    static final Identity ID = new Identity("1", "Example_1", "12d55b20-b2e1-42d0-8e6f-fd151206f433", "example.read");
    final AiToolEnvelopeAssembler assembler = new AiToolEnvelopeAssembler();
    static AiToolItem item(String ref, String text, Instant time) { return new AiToolItem(ref, text, Map.of("fact", "값"), time); }
    static AiToolResult result(Status status, List<AiToolItem> items) {
        return new AiToolResult(status, items, status == Status.PARTIAL ? List.of("knownMissing") : List.of(), List.of(), NONE);
    }
    static AiToolResult success() { return result(Status.SUCCESS, List.of(item("ref", "본문_SECRET_MARKER", NOW))); }
    JsonNode assemble(AiToolResult result) { return PhaseTwoFixtures.JSON.readTree(assembler.assemble(ID, NOW, result).body()); }

    @ParameterizedTest @ValueSource(ints = {99, 100, 101})
    void itemCountKeepsFrontAndOneTimeRange(int count) {
        var items = IntStream.range(0, count).mapToObj(i -> item("r" + i, "사실", NOW.minusSeconds(i))).toList();
        var response = assembler.assemble(ID, NOW, result(Status.SUCCESS, items));
        GatewayContract.accept(response.http(), response.body());
        var body = PhaseTwoFixtures.JSON.readTree(response.body());
        assertThat(body.get("data").get("items").size()).isEqualTo(Math.min(count, 100));
        assertThat(body.get("data").get("items").get(0).get("ref").asString()).isEqualTo("r0");
        assertThat(body.toString()).doesNotContain("\"time\"");
        assertThat(body.get("status").asString()).isEqualTo(count > 100 ? "PARTIAL" : "SUCCESS");
        assertThat(body.get("missingFields").size()).isEqualTo(count > 100 ? 1 : 0);
        assertThat(body.get("retentionMeta").get("missingRanges").size()).isEqualTo(count > 100 ? 1 : 0);
        if (count > 100) assertThat(body.get("retentionMeta").get("missingRanges").get(0).get("to").asString())
                .isEqualTo(NOW.minusSeconds(100).plusNanos(1).toString());
    }

    @ParameterizedTest @ValueSource(ints = {3999, 4000, 4001})
    void supplementaryTextUsesCodePointsAndOnlyLongItemIsSkipped(int points) {
        String text = "😀".repeat(points);
        var value = result(Status.SUCCESS, List.of(item("first", text, NOW), item("next", "정상", NOW)));
        var body = assemble(value);
        assertThat(body.get("data").get("items").size()).isEqualTo(points > 4000 ? 1 : 2);
        assertThat(body.get("data").get("items").get(0).get("ref").asString()).isEqualTo(points > 4000 ? "next" : "first");
        GatewayContract.accept(200, PhaseTwoFixtures.JSON.writeValueAsBytes(body));
    }

    @Test void utf8LimitIncludesFinalMarkerAndRetainsPrefixAtExactBoundary() {
        var base = new AiToolItem("large", "본문", Map.of("blob", ""), NOW);
        int overhead = assembler.assemble(ID, NOW, result(Status.SUCCESS, List.of(base))).body().length;
        int capacity = AiToolEnvelopeAssembler.MAX_BYTES - overhead;
        for (int delta : List.of(-1, 0, 1)) {
            String blob = "가".repeat((capacity + delta) / 3) + "a".repeat((capacity + delta) % 3);
            var value = result(Status.SUCCESS, List.of(new AiToolItem("large", "본문", Map.of("blob", blob), NOW), item("tail", "뒤", NOW)));
            var response = assembler.assemble(ID, NOW, value);
            assertThat(response.body().length).isLessThanOrEqualTo(AiToolEnvelopeAssembler.MAX_BYTES);
            var body = PhaseTwoFixtures.JSON.readTree(response.body());
            // 뒤 항목과 절삭 표시를 위한 공간까지 부족하면 앞의 큰 항목도 제외한다.
            assertThat(body.get("missingFields").get(0).asString()).isEqualTo("truncatedItems");
            GatewayContract.accept(200, response.body());
            var single = assembler.assemble(ID, NOW, result(Status.SUCCESS, List.of(value.items().getFirst())));
            assertThat(PhaseTwoFixtures.JSON.readTree(single.body()).get("status").asString()).isEqualTo(delta <= 0 ? "SUCCESS" : "PARTIAL");
            if (delta <= 0) assertThat(single.body().length).isEqualTo(AiToolEnvelopeAssembler.MAX_BYTES + delta);
        }
    }

    @Test void truncationPreservesStatusesAndOnlyAllKnownTimesProduceOneRange() {
        for (Status status : List.of(Status.SUCCESS, Status.PARTIAL, Status.STALE, Status.CONFLICT)) {
            for (boolean known : List.of(false, true)) {
                var items = List.of(item("a", "x".repeat(4001), NOW.minusSeconds(2)),
                        item("b", "x".repeat(4001), known ? NOW : null), item("c", "정상", NOW));
                var body = assemble(result(status, items));
                assertThat(body.get("status").asString()).isEqualTo(status == Status.SUCCESS ? "PARTIAL" : status.name());
                var ranges = body.get("retentionMeta").get("missingRanges");
                assertThat(ranges.size()).isEqualTo(known ? 1 : 0);
                if (known) {
                    assertThat(ranges.get(0).get("from").asString()).isEqualTo(NOW.minusSeconds(2).toString());
                    assertThat(ranges.get(0).get("to").asString()).isEqualTo(NOW.plusNanos(1).toString());
                }
            }
        }
        var fields = new ArrayList<String>(); fields.add("truncatedItems"); fields.add("truncatedItems");
        for (int i = 2; i < 99; i++) fields.add("missing" + i);
        var ranges = java.util.Collections.nCopies(99, new TimeRange(NOW, NOW.plusSeconds(1)));
        var body = assemble(new AiToolResult(Status.PARTIAL, List.of(item("long", "x".repeat(4001), NOW)), fields,
                List.of(Warning.RETENTION_UNVERIFIED), new RetentionMeta(ranges, java.util.Collections.nCopies(100, new TimeRange(NOW, NOW.plusSeconds(1))))));
        var missing = new ArrayList<String>();
        body.get("missingFields").forEach(field -> missing.add(field.asString()));
        assertThat(missing).hasSize(100);
        assertThat(missing.subList(0, 99)).containsExactlyElementsOf(fields);
        assertThat(missing.stream().filter("truncatedItems"::equals).count()).isEqualTo(3);
        assertThat(missing.getLast()).isEqualTo("truncatedItems");
        assertThat(body.get("retentionMeta").get("missingRanges").size()).isEqualTo(100);
        GatewayContract.accept(200, PhaseTwoFixtures.JSON.writeValueAsBytes(body));
    }

    static Stream<AiToolResult> violations() {
        var one = success().items(); var range = new TimeRange(NOW, NOW.plusSeconds(1));
        return Stream.of(null,
                new AiToolResult(null, one, List.of(), List.of(), NONE),
                new AiToolResult(Status.SUCCESS, null, List.of(), List.of(), NONE),
                new AiToolResult(Status.SUCCESS, one, null, List.of(), NONE),
                new AiToolResult(Status.SUCCESS, one, List.of(), null, NONE),
                new AiToolResult(Status.SUCCESS, one, List.of(), List.of(), null),
                new AiToolResult(Status.SUCCESS, one, List.of(), List.of(), new RetentionMeta(null, List.of())),
                new AiToolResult(Status.SUCCESS, one, List.of(), List.of(), new RetentionMeta(List.of(), null)),
                result(Status.SUCCESS, List.of()), result(Status.EMPTY, one), result(Status.OUT_OF_RETENTION, one),
                result(Status.UNSUPPORTED, one), result(Status.DENIED, one), result(Status.FAILED, one),
                result(Status.SOURCE_UNAVAILABLE, one), result(Status.TIMEOUT, one),
                new AiToolResult(Status.PARTIAL, one, List.of(), List.of(), NONE),
                new AiToolResult(Status.SUCCESS, one, List.of("missing"), List.of(), NONE),
                new AiToolResult(Status.SUCCESS, one, List.of(), List.of(), new RetentionMeta(List.of(range), List.of())),
                new AiToolResult(Status.SUCCESS, one, List.of(), List.of(), new RetentionMeta(List.of(), List.of(range))),
                result(Status.STALE, List.of(item("", "비밀", NOW))),
                result(Status.STALE, List.of(item(null, "비밀", NOW))),
                result(Status.STALE, List.of(item("x".repeat(257), "비밀", NOW))),
                result(Status.STALE, List.of(item("r", "", NOW))),
                result(Status.STALE, List.of(item("r", null, NOW))),
                result(Status.STALE, List.of(new AiToolItem("r", "비밀", null, NOW))),
                result(Status.STALE, List.of(item("r", "\uD800", NOW))),
                result(Status.STALE, List.of(new AiToolItem("r", "비밀", Map.of("nested", List.of(Map.of("\uDC00", "비밀"))), NOW))),
                new AiToolResult(Status.PARTIAL, one, List.of(""), List.of(), NONE),
                new AiToolResult(Status.PARTIAL, one, List.of("x".repeat(129)), List.of(), NONE),
                new AiToolResult(Status.PARTIAL, one, java.util.Collections.nCopies(100, "missing"), List.of(), NONE),
                new AiToolResult(Status.PARTIAL, one, List.of(), List.of(), new RetentionMeta(java.util.Collections.nCopies(100, range), List.of())),
                new AiToolResult(Status.STALE, one, List.of(), List.of(), new RetentionMeta(List.of(new TimeRange(NOW, NOW)), List.of())),
                new AiToolResult(Status.STALE, one, List.of(), List.of(), new RetentionMeta(List.of(new TimeRange(NOW.plusSeconds(1), NOW)), List.of())),
                new AiToolResult(Status.STALE, one, List.of(), List.of(), new RetentionMeta(List.of(new TimeRange(null, NOW)), List.of())),
                new AiToolResult(Status.STALE, one, List.of(), List.of(Warning.RETENTION_UNVERIFIED, Warning.RETENTION_UNVERIFIED), NONE),
                new AiToolResult(Status.STALE, one, List.of(), List.of(), new RetentionMeta(List.of(), java.util.Collections.nCopies(101, range))));
    }

    @ParameterizedTest(name = "반환 위반 {index}") @MethodSource("violations")
    void everyReturnViolationIsRejectedBeforeTruncationAndLeaksNothing(AiToolResult value) throws Exception {
        try (var fixture = new AiInternalQueryTest.Fixture(directory)) {
            var logger = (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory.getLogger(com.nori.ai.integration.observability.AiRequestLog.class);
            var original = logger.getLevel(); var events = new ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent>();
            events.start(); logger.addAppender(events); logger.setLevel(ch.qos.logback.classic.Level.INFO);
            try {
                fixture.handler.set(call -> value);
                var response = fixture.send(fixture.body());
                AiInternalQueryTest.assertFailure(response, 503, "SOURCE_UNAVAILABLE", "SOURCE_UNAVAILABLE");
                assertThat(response.getContentAsString()).doesNotContain("SECRET_MARKER", "비밀", "knownMissing");
                var messages = events.list.stream().map(ch.qos.logback.classic.spi.ILoggingEvent::getFormattedMessage).toList();
                assertThat(messages).anyMatch(text -> text.contains("stage=relay httpStatus=503 code=SOURCE_UNAVAILABLE"));
                assertThat(String.join("\n", messages)).doesNotContain("SECRET_MARKER", "비밀");
            } finally { logger.detachAppender(events); events.stop(); logger.setLevel(original); }
        }
    }

    @Test void everyStatusHasGatewayCompatibleHttpAndDataAndTypedApiRejectsNonJsonValues() {
        for (Status status : Status.values()) {
            var value = result(status, Set.of(Status.SUCCESS, Status.PARTIAL, Status.STALE, Status.CONFLICT).contains(status) ? success().items() : List.of());
            var response = assembler.assemble(ID, NOW, value);
            int http = switch (status) { case DENIED -> 403; case SOURCE_UNAVAILABLE -> 503; case TIMEOUT -> 504; case FAILED -> 400; default -> 200; };
            assertThat(response.http()).isEqualTo(http);
            GatewayContract.accept(http, response.body());
            if (http != 200) {
                var withMissing = new AiToolResult(status, List.of(), List.of("source"), List.of(Warning.RETENTION_UNVERIFIED),
                        new RetentionMeta(List.of(new TimeRange(NOW, NOW.plusSeconds(1))), List.of()));
                var failure = assembler.assemble(ID, NOW, withMissing);
                GatewayContract.accept(http, failure.body());
                assertThat(PhaseTwoFixtures.JSON.readTree(failure.body()).get("missingFields").get(0).asString()).isEqualTo("source");
            }
        }
        assertThat(Warning.values()).containsExactly(Warning.RETENTION_UNVERIFIED);
        assertThatThrownBy(() -> Warning.valueOf("UNKNOWN")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> Status.valueOf("ACCEPTED_ASYNC")).isInstanceOf(IllegalArgumentException.class);
        assertThat(AiToolItem.class.getRecordComponents()[2].getType()).isEqualTo(Map.class);
        assertThatThrownBy(() -> new AiToolItem("r", "t", Map.of("bad", new Object()), NOW)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new AiToolItem("r", "t", Map.of("bad", Double.NaN), NOW)).isInstanceOf(IllegalArgumentException.class);
        var mutable = new ArrayList<Object>(); mutable.add("값");
        var item = new AiToolItem("r", "t", Map.of("array", mutable), NOW); mutable.clear();
        assertThat((List<?>) item.values().get("array")).hasSize(1);
    }

    @Test void invalidTailCannotBeHiddenByCountTextOrByteTruncation() {
        var values = new ArrayList<>(java.util.Collections.nCopies(100, item("valid", "정상", NOW)));
        values.add(item("", "x".repeat(4001), NOW));
        assertThatThrownBy(() -> assemble(result(Status.SUCCESS, values))).isInstanceOf(AiToolEnvelopeAssembler.InvalidResult.class);
    }

    /** 006 외피 전용 대역이다. 실제 Gateway와 outputSchema 검증을 대신하지 않는다. */
    static final class GatewayContract {
        static final JsonMapper JSON = JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
                .enable(tools.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
        static void accept(int http, byte[] bytes) {
            try {
                if (bytes.length > 1024 * 1024) throw new IllegalArgumentException();
                JsonNode node = JSON.readTree(bytes);
                assertThat(Set.copyOf(node.propertyNames())).isEqualTo(Set.of("version", "systemId", "jobId", "toolId", "status", "observedAt", "data", "missingFields", "warnings", "retentionMeta", "errorCode"));
                for (String name : List.of("version", "systemId", "jobId", "toolId")) assertThat(node.get(name).asString()).isEqualTo(switch (name) {
                    case "version" -> ID.version(); case "systemId" -> ID.systemId(); case "jobId" -> ID.jobId(); case "toolId" -> ID.toolId(); default -> throw new AssertionError(); });
                unicode(node); utc(node.get("observedAt"));
                Status status = Status.valueOf(node.get("status").asString());
                if (http == 200) {
                    assertThat(node.get("errorCode").isNull()).isTrue();
                    assertThat(status).isNotIn(Status.DENIED, Status.SOURCE_UNAVAILABLE, Status.TIMEOUT, Status.FAILED);
                } else {
                    assertThat(node.get("errorCode").asString()).isEqualTo(Map.of(400,"INPUT_INVALID",401,"SERVICE_AUTH_INVALID",403,"DELEGATION_DENIED",404,"TOOL_NOT_FOUND",409,"DELEGATION_CHANGED",429,"SOURCE_BUSY",503,"SOURCE_UNAVAILABLE",504,"TIMEOUT").get(http));
                    assertThat(status.name()).isEqualTo(Map.of(400,"FAILED",401,"DENIED",403,"DENIED",404,"FAILED",409,"DENIED",429,"SOURCE_UNAVAILABLE",503,"SOURCE_UNAVAILABLE",504,"TIMEOUT").get(http));
                }
                strings(node.get("missingFields"), 100, 128); strings(node.get("warnings"), 1, 128);
                for (var warning : node.get("warnings")) assertThat(warning.asString()).isEqualTo("RETENTION_UNVERIFIED");
                var retention = node.get("retentionMeta");
                assertThat(Set.copyOf(retention.propertyNames())).isEqualTo(Set.of("missingRanges", "unverifiedRanges"));
                for (String name : List.of("missingRanges", "unverifiedRanges")) {
                    assertThat(retention.get(name).isArray()).isTrue(); assertThat(retention.get(name).size()).isLessThanOrEqualTo(100);
                    for (var range : retention.get(name)) { assertThat(Set.copyOf(range.propertyNames())).isEqualTo(Set.of("from", "to")); assertThat(utc(range.get("from"))).isBefore(utc(range.get("to"))); }
                }
                if (Set.of(Status.SUCCESS, Status.EMPTY, Status.PARTIAL, Status.STALE, Status.CONFLICT).contains(status)) {
                    var data = node.get("data"); assertThat(Set.copyOf(data.propertyNames())).isEqualTo(Set.of("items"));
                    assertThat(data.get("items").isArray()).isTrue(); assertThat(data.get("items").size()).isLessThanOrEqualTo(100);
                    for (var item : data.get("items")) {
                        assertThat(Set.copyOf(item.propertyNames())).isEqualTo(Set.of("ref", "text", "values"));
                        assertThat(item.get("values").isObject()).isTrue();
                        assertThat(item.get("ref").isString()).isTrue(); assertThat(item.get("text").isString()).isTrue();
                        assertThat(item.get("ref").asString().codePointCount(0,item.get("ref").asString().length())).isBetween(1,256);
                        assertThat(item.get("text").asString().codePointCount(0,item.get("text").asString().length())).isBetween(1,4000);
                    }
                    if (status == Status.EMPTY) assertThat(data.get("items").isEmpty()).isTrue();
                    if (status == Status.SUCCESS) {
                        assertThat(data.get("items").isEmpty()).isFalse(); assertThat(node.get("missingFields").isEmpty()).isTrue();
                        assertThat(retention.get("missingRanges").isEmpty()).isTrue(); assertThat(retention.get("unverifiedRanges").isEmpty()).isTrue();
                    }
                    if (status == Status.PARTIAL) assertThat(node.get("missingFields").size() + retention.get("missingRanges").size()).isPositive();
                } else assertThat(node.get("data").isNull()).isTrue();
            } catch (RuntimeException | AssertionError invalid) { throw new IllegalArgumentException("CONTRACT_INVALID"); }
        }
        static Instant utc(JsonNode node) {
            assertThat(node.isString()).isTrue(); assertThat(node.asString()).matches("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,9})?Z");
            return Instant.parse(node.asString());
        }
        static void strings(JsonNode node, int max, int length) {
            assertThat(node.isArray()).isTrue(); assertThat(node.size()).isLessThanOrEqualTo(max);
            for (var value : node) { assertThat(value.isString()).isTrue(); assertThat(value.asString().codePointCount(0,value.asString().length())).isBetween(1,length); }
        }
        static void unicode(JsonNode node) {
            if (node.isString()) stringUnicode(node.asString());
            else if (node.isObject()) for (var entry : node.properties()) { stringUnicode(entry.getKey()); unicode(entry.getValue()); }
            else if (node.isArray()) node.forEach(GatewayContract::unicode);
        }
        static void stringUnicode(String text) {
            for (int i = 0; i < text.length(); i++) {
                char ch = text.charAt(i);
                if (Character.isHighSurrogate(ch)) { assertThat(++i).isLessThan(text.length()); assertThat(Character.isLowSurrogate(text.charAt(i))).isTrue(); }
                else assertThat(Character.isLowSurrogate(ch)).isFalse();
            }
        }
    }

    @Test void gatewayDoubleRejectsMalformedEnvelopesAndOversizeAsContractInvalid() {
        var normal = assembler.assemble(ID, NOW, success()); GatewayContract.accept(200, normal.body());
        assertThatThrownBy(() -> GatewayContract.accept(200, new byte[1024 * 1024 + 1])).hasMessage("CONTRACT_INVALID");
        assertThatThrownBy(() -> GatewayContract.accept(200, new byte[]{(byte) 0xc3, 0x28})).hasMessage("CONTRACT_INVALID");
        for (String text : List.of(new String(normal.body(), java.nio.charset.StandardCharsets.UTF_8) + " {}",
                new String(normal.body(), java.nio.charset.StandardCharsets.UTF_8).replace("\"version\":\"1\"", "\"version\":\"1\",\"version\":\"1\""))) {
            assertThatThrownBy(() -> GatewayContract.accept(200, text.getBytes(java.nio.charset.StandardCharsets.UTF_8))).hasMessage("CONTRACT_INVALID");
        }
        for (String mutation : List.of("extra", "status", "observedAt", "data", "errorCode", "version")) {
            var node = (tools.jackson.databind.node.ObjectNode) PhaseTwoFixtures.JSON.readTree(normal.body());
            if (mutation.equals("extra")) node.put("extra", 1); else node.put(mutation, "invalid");
            assertThatThrownBy(() -> GatewayContract.accept(200, PhaseTwoFixtures.JSON.writeValueAsBytes(node))).hasMessage("CONTRACT_INVALID");
        }
    }
}
