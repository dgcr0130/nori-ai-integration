package com.nori.ai.integration.web;

import com.nori.ai.integration.api.AiToolCall;
import com.nori.ai.integration.api.AiToolRegistration;
import com.nori.ai.integration.config.AiIntegrationProperties;
import com.nori.ai.integration.observability.AiRequestLog;
import com.nori.ai.integration.security.AiDelegationCodec;
import com.nori.ai.integration.security.AiIdentityService.Failure;
import com.nori.ai.integration.tool.AiToolDispatcher;
import com.nori.ai.integration.tool.AiToolEnvelopeAssembler;
import com.nori.ai.integration.tool.AiToolEnvelopeAssembler.Identity;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;
import tools.jackson.core.JacksonException;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** 인증 우선 판정과 제한된 본문 복원을 하나의 내부 HTTP 경계에서 수행한다. */
public final class AiInternalQueryController {
    public static final String PATH = "/internal/ai/v1/query";
    public static final int MAX_REQUEST_BYTES = 64 * 1024;
    private static final Set<String> FIELDS = Set.of("version", "systemId", "jobId", "toolId", "subject",
            "delegationId", "permissionDigest", "arguments", "targets", "deadline");
    private static final Set<String> STRINGS = Set.of("version", "systemId", "jobId", "toolId", "subject", "delegationId", "permissionDigest", "deadline");
    private static final JsonMapper JSON = JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
    private final AiIntegrationProperties properties;
    private final AiDelegationCodec codec;
    private final AiToolDispatcher dispatcher;
    private final AiToolEnvelopeAssembler assembler;
    private final Map<String, AiToolRegistration> handlers;
    private final Clock clock;
    private final byte[] tokenHash;

    public AiInternalQueryController(AiIntegrationProperties properties, AiDelegationCodec codec,
            AiToolDispatcher dispatcher, AiToolEnvelopeAssembler assembler, List<AiToolRegistration> handlers, Clock clock) {
        this.properties = properties; this.codec = codec; this.dispatcher = dispatcher; this.assembler = assembler; this.clock = clock;
        var registered = new LinkedHashMap<String, AiToolRegistration>();
        handlers.forEach(handler -> {
            if (registered.putIfAbsent(handler.toolId(), handler) != null) throw new IllegalStateException("AI 도구 등록 중복");
        });
        this.handlers = Map.copyOf(registered);
        try {
            tokenHash = properties.gatewayTokenFile() == null ? null
                    : hash(Files.readString(properties.gatewayTokenFile(), StandardCharsets.UTF_8).strip());
        } catch (IOException failure) { throw new IllegalStateException("AI 내부 서비스 자격을 읽을 수 없습니다."); }
    }

    public void handle(HttpServletRequest request, HttpServletResponse response) throws IOException {
        Instant received = clock.instant();
        var observedAt = new AtomicReference<>(received);
        var log = new AiRequestLog(properties);
        response.setHeader("X-Request-Id", log.requestId());
        response.setHeader("Cache-Control", "no-store");
        log.internal("delegate", null, null, null, null);
        // 인증을 먼저 확정하며 본문은 식별값 복원에도 같은 상한으로만 읽는다.
        boolean authenticated = authenticated(request);
        byte[] bytes = request.getInputStream().readNBytes(MAX_REQUEST_BYTES + 1);
        JsonNode body = parse(bytes);
        Identity id = identity(body);
        AiToolEnvelopeAssembler.Response result;
        try {
            if (!authenticated) throw new Failure(401, "SERVICE_AUTH_INVALID", "delegate");
            validateBody(request, bytes, body);
            if (!body.get("version").asString().equals("1")) throw input();
            if (!body.get("systemId").asString().equals(properties.systemId())) throw denied();
            equalHeader(request, "X-Request-Id", body.get("jobId").asString());
            equalHeader(request, "X-Actor-Subject", body.get("subject").asString());
            equalHeader(request, "X-Delegation-Id", body.get("delegationId").asString());
            String pdg = body.get("permissionDigest").asString();
            if (!pdg.matches("[0-9a-f]{64}")) throw input();
            var delegation = verify(body, pdg);
            String toolId = body.get("toolId").asString();
            var handler = handlers.get(toolId);
            var tool = properties.tools().stream().filter(value -> value.id().equals(toolId)).findFirst().orElse(null);
            if (handler == null || tool == null) throw new Failure(404, "TOOL_NOT_FOUND", "delegate");
            if (!delegation.permissions().containsAll(tool.requiredPermissions())) throw denied();
            if (!body.get("arguments").isObject()) throw input();
            var targets = targets(body.get("targets"));
            Instant deadline = deadline(body.get("deadline").asString());
            Instant end = deadline.isBefore(delegation.expiresAt()) ? deadline : delegation.expiresAt();
            if (!clock.instant().isBefore(end)) throw new Failure(504, "TIMEOUT", "delegate");
            Map<String, Object> arguments = object(body.get("arguments"));
            var completed = dispatcher.execute(handler.handler(), end, observed -> {
                observedAt.set(observed);
                return new AiToolCall(properties.systemId(), id.jobId(), toolId, body.get("subject").asString(),
                        delegation.permissions(), arguments, targets, end, observed);
            });
            try { result = assembler.assemble(id, completed.observedAt(), completed.result()); }
            catch (AiToolEnvelopeAssembler.InvalidResult | JacksonException invalid) { throw new Failure(503, "SOURCE_UNAVAILABLE", "relay"); }
            if (!clock.instant().isBefore(end)) throw new Failure(504, "TIMEOUT", "handler");
            log.internal("relay", result.http(), result.code(), id.jobId(), id.toolId());
        } catch (Failure failure) {
            log.internal(failure.stage(), failure.status(), failure.code(), id.jobId(),
                    id.toolId() != null && handlers.containsKey(id.toolId()) ? id.toolId() : null);
            result = assembler.failure(id, observedAt.get(), failure.status(), failure.code());
        }
        response.setStatus(result.http()); response.setContentType("application/json"); response.setCharacterEncoding("UTF-8");
        response.getOutputStream().write(result.body());
    }

    private AiDelegationCodec.Verified verify(JsonNode body, String pdg) {
        try { return codec.verify(body.get("delegationId").asString(), body.get("subject").asString(), pdg); }
        catch (Failure failure) {
            if (failure.status() == 500 && failure.code().equals("SIGNING_FAILED")) throw new Failure(503, "SOURCE_UNAVAILABLE", "sign");
            throw failure;
        }
    }
    private boolean authenticated(HttpServletRequest request) {
        var values = Collections.list(request.getHeaders("Authorization"));
        if (values.size() != 1 || !values.getFirst().matches("Bearer [^\\s]+") || tokenHash == null) return false;
        return MessageDigest.isEqual(tokenHash, hash(values.getFirst().substring(7)));
    }
    private static byte[] hash(String value) {
        try { return MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)); }
        catch (NoSuchAlgorithmException failure) { throw new IllegalStateException("SHA-256을 사용할 수 없습니다."); }
    }
    private static JsonNode parse(byte[] bytes) {
        if (bytes.length > MAX_REQUEST_BYTES) return null;
        try {
            String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            return JSON.readTree(text);
        } catch (JacksonException | CharacterCodingException invalid) { return null; }
    }
    private static Identity identity(JsonNode body) {
        return new Identity(string(body, "version"), string(body, "systemId"), string(body, "jobId"), string(body, "toolId"));
    }
    private static String string(JsonNode body, String name) {
        return body != null && body.isObject() && body.has(name) && body.get(name).isString() ? body.get(name).asString() : null;
    }
    private static void validateBody(HttpServletRequest request, byte[] bytes, JsonNode body) {
        String type = request.getContentType();
        if (type == null || !type.split(";", 2)[0].strip().equalsIgnoreCase("application/json")
                || bytes.length > MAX_REQUEST_BYTES || body == null || !body.isObject()
                || !Set.copyOf(body.propertyNames()).equals(FIELDS) || !AiToolEnvelopeAssembler.validUnicode(body)) throw input();
        for (String name : STRINGS) if (!body.get(name).isString()) throw input();
        // 객체 내용과 targets의 상세 형식은 위임·도구 검사 뒤의 7단계가 소유한다.
    }
    private static void equalHeader(HttpServletRequest request, String name, String expected) {
        var values = Collections.list(request.getHeaders(name));
        if (values.size() != 1 || !values.getFirst().equals(expected)) throw input();
    }
    private static List<AiToolCall.Target> targets(JsonNode targets) {
        if (!targets.isArray() || targets.size() > 16) throw input();
        var result = new ArrayList<AiToolCall.Target>();
        for (var target : targets) {
            if (!target.isObject() || !Set.copyOf(target.propertyNames()).equals(Set.of("type", "ref"))) throw input();
            String type = string(target, "type"), ref = string(target, "ref");
            if (!AiToolEnvelopeAssembler.text(type, 256) || !AiToolEnvelopeAssembler.text(ref, 256)) throw input();
            result.add(new AiToolCall.Target(type, ref));
        }
        return List.copyOf(result);
    }
    private static Instant deadline(String value) {
        if (!value.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,9})?Z")) throw input();
        try { return Instant.parse(value); }
        catch (DateTimeParseException invalid) { throw input(); }
    }
    private static Map<String, Object> object(JsonNode node) {
        var result = new LinkedHashMap<String, Object>();
        node.properties().forEach(entry -> result.put(entry.getKey(), value(entry.getValue())));
        return result;
    }
    private static Object value(JsonNode node) {
        if (node.isObject()) return object(node);
        if (node.isArray()) { var list = new ArrayList<Object>(); node.forEach(item -> list.add(value(item))); return list; }
        if (node.isNull()) return null;
        if (node.isString()) return node.asString();
        if (node.isBoolean()) return node.asBoolean();
        if (node.isIntegralNumber()) return node.bigIntegerValue();
        return node.decimalValue();
    }
    private static Failure input() { return new Failure(400, "INPUT_INVALID", "delegate"); }
    private static Failure denied() { return new Failure(403, "DELEGATION_DENIED", "delegate"); }
}
