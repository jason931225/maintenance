pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "maintenance-field-android"
include(":app")

includeBuild("../clients/kotlin") {
    dependencySubstitution {
        substitute(module("com.maintenance:maintenance-api-client")).using(project(":"))
    }
}
