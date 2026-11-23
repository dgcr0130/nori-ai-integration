package example;

import com.nori.ai.integration.api.AiRequestIdentity;
import com.nori.ai.integration.api.AiRequestIdentityResolver;
import com.nori.ai.integration.api.AiToolItem;
import com.nori.ai.integration.api.AiToolRegistration;
import com.nori.ai.integration.api.AiToolResult;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;

@SpringBootApplication
public class CookieExampleApplication {
    public static void main(String[] args) { SpringApplication.run(CookieExampleApplication.class, args); }

    @Bean UserDetailsService exampleUsers(@Value("${example.login-password}") String password) {
        return new InMemoryUserDetailsManager(User.withUsername("reader_1").password("{noop}" + password)
                .authorities("DEMO_READ").build());
    }

    @Bean @Order(Ordered.LOWEST_PRECEDENCE)
    SecurityFilterChain businessSecurity(HttpSecurity http) throws Exception {
        return http.authorizeHttpRequests(auth -> auth.requestMatchers("/", "/index.html", "/host.js", "/error").permitAll()
                .anyRequest().authenticated()).formLogin(Customizer.withDefaults()).build();
    }

    @Bean AiRequestIdentityResolver identityResolver(UserDetailsService users) {
        return request -> {
            var session = request.getSession(false);
            if (session == null || !(session.getAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY)
                    instanceof SecurityContext context) || context.getAuthentication() == null
                    || !context.getAuthentication().isAuthenticated()) return new AiRequestIdentity(false, null, Set.of());
            // AI 체인은 업무 SecurityContext를 만들지 않으므로 기존 세션을 검증하고 현재 권한을 읽는다.
            var current = users.loadUserByUsername(context.getAuthentication().getName());
            if (!current.isEnabled() || !current.isAccountNonExpired() || !current.isAccountNonLocked()
                    || !current.isCredentialsNonExpired()) return new AiRequestIdentity(false, null, Set.of());
            return new AiRequestIdentity(true, current.getUsername(), current.getAuthorities().stream()
                    .map(authority -> authority.getAuthority()).collect(Collectors.toUnmodifiableSet()));
        };
    }

    @Bean AiToolRegistration exampleRead() {
        return AiToolRegistration.of("demo.record.read", call -> new AiToolResult(AiToolResult.Status.SUCCESS,
                List.of(new AiToolItem("demo:record:1", "중립 업무 자료", Map.of("recordId", "1"), null)),
                List.of(), List.of(), new AiToolResult.RetentionMeta(List.of(), List.of())));
    }
}
