package com.nori.ai.integration.web;

import com.nori.ai.integration.api.AiRequestIdentity;
import com.nori.ai.integration.config.AiIntegrationAutoConfiguration;
import com.nori.ai.integration.config.AiIntegrationProperties;
import com.nori.ai.integration.observability.AiRequestLog;
import com.nori.ai.integration.security.AiActorSigner;
import com.nori.ai.integration.security.AiIdentityService.Failure;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.springframework.security.web.csrf.CsrfToken;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.json.JsonMapper;

/** Security 체인에서만 호출하여 호스트의 MVC 스캔·응답 advice에 의존하지 않는다. */
public final class AiBrowserController {
    public static final String IDENTITY = AiBrowserController.class.getName() + ".identity";
    private record Route(String method, Pattern path) {}
    private static final String ID = "[A-Za-z0-9_-]+";
    private static final List<Route> ROUTES = List.of(
            route("POST", "/v1/query"), route("POST", "/v1/conversations"), route("GET", "/v1/conversations"),
            route("GET", "/v1/conversations/" + ID), route("DELETE", "/v1/conversations/" + ID),
            route("POST", "/v1/conversations/" + ID + "/messages"), route("POST", "/v1/analyses"),
            route("GET", "/v1/analyses/" + ID), route("POST", "/v1/analyses/" + ID + "/cancel"),
            route("GET", "/v1/analyses/" + ID + "/events"),
            route("GET", "/v1/analyses/" + ID + "/evidence/" + ID + "/source"),
            route("GET", "/v1/analyses/" + ID + "/blocks/" + ID + "/export"),
            route("GET", "/v1/audit/jobs/" + ID), route("PUT", "/v1/answers/" + ID + "/feedback"),
            route("GET", "/v1/reviews"), route("GET", "/v1/reviews/" + ID), route("POST", "/v1/reviews/" + ID + "/resolve"));
    private final AiIntegrationProperties properties;
    private final AiActorSigner signer;
    private final AiGatewayRelay gateway;
    private final AiSseRelay sse;
    private final JsonMapper json = JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();

    public AiBrowserController(AiIntegrationProperties properties, AiActorSigner signer, AiGatewayRelay gateway, AiSseRelay sse) {
        this.properties = properties;
        this.signer = signer;
        this.gateway = gateway;
        this.sse = sse;
    }

    public static String path(HttpServletRequest request) {
        return request.getRequestURI().substring(request.getContextPath().length());
    }
    public static boolean asset(HttpServletRequest request) {
        return request.getMethod().equals("GET") && path(request).equals("/api/ai/assets/widget.js");
    }

    public void handle(HttpServletRequest request, HttpServletResponse response) throws IOException {
        var log = (AiRequestLog) request.getAttribute(AiRequestLog.ATTRIBUTE);
        try {
            if (asset(request)) {
                response.setContentType("application/javascript");
                response.setHeader("Cache-Control", "no-cache");
                try (var resource = getClass().getResourceAsStream("/META-INF/ai-integration/widget.js")) {
                    if (resource == null) throw new IllegalStateException("AI 위젯 자산이 없습니다.");
                    resource.transferTo(response.getOutputStream());
                }
                log.record("relay", 200, null, null, null);
                return;
            }
            var identity = (AiRequestIdentity) request.getAttribute(IDENTITY);
            if (request.getMethod().equals("GET") && path(request).equals("/api/ai/session")) {
                Map<String, Object> session = new LinkedHashMap<>();
                session.put("subject", identity.subject());
                session.put("canReview", identity.permissionCodes().contains(properties.reviewPermission()));
                session.put("integrationVersion", AiIntegrationAutoConfiguration.INTEGRATION_VERSION);
                var csrf = properties.browserCredential() == AiIntegrationProperties.BrowserCredential.COOKIE
                        ? (CsrfToken) request.getAttribute(CsrfToken.class.getName()) : null;
                session.put("csrf", csrf == null ? null : Map.of("headerName", csrf.getHeaderName(), "token", csrf.getToken()));
                response.setContentType("application/json");
                response.getOutputStream().write(json.writeValueAsBytes(session));
                log.record("identity", 200, null, null, null);
                return;
            }
            String target = path(request).substring("/api/ai".length());
            if (ROUTES.stream().noneMatch(route -> route.method().equals(request.getMethod()) && route.path().matcher(target).matches())) {
                throw new Failure(404, "ROUTE_NOT_FOUND", "relay");
            }
            byte[] body = request.getInputStream().readAllBytes();
            guardBody(body);
            boolean job = request.getMethod().equals("POST") && (target.equals("/v1/query") || target.equals("/v1/analyses")
                    || target.matches("/v1/conversations/" + ID + "/messages"));
            String assertion = job ? signer.signJob(identity) : signer.sign(identity, null);
            log.record("sign", null, null, null, null);
            var upstream = gateway.prepare(request, target, body, assertion);
            if (request.getMethod().equals("GET") && target.endsWith("/events")) sse.start(request, response, upstream, identity, log);
            else gateway.ordinary(upstream, response, log);
        } catch (Failure failure) { log.error(response, failure); }
    }

    private void guardBody(byte[] body) {
        if (body.length == 0) return;
        try {
            var node = json.readTree(body);
            if (node != null && node.isObject()) {
                for (String field : List.of("contextRef", "subject", "permissionCodes", "perm", "pdg", "dlg", "actorAssertion")) {
                    if (node.has(field)) throw new Failure(400, "INPUT_INVALID", "relay");
                }
            }
        } catch (tools.jackson.core.JacksonException failure) { throw new Failure(400, "INPUT_INVALID", "relay"); }
    }

    private static Route route(String method, String path) { return new Route(method, Pattern.compile(path)); }
}
