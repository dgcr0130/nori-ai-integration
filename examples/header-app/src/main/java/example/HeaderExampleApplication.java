package example;

import com.nori.ai.integration.api.AiRequestIdentity;
import com.nori.ai.integration.api.AiRequestIdentityResolver;
import com.nori.ai.integration.api.AiToolItem;
import com.nori.ai.integration.api.AiToolRegistration;
import com.nori.ai.integration.api.AiToolResult;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;

@SpringBootApplication
public class HeaderExampleApplication {
    public static void main(String[] args) { SpringApplication.run(HeaderExampleApplication.class, args); }

    @Bean @Order(Ordered.LOWEST_PRECEDENCE)
    SecurityFilterChain businessSecurity(HttpSecurity http) throws Exception {
        // 이 중립 예제의 업무 기능은 없고 화면 자산만 공개한다. AI 인증은 resolver가 소유한다.
        return http.sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .csrf(csrf -> csrf.disable()).authorizeHttpRequests(auth -> auth
                        .requestMatchers("/", "/index.html", "/host.js", "/error").permitAll().anyRequest().denyAll()).build();
    }

    @Bean AiRequestIdentityResolver identityResolver(@Value("${example.login-token}") String token) {
        if (token.isBlank() || token.chars().anyMatch(Character::isWhitespace)) {
            throw new IllegalStateException("예제 로그인 토큰 형식을 확인해 주세요.");
        }
        byte[] expected = ("Bearer " + token).getBytes(StandardCharsets.UTF_8);
        return request -> {
            String authorization = request.getHeader("Authorization");
            if (authorization == null || !MessageDigest.isEqual(expected, authorization.getBytes(StandardCharsets.UTF_8))) {
                return new AiRequestIdentity(false, null, Set.of());
            }
            return new AiRequestIdentity(true, "reader_1", Set.of("DEMO_READ"));
        };
    }

    @Bean AiToolRegistration exampleRead() {
        return AiToolRegistration.of("demo.record.read", call -> new AiToolResult(AiToolResult.Status.SUCCESS,
                List.of(new AiToolItem("demo:record:1", "중립 업무 자료", Map.of("recordId", "1"), null)),
                List.of(), List.of(), new AiToolResult.RetentionMeta(List.of(), List.of())));
    }
}
