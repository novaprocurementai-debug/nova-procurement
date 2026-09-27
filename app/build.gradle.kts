plugins {
    id("com.android.application")
}

android {
    namespace = "com.nova.procurement"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.nova.procurement"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
}

dependencies {
}
