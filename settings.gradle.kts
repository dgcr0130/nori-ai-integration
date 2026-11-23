pluginManagement {
    repositories { gradlePluginPortal(); mavenCentral() }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        mavenCentral()
        // 예제만 발행 좌표를 소비한다. backend의 저장소 해석은 바꾸지 않는다.
        mavenLocal {
            content { includeGroup("com.nori.ai") }
        }
    }
}

rootProject.name = "nori-ai-integration"
include(":backend:ai-integration-spring-boot-starter")
include(":examples:cookie-app", ":examples:header-app")
