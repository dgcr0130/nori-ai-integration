package com.nori.ai.integration.config;

import com.nori.ai.integration.api.AiRequestIdentityResolver;
import com.nori.ai.integration.api.AiToolRegistration;
import com.nori.ai.integration.security.AiSecurityConfiguration;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashSet;
import java.util.List;
import java.util.Properties;
import java.util.Set;
import org.springframework.beans.factory.SmartInitializingSingleton;
import org.springframework.beans.factory.config.ConfigurableListableBeanFactory;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionOutcome;
import org.springframework.boot.autoconfigure.condition.SpringBootCondition;
import org.springframework.boot.context.properties.bind.BindException;
import org.springframework.boot.context.properties.bind.BindHandler;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.bind.handler.NoUnboundElementsBindHandler;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.ConditionContext;
import org.springframework.context.annotation.Conditional;
import org.springframework.context.annotation.Import;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.type.AnnotatedTypeMetadata;

@AutoConfiguration
@Conditional(AiIntegrationAutoConfiguration.EnabledCondition.class)
@Import(AiSecurityConfiguration.class)
public class AiIntegrationAutoConfiguration {
    public static final String INTEGRATION_VERSION = readVersion();

    @Bean
    AiIntegrationProperties aiIntegrationProperties(ConfigurableEnvironment environment) {
        AiIntegrationProperties.checkDuplicateKeys(environment);
        final AiIntegrationProperties properties;
        try {
            properties = Binder.get(environment).bind("nori.ai.integration",
                    Bindable.of(AiIntegrationProperties.class),
                    new NoUnboundElementsBindHandler(BindHandler.DEFAULT)).get();
        } catch (BindException exception) {
            // Binder 원문에는 입력값이 들어갈 수 있어 속성 경로와 오류 종류만 남긴다.
            throw new IllegalStateException("AI 연동 설정 바인딩 오류: " + exception.getName()
                    + " (" + exception.getCause().getClass().getSimpleName() + ")");
        }
        properties.validate();
        return properties;
    }

    @Bean
    SmartInitializingSingleton aiIntegrationRegistrationValidator(
            AiIntegrationProperties properties, ConfigurableListableBeanFactory beanFactory) {
        return () -> {
            if (beanFactory.getBeanNamesForType(AiRequestIdentityResolver.class).length != 1) {
                throw new IllegalStateException("활성 AI 연동에는 인증 resolver Bean이 정확히 하나 필요합니다.");
            }
            List<AiToolRegistration> registrations = beanFactory.getBeansOfType(AiToolRegistration.class)
                    .values().stream().toList();
            Set<String> registeredIds = new HashSet<>();
            for (AiToolRegistration registration : registrations) {
                if (!registeredIds.add(registration.toolId())) {
                    throw new IllegalStateException("AI 도구 처리기 ID가 중복되었습니다.");
                }
            }
            Set<String> configuredIds = new HashSet<>();
            properties.tools().forEach(tool -> configuredIds.add(tool.id()));
            if (!registeredIds.equals(configuredIds)) {
                throw new IllegalStateException("AI 설정 도구와 처리기 등록은 일대일이어야 합니다.");
            }
        };
    }

    private static String readVersion() {
        try (InputStream stream = AiIntegrationAutoConfiguration.class.getResourceAsStream(
                "/META-INF/ai-integration/version.properties")) {
            if (stream == null) throw new IllegalStateException("AI 연동 버전 자원이 없습니다.");
            Properties properties = new Properties();
            properties.load(stream);
            String version = properties.getProperty("integrationVersion");
            if (version == null || version.isBlank()) {
                throw new IllegalStateException("AI 연동 버전이 비어 있습니다.");
            }
            return version;
        } catch (IOException exception) {
            throw new IllegalStateException("AI 연동 버전 자원을 읽을 수 없습니다.");
        }
    }

    public static final class EnabledCondition extends SpringBootCondition {
        @Override
        public ConditionOutcome getMatchOutcome(ConditionContext context, AnnotatedTypeMetadata metadata) {
            String enabled = context.getEnvironment().getProperty("nori.ai.integration.enabled", "false");
            if (!enabled.equals("true") && !enabled.equals("false")) {
                throw new IllegalStateException("nori.ai.integration.enabled는 true 또는 false여야 합니다.");
            }
            return new ConditionOutcome(enabled.equals("true"), "AI 연동 활성 설정");
        }
    }
}
