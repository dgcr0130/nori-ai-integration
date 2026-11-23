import org.gradle.api.credentials.HttpHeaderCredentials
import org.gradle.authentication.http.HttpHeaderAuthentication

plugins {
    `java-library`
    `maven-publish`
    id("io.spring.dependency-management") version "1.1.7"
}

java {
    toolchain { languageVersion.set(JavaLanguageVersion.of(21)) }
    withSourcesJar()
}

dependencyManagement {
    imports { mavenBom("org.springframework.boot:spring-boot-dependencies:4.0.7") }
}

dependencies {
    api("org.springframework.boot:spring-boot-autoconfigure")
    api("jakarta.servlet:jakarta.servlet-api")
    implementation("tools.jackson.core:jackson-databind")
    implementation("org.springframework.security:spring-security-config")
    implementation("org.springframework.security:spring-security-web")
    implementation("org.apache.httpcomponents.client5:httpclient5")
    implementation("org.slf4j:slf4j-api")
    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("org.springframework.boot:spring-boot-starter-webmvc")
    testImplementation("org.springframework.boot:spring-boot-security")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
    options.compilerArgs.addAll(listOf("-parameters", "-Xlint:all", "-Werror"))
}

val frontDirectory = rootProject.layout.projectDirectory.dir("front")
val integrationVersionValue = project.version.toString()
val npmCommand = if (System.getProperty("os.name").startsWith("Windows")) "npm.cmd" else "npm"
val widgetNpmCi by tasks.registering(Exec::class) {
    workingDir(frontDirectory)
    commandLine(npmCommand, "ci")
    inputs.files(frontDirectory.file("package.json"), frontDirectory.file("package-lock.json"))
    outputs.dir(frontDirectory.dir("node_modules"))
}
val verifyWidgetVersion by tasks.registering {
    val packageJsonFile = frontDirectory.file("package.json").asFile
    val expectedVersion = integrationVersionValue
    inputs.file(packageJsonFile)
    inputs.property("integrationVersion", expectedVersion)
    doLast {
        val frontVersion = groovy.json.JsonSlurper().parse(packageJsonFile)
            .let { it as Map<*, *> }["version"]
        check(frontVersion == expectedVersion) { "jar와 위젯 버전이 일치해야 합니다." }
    }
}
val widgetBuild by tasks.registering(Exec::class) {
    dependsOn(widgetNpmCi, verifyWidgetVersion)
    workingDir(frontDirectory)
    commandLine(npmCommand, "run", "build")
    inputs.files(fileTree(frontDirectory) {
        include("src/**", "package.json", "package-lock.json", "tsconfig.json", "vite.config.ts")
    })
    inputs.property("integrationVersion", integrationVersionValue)
    outputs.file(frontDirectory.file("dist/widget.js"))
}
val integrationVersion by tasks.registering {
    val output = layout.buildDirectory.file("generated/integration-version/META-INF/ai-integration/version.properties").get().asFile
    val versionContent = "integrationVersion=$integrationVersionValue\n"
    inputs.property("version", integrationVersionValue)
    outputs.file(output)
    doLast {
        output.apply {
            parentFile.mkdirs()
            writeText(versionContent, Charsets.UTF_8)
        }
    }
}
tasks.processResources {
    dependsOn(widgetBuild, verifyWidgetVersion, integrationVersion)
    from(widgetBuild) { into("META-INF/ai-integration") }
    from(layout.buildDirectory.dir("generated/integration-version"))
}
tasks.named("sourcesJar") { dependsOn(tasks.processResources) }
tasks.test {
    useJUnitPlatform()
    // 패키징 시험은 완성된 jar를 읽으며 jar는 test에 의존하지 않는다.
    dependsOn(tasks.jar)
    systemProperty("ai.integration.jar", tasks.jar.flatMap { it.archiveFile }.get().asFile.absolutePath)
    systemProperty("ai.integration.front", frontDirectory.asFile.absolutePath)
    systemProperty("ai.integration.test.classpath", sourceSets.test.get().runtimeClasspath.asPath)
    testLogging { events("passed", "skipped", "failed") }
}

publishing {
    publications {
        create<MavenPublication>("mavenJava") {
            from(components["java"])
            // BOM으로 해석한 실제 버전을 Gradle 소비자용 메타데이터에도 발행한다.
            versionMapping { allVariants { fromResolutionResult() } }
            pom { name.set("Nori AI Integration Spring Boot Starter") }
        }
    }
    repositories {
        val apiUrl = providers.environmentVariable("CI_API_V4_URL")
        val projectId = providers.environmentVariable("CI_PROJECT_ID")
        if (apiUrl.isPresent && projectId.isPresent) {
            maven {
                name = "GitLab"
                url = uri("${apiUrl.get().trimEnd('/')}/projects/${projectId.get()}/packages/maven")
                credentials(HttpHeaderCredentials::class) {
                    name = "Job-Token"
                    value = providers.environmentVariable("CI_JOB_TOKEN").orNull
                }
                authentication { create<HttpHeaderAuthentication>("header") }
            }
        }
    }
}
