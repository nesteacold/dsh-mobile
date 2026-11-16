// Android release signing — `./plugins/withAndroidReleaseSigning`.
//
// The plugin exists because Expo's prebuild template points `buildTypes.release.signingConfig` at
// `signingConfigs.debug`: a `bundleRelease` AAB built from it is debug-signed and Play rejects it.
// These tests drive the plugin the same way prebuild does — the pure helper and the
// `android.appBuildGradle` mod — and assert:
//
//   * `signingConfigs.release` is declared, reading the four `DSH_ORBIT_UPLOAD_*` Gradle
//     properties, and `buildTypes.release.signingConfig` points at it instead of `debug`;
//   * no keystore path or password VALUE is authored by the plugin (the build reads them from
//     `~/.gradle/gradle.properties`), so a prebuild from a clean checkout cannot carry signing
//     material into the repo;
//   * a missing property fails the build loudly (a `GradleException` naming the property) instead
//     of silently falling back to the debug key;
//   * the patch is idempotent, and a build file with no release `signingConfig` to correct, or a
//     Kotlin-DSL build file, is a hard error rather than a silent pass.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const plugin = require('../plugins/withAndroidReleaseSigning') as {
  applyReleaseSigning: (contents: string) => string;
  releaseSigningConfigBlock: () => string;
  withAndroidReleaseSigning: (config: Record<string, unknown>) => Record<string, unknown>;
  PROPERTY_NAMES: {
    storeFile: string;
    keyAlias: string;
    storePassword: string;
    keyPassword: string;
  };
  PLUGIN_NAME: string;
  SIGNCONFIG_NAME: string;
};

const PROPS = plugin.PROPERTY_NAMES;

/** The relevant shape of the prebuild-generated `android/app/build.gradle` (Expo SDK 58). */
const TEMPLATE_GRADLE = `apply plugin: "com.android.application"

android {
    ndkVersion rootProject.ext.ndkVersion
    buildToolsVersion rootProject.ext.buildToolsVersion
    compileSdk rootProject.ext.compileSdkVersion

    namespace 'com.dshext.companion'
    defaultConfig {
        applicationId 'com.dshext.companion'
        minSdkVersion rootProject.ext.minSdkVersion
        targetSdkVersion rootProject.ext.targetSdkVersion
        versionCode 1
        versionName "0.1.0"
    }
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug
            shrinkResources (findProperty('android.enableShrinkResourcesInReleaseBuilds')?.toBoolean() ?: false)
            minifyEnabled enableProguardInReleaseBuilds
        }
    }
    packagingOptions {
        jniLibs {
            useLegacyPackaging (findProperty('expo.useLegacyPackaging')?.toBoolean() ?: false)
        }
    }
}
`;

/**
 * Collect the `buildTypes { release { ... } }` body so assertions can look inside it only.
 * Brace-matched and anchored inside `buildTypes`, because the release body itself contains a
 * `( … ? … : … )` expression and `signingConfigs.release {` appears earlier in the file.
 */
function releaseBuildTypeBody(contents: string): string {
  const buildTypes = contents.indexOf('buildTypes {');
  assert.ok(buildTypes >= 0, 'fixture must contain a buildTypes block');
  const releaseIndex = contents.indexOf('release {', buildTypes);
  assert.ok(releaseIndex >= 0, 'fixture must contain a release build type');
  const open = releaseIndex + 'release '.length;
  let depth = 0;
  for (let index = open; index < contents.length; index += 1) {
    if (contents[index] === '{') depth += 1;
    else if (contents[index] === '}') {
      depth -= 1;
      if (depth === 0) return contents.slice(open + 1, index);
    }
  }
  assert.fail('unbalanced release build type in fixture');
}

describe('withAndroidReleaseSigning — release signing config', () => {
  it('points buildTypes.release at signingConfigs.release instead of debug', () => {
    const patched = plugin.applyReleaseSigning(TEMPLATE_GRADLE);
    const release = releaseBuildTypeBody(patched);
    assert.match(release, /signingConfig\s+signingConfigs\.release/);
    assert.doesNotMatch(release, /signingConfigs\.debug/);
    // The debug build type keeps its own debug signing config.
    assert.match(patched.slice(patched.indexOf('debug {')), /signingConfig signingConfigs\.debug/);
  });

  it('declares signingConfigs.release reading the four DSH_ORBIT_UPLOAD_* properties', () => {
    const patched = plugin.applyReleaseSigning(TEMPLATE_GRADLE);
    const block = plugin.releaseSigningConfigBlock();
    assert.ok(patched.includes(block), 'the release block must be inserted verbatim');
    assert.match(block, /storeFile file\(__DSH_ORBIT_UPLOAD_STORE_FILE\)/);
    assert.match(block, /storePassword __DSH_ORBIT_UPLOAD_STORE_PASSWORD/);
    assert.match(block, /keyAlias __DSH_ORBIT_UPLOAD_KEY_ALIAS/);
    assert.match(block, /keyPassword __DSH_ORBIT_UPLOAD_KEY_PASSWORD/);
    for (const name of Object.values(PROPS)) {
      assert.ok(block.includes(`providers.gradleProperty('${name}')`), `must read ${name}`);
    }
  });

  it('fails the Gradle build loudly when a property is missing or blank', () => {
    const block = plugin.releaseSigningConfigBlock();
    for (const name of Object.values(PROPS)) {
      assert.ok(
        block.includes(`if (__${name} == null || __${name}.trim().isEmpty()) {`),
        `${name} must be presence-checked`,
      );
      assert.ok(block.includes(`throw new GradleException(`), 'must throw, not warn');
    }
    // The message names the property and the owner-custody file, not just "signing failed".
    assert.match(block, /in ~\/\.gradle\/gradle\.properties/);
  });

  it('authors no keystore path or secret value', () => {
    const block = plugin.releaseSigningConfigBlock();
    // Paths and secrets belong to ~/.gradle/gradle.properties; only PROPERTY NAMES appear here.
    assert.doesNotMatch(block, /\.jks/);
    assert.doesNotMatch(block, /\.android-keys/);
    assert.doesNotMatch(block, /storePassword\s+'/);
    assert.doesNotMatch(block, /keyPassword\s+'/);
  });

  it('is idempotent: a second prebuild over a patched file changes nothing', () => {
    const once = plugin.applyReleaseSigning(TEMPLATE_GRADLE);
    const twice = plugin.applyReleaseSigning(once);
    assert.equal(twice, once);
    assert.equal(once.split(PROPS.storeFile).length - 1 > 0, true);
  });

  it('refuses a build file it cannot correct, instead of shipping an unsigned bundle', () => {
    // Only the `release { }` build type loses its signingConfig; `signingConfigs.debug` stays.
    const noReleaseSigning = TEMPLATE_GRADLE.replace(
      /(\n            )signingConfig signingConfigs\.debug(\n            shrinkResources)/,
      '$1$2',
    );
    assert.notEqual(noReleaseSigning, TEMPLATE_GRADLE, 'the fixture must actually lose the line');
    assert.doesNotMatch(releaseBuildTypeBody(noReleaseSigning), /signingConfigs\./);
    assert.throws(
      () => plugin.applyReleaseSigning(noReleaseSigning),
      /declares no signingConfig to correct/,
    );
    assert.throws(() => plugin.applyReleaseSigning('android {\n}\n'), /signingConfigs \{/);
  });

  it('wires the android.appBuildGradle mod and rejects a Kotlin DSL build file', async () => {
    const config: Record<string, any> = { name: 'DSH Orbit', slug: 'dsh-mobile', mods: {} };
    plugin.withAndroidReleaseSigning(config);
    assert.ok(config.mods.android?.appBuildGradle, 'the mod must be registered');

    // Expo's mod wrapper is `async` and mutates `config.modResults` in place; the returned object
    // is a directive, not the patched config, so the assertions read the same object back. Fresh
    // configs per call: the mod writes into the object it is handed.
    const mod = config.mods.android.appBuildGradle as (c: Record<string, any>) => Promise<unknown>;
    const context = (language: string, contents: string): Record<string, any> => ({
      name: 'DSH Orbit',
      slug: 'dsh-mobile',
      mods: { android: { appBuildGradle: mod } },
      modRequest: { nextMod: (c: Record<string, any>) => c },
      modResults: { language, contents },
    });

    const groovy = context('groovy', TEMPLATE_GRADLE);
    await mod(groovy);
    assert.match(groovy.modResults.contents, /signingConfig signingConfigs\.release/);
    assert.doesNotMatch(releaseBuildTypeBody(groovy.modResults.contents), /signingConfigs\.debug/);

    await assert.rejects(
      mod(context('kt', 'android {}')),
      /does not rewrite a Kotlin DSL build file/,
    );
  });
});
