package com.nori.ai.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.nori.ai.integration.config.AiIntegrationAutoConfiguration;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Properties;
import java.util.jar.JarFile;
import org.junit.jupiter.api.Test;

class AiPackagingTest {
    @Test
    void jarContainsOnlyPrivateWidgetResourceAndAutoConfigurationRegistration() throws IOException {
        try (JarFile jar = new JarFile(System.getProperty("ai.integration.jar"))) {
            List<String> files = jar.stream().filter(entry -> !entry.isDirectory()).map(entry -> entry.getName()).toList();
            assertThat(files).contains("META-INF/ai-integration/widget.js",
                    "META-INF/ai-integration/version.properties",
                    "META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports");
            assertThat(files.stream().filter(name -> name.startsWith("META-INF/resources/")
                    || name.startsWith("resources/") || name.startsWith("static/") || name.startsWith("public/")))
                    .isEmpty();
            assertThat(files).noneMatch(name -> name.startsWith("com/nori/tc/"));
            byte[] widget = jar.getInputStream(jar.getJarEntry("META-INF/ai-integration/widget.js")).readAllBytes();
            assertThat(widget).isEqualTo(Files.readAllBytes(Path.of(System.getProperty("ai.integration.front"), "dist/widget.js")));
            String registration = new String(jar.getInputStream(jar.getJarEntry(
                    "META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports")).readAllBytes(),
                    StandardCharsets.UTF_8);
            assertThat(registration.strip()).isEqualTo(AiIntegrationAutoConfiguration.class.getName());
            Properties version = new Properties();
            version.load(jar.getInputStream(jar.getJarEntry("META-INF/ai-integration/version.properties")));
            assertThat(version.getProperty("integrationVersion")).isEqualTo("1.0.0")
                    .isEqualTo(AiIntegrationAutoConfiguration.INTEGRATION_VERSION);
            assertThat(Path.of(jar.getName()).getFileName().toString())
                    .isEqualTo("ai-integration-spring-boot-starter-1.0.0.jar");
        }
    }
}
