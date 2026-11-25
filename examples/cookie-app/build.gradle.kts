plugins {
    java
    id("org.springframework.boot") version "4.0.7"
    id("io.spring.dependency-management") version "1.1.7"
}

java { toolchain { languageVersion.set(JavaLanguageVersion.of(21)) } }
dependencies {
    implementation("com.nori.ai:ai-integration-spring-boot-starter:1.0.6")
    implementation("org.springframework.boot:spring-boot-starter-webmvc")
    implementation("org.springframework.boot:spring-boot-starter-security")
    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}
sourceSets.test { java.srcDir("../test-support") }
tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
    options.compilerArgs.addAll(listOf("-parameters", "-Xlint:all", "-Werror"))
}
val npmCommand = if (System.getProperty("os.name").startsWith("Windows")) "npm.cmd" else "npm"
val hostNpmCi by tasks.registering(Exec::class) {
    workingDir(projectDir)
    commandLine(npmCommand, "ci")
    inputs.files("package.json", "package-lock.json")
    outputs.dir("node_modules")
}
val hostBuild by tasks.registering(Exec::class) {
    dependsOn(hostNpmCi)
    workingDir(projectDir)
    commandLine(npmCommand, "run", "build")
    inputs.files("host.js", "vite.config.js", "package.json", "package-lock.json")
    outputs.dir(layout.buildDirectory.dir("host"))
}
tasks.processResources { dependsOn(hostBuild); from(layout.buildDirectory.dir("host")) { into("static") } }
tasks.test { useJUnitPlatform(); testLogging { events("passed", "skipped", "failed") } }
