package com.nori.ai.integration.observability;

import com.nori.ai.integration.config.AiIntegrationAutoConfiguration;
import com.nori.ai.integration.config.AiIntegrationProperties;
import com.nori.ai.integration.security.AiIdentityService.Failure;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.json.JsonMapper;

public final class AiRequestLog {
    public static final String ATTRIBUTE = AiRequestLog.class.getName();
    private static final Logger LOG = LoggerFactory.getLogger(AiRequestLog.class);
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final Set<String> STAGES = Set.of("identity", "sign", "connect", "relay");
    private static final Set<String> CODES = Set.of("LOGIN_REQUIRED", "AUTH_UNAVAILABLE", "AUTH_RESULT_INVALID", "SIGNING_FAILED",
            "CSRF_INVALID", "GATEWAY_TIMEOUT", "GATEWAY_UNAVAILABLE", "INPUT_INVALID", "ROUTE_NOT_FOUND",
            "INVALID_INPUT", "NOT_FOUND", "REVIEW_CONFLICT", "REVIEW_FORBIDDEN", "ANSWER_NOT_READY", "KNOWLEDGE_UNAVAILABLE",
            "REQUEST_FORBIDDEN", "AUTHENTICATION_FAILED", "IDEMPOTENCY_KEY_CONFLICT", "CONVERSATION_ACTIVE",
            "QUEUE_FULL", "MODEL_LOADING", "MODEL_CONTEXT_MISMATCH", "MODEL_DIGEST_MISMATCH", "INFERENCE_UNAVAILABLE",
            "INPUT_BUDGET_EXCEEDED", "PLAN_INVALID", "LLM_UNAVAILABLE", "RESOURCE_NOT_FOUND", "TIME_WINDOW_REQUIRED",
            "QUEUE_TIMEOUT", "WORKER_INTERRUPTED", "CONTRACT_INVALID", "SYSTEM_SCOPE_MISMATCH");
    private final String system;
    private final UUID requestId = UUID.randomUUID();
    private final long started = System.nanoTime();

    public AiRequestLog(AiIntegrationProperties properties) { system = properties.systemId(); }
    public String requestId() { return requestId.toString(); }

    public void record(String stage, Integer status, String code, String gatewayRequestId, String jobId) {
        if (!STAGES.contains(stage)) throw new IllegalArgumentException("AI 로그 단계가 잘못되었습니다.");
        LOG.info("systemId={} integrationVersion={} requestId={} gatewayRequestId={} jobId={} toolId=null direction=browser-to-gateway stage={} httpStatus={} code={} elapsedMs={}",
                system, AiIntegrationAutoConfiguration.INTEGRATION_VERSION, requestId, identifier(gatewayRequestId),
                identifier(jobId), stage, status, safeCode(code), (System.nanoTime() - started) / 1_000_000);
    }

    public void error(HttpServletResponse response, Failure failure) throws IOException {
        String errorMessage = message(failure.code());
        record(failure.stage(), response.isCommitted() ? response.getStatus() : failure.status(), failure.code(), null, null);
        if (response.isCommitted()) return;
        response.resetBuffer();
        response.setStatus(failure.status());
        response.setHeader("X-Request-Id", requestId());
        response.setHeader("Cache-Control", "no-store");
        response.setContentType("application/json");
        response.setCharacterEncoding("UTF-8");
        response.getOutputStream().write(JSON.writeValueAsBytes(Map.of("code", failure.code(),
                "message", errorMessage, "requestId", requestId())));
    }

    private static String message(String code) {
        return switch (code) {
            case "LOGIN_REQUIRED" -> "로그인이 필요합니다.";
            case "AUTH_UNAVAILABLE" -> "로그인 정보를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.";
            case "AUTH_RESULT_INVALID" -> "로그인 정보 처리에 오류가 발생했습니다.";
            case "SIGNING_FAILED" -> "AI 요청 인증 정보를 만들 수 없습니다.";
            case "CSRF_INVALID" -> "요청 보안 정보를 확인해 주세요.";
            case "GATEWAY_TIMEOUT" -> "AI 응답 대기 시간이 초과되었습니다.";
            case "GATEWAY_UNAVAILABLE" -> "AI 서비스에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.";
            case "INPUT_INVALID" -> "요청 입력을 확인해 주세요.";
            case "ROUTE_NOT_FOUND" -> "요청한 AI 경로를 찾을 수 없습니다.";
            default -> throw new IllegalArgumentException("AI 오류 메시지가 정의되지 않았습니다.");
        };
    }

    private static String identifier(String value) {
        return value != null && value.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}") ? value : null;
    }
    private static String safeCode(String value) {
        return value != null && CODES.contains(value) ? value : null;
    }
}
