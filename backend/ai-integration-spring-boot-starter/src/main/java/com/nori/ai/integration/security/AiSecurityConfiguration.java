package com.nori.ai.integration.security;

import com.nori.ai.integration.api.AiRequestIdentityResolver;
import com.nori.ai.integration.api.AiToolRegistration;
import com.nori.ai.integration.config.AiIntegrationProperties;
import com.nori.ai.integration.observability.AiRequestLog;
import com.nori.ai.integration.web.AiBrowserController;
import com.nori.ai.integration.web.AiGatewayRelay;
import com.nori.ai.integration.web.AiSseRelay;
import com.nori.ai.integration.web.AiInternalQueryController;
import com.nori.ai.integration.tool.AiToolDispatcher;
import com.nori.ai.integration.tool.AiToolEnvelopeAssembler;
import jakarta.servlet.Filter;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.time.Clock;
import java.util.Arrays;
import java.util.Set;
import java.util.List;
import org.springframework.beans.factory.BeanFactoryUtils;
import org.springframework.beans.factory.SmartInitializingSingleton;
import org.springframework.beans.factory.config.ConfigurableListableBeanFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.access.intercept.AuthorizationFilter;
import org.springframework.security.web.csrf.CookieCsrfTokenRepository;
import org.springframework.security.web.csrf.CsrfFilter;
import org.springframework.security.web.csrf.CsrfTokenRequestAttributeHandler;

@Configuration(proxyBeanMethods = false)
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
@EnableWebSecurity
public class AiSecurityConfiguration {
    public static final int BROWSER_ORDER = Ordered.HIGHEST_PRECEDENCE + 100;
    public static final int INTERNAL_ORDER = Ordered.HIGHEST_PRECEDENCE;
    // 내부 체인을 추가할 때도 공통 jar의 체인 이름은 이 집합에서 함께 관리한다.
    private static final Set<String> INTEGRATION_CHAIN_BEAN_NAMES = Set.of("aiBrowserSecurityFilterChain", "aiInternalSecurityFilterChain");

    @Bean AiToolDispatcher aiToolDispatcher() { return new AiToolDispatcher(Clock.systemUTC()); }
    @Bean AiToolEnvelopeAssembler aiToolEnvelopeAssembler() { return new AiToolEnvelopeAssembler(); }
    @Bean AiInternalQueryController aiInternalQueryController(AiIntegrationProperties properties, AiDelegationCodec codec,
            AiToolDispatcher dispatcher, AiToolEnvelopeAssembler assembler, List<AiToolRegistration> registrations) {
        return new AiInternalQueryController(properties, codec, dispatcher, assembler, registrations, Clock.systemUTC());
    }

    @Bean
    @Order(INTERNAL_ORDER)
    SecurityFilterChain aiInternalSecurityFilterChain(HttpSecurity http, AiInternalQueryController controller) throws Exception {
        Filter endpoint = (input, output, chain) -> controller.handle((HttpServletRequest) input, (HttpServletResponse) output);
        return http.securityMatcher(request -> request.getMethod().equals("POST")
                        && AiBrowserController.path(request).equals(AiInternalQueryController.PATH))
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .requestCache(cache -> cache.disable()).securityContext(context -> context.disable())
                .csrf(csrf -> csrf.disable()).headers(headers -> headers.cacheControl(cache -> cache.disable()))
                .authorizeHttpRequests(authorize -> authorize.anyRequest().permitAll())
                .addFilterBefore(endpoint, AuthorizationFilter.class).build();
    }

    @Bean
    SmartInitializingSingleton aiHostSecurityChainValidator(ConfigurableListableBeanFactory beanFactory) {
        return () -> {
            String[] chains = BeanFactoryUtils.beanNamesForTypeIncludingAncestors(beanFactory, SecurityFilterChain.class);
            if (Arrays.stream(chains).allMatch(INTEGRATION_CHAIN_BEAN_NAMES::contains)) {
                throw new IllegalStateException("AI 연동을 켜려면 호스트 앱에 기존 업무 Spring Security 체인이 필요합니다.");
            }
        };
    }

    @Bean AiIdentityService aiIdentityService(AiRequestIdentityResolver resolver, AiIntegrationProperties properties) {
        return new AiIdentityService(resolver, properties);
    }
    @Bean AiDelegationCodec aiDelegationCodec(AiIntegrationProperties properties) {
        return new AiDelegationCodec(properties, Clock.systemUTC());
    }
    @Bean AiActorSigner aiActorSigner(AiIntegrationProperties properties, AiDelegationCodec codec) {
        return new AiActorSigner(properties, codec, Clock.systemUTC());
    }
    @Bean AiGatewayRelay aiGatewayRelay(AiIntegrationProperties properties) { return new AiGatewayRelay(properties); }
    @Bean AiSseRelay aiSseRelay(AiGatewayRelay gateway, AiIdentityService identities) { return new AiSseRelay(gateway, identities); }
    @Bean AiBrowserController aiBrowserController(AiIntegrationProperties properties, AiActorSigner signer,
            AiGatewayRelay gateway, AiSseRelay sse) { return new AiBrowserController(properties, signer, gateway, sse); }

    @Bean
    @Order(BROWSER_ORDER)
    SecurityFilterChain aiBrowserSecurityFilterChain(HttpSecurity http, AiIntegrationProperties properties,
            AiIdentityService identities, AiBrowserController controller) throws Exception {
        http.securityMatcher(request -> AiBrowserController.path(request).equals("/api/ai")
                        || AiBrowserController.path(request).startsWith("/api/ai/"))
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .requestCache(cache -> cache.disable())
                .securityContext(context -> context.disable())
                .headers(headers -> headers.cacheControl(cache -> cache.disable()))
                .authorizeHttpRequests(authorize -> authorize.anyRequest().permitAll());
        if (properties.browserCredential() == AiIntegrationProperties.BrowserCredential.HEADER) http.csrf(csrf -> csrf.disable());
        else {
            var repository = new CookieCsrfTokenRepository();
            repository.setCookieName("NORI_AI_XSRF");
            repository.setHeaderName("X-Nori-AI-CSRF");
            repository.setCookiePath("/");
            repository.setCookieCustomizer(cookie -> cookie.sameSite("Strict"));
            http.csrf(csrf -> csrf.csrfTokenRepository(repository)
                    .csrfTokenRequestHandler(new CsrfTokenRequestAttributeHandler()));
        }
        http.exceptionHandling(exceptions -> exceptions.accessDeniedHandler((request, response, failure) ->
                ((AiRequestLog) request.getAttribute(AiRequestLog.ATTRIBUTE)).error(response,
                        new AiIdentityService.Failure(403, "CSRF_INVALID", "identity"))));
        Filter identity = (input, output, chain) -> {
            var request = (HttpServletRequest) input;
            var response = (HttpServletResponse) output;
            var log = new AiRequestLog(properties);
            request.setAttribute(AiRequestLog.ATTRIBUTE, log);
            response.setHeader("X-Request-Id", log.requestId());
            response.setHeader("Cache-Control", "no-store");
            log.record("identity", null, null, null, null);
            try {
                if (!AiBrowserController.asset(request)) request.setAttribute(AiBrowserController.IDENTITY, identities.current(request));
                chain.doFilter(input, output);
            } catch (AiIdentityService.Failure failure) { log.error(response, failure); }
        };
        Filter endpoint = (input, output, chain) -> controller.handle((HttpServletRequest) input, (HttpServletResponse) output);
        http.addFilterBefore(identity, CsrfFilter.class);
        http.addFilterBefore(endpoint, AuthorizationFilter.class);
        return http.build();
    }
}
