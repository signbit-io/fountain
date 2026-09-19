import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Release signing. `keystore.properties` sits next to this file, is gitignored, and points
// at a .jks kept OUTSIDE every git tree (~/.signbit-keys/). See DEVELOPING.md.
//
// 🚨 That key is the app's permanent identity: Android installs an update only when it is
// signed by the same key, so a lost keystore orphans every install with no recovery.
val keystorePropertiesFile = rootProject.file("app/keystore.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) {
        keystorePropertiesFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 36
    namespace = "io.signbit.fountain"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        // ⚠️ The DIRECT-DOWNLOAD identity. A Play build uses `io.signbit.fountain`
        // (no suffix) and is a SEPARATE app: the two channels sign with different keys,
        // and Android refuses an update whose signature differs. Decided 2026-09-03.
        // See DEVELOPING.md > Package identity.
        // 🚨 PERMANENT ONCE PUBLISHED: Play never allows reuse or rename, and changing it
        // on a sideloaded app orphans every install exactly like swapping the signing key.
        applicationId = "io.signbit.fountain.direct"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        create("release") {
            // Absent config is left unconfigured on purpose; the release build type below
            // fails rather than falling back. A debug-signed release APK installs and runs
            // normally, so the mistake would only surface when the real key cannot update it.
            if (keystorePropertiesFile.exists()) {
                val resolved = file(keystoreProperties.getProperty("storeFile"))
                if (!resolved.exists()) {
                    throw GradleException(
                        "keystore.properties points at a keystore that does not exist: " +
                        resolved.absolutePath + ". " +
                        "Restore it from 1Password (verify the file SHA-256 against the note) " +
                        "or fix storeFile. Do NOT generate a replacement: a new key cannot " +
                        "update any install signed by the old one."
                    )
                }
                storeFile = resolved
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
                    ?: keystoreProperties.getProperty("storePassword")

                // v2 is the baseline. v3 is what carries a rotation proof, and it can only be
                // used by a key that was ALREADY published with v3 enabled: turning it on after
                // a release has shipped does not make that release rotatable. Since this key is
                // otherwise unreplaceable, enable it before the first public APK, not after.
                enableV2Signing = true
                enableV3Signing = true
                // v1 (JAR) is for Android 6 and below; minSdk is 24, so it only adds bulk.
                enableV1Signing = false
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            if (keystorePropertiesFile.exists()) {
                signingConfig = signingConfigs.getByName("release")
            } else {
                // Gradle configures every build type even when assembling only a debug APK,
                // so this cannot throw here: `npm run android` would stop working on any
                // machine without the release key. Fail at assembly time instead.
                tasks.matching { it.name.contains("Release") && it.name.startsWith("assemble") }
                    .configureEach {
                        doFirst {
                            throw GradleException(
                                "No app/keystore.properties, so this release APK would be " +
                                "signed with the debug key and could never be updated by a " +
                                "real release. See DEVELOPING.md > Release signing."
                            )
                        }
                    }
            }
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")