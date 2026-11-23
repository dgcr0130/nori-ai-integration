pluginManagement {
    repositories { gradlePluginPortal(); mavenCentral() }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { mavenCentral() }
}

rootProject.name = "nori-ai-integration"
include(":backend:ai-integration-spring-boot-starter")
