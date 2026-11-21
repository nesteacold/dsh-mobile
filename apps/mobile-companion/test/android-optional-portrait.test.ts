// Spec 048 — `./plugins/withAndroidOptionalPortrait`.
//
// Expo turns `orientation: "portrait"` into a REQUIRED Android hardware feature, which Play reported
// as restricting availability. This test drives the plugin's pure helper against Expo's parsed
// manifest shape and asserts that only the exact portrait feature changes: existing nodes get
// `android:required="false"`, absent nodes are created, unrelated entries survive, and the patch is
// idempotent. It also guards the app.json registration and versionCode bump.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const plugin = require('../plugins/withAndroidOptionalPortrait') as {
  setPortraitFeatureOptional: (modResults: ManifestResult) => ManifestResult;
  withAndroidOptionalPortrait: (config: Record<string, unknown>) => Record<string, unknown>;
  PORTRAIT_FEATURE: string;
  PLUGIN_NAME: string;
};

interface ManifestResult {
  manifest: Record<string, any>;
}

const FEATURE = plugin.PORTRAIT_FEATURE;
const ANDROID_NAME = 'android:name';
const ANDROID_REQUIRED = 'android:required';
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_JSON = JSON.parse(readFileSync(path.join(APP, 'app.json'), 'utf8')) as {
  expo: {
    orientation?: string;
    android?: { versionCode?: number };
    plugins?: unknown[];
  };
};

function features(result: ManifestResult): Array<Record<string, any>> {
  return result.manifest['uses-feature'] as Array<Record<string, any>>;
}

function portrait(result: ManifestResult): Record<string, any> | undefined {
  return features(result).find((feature) => feature?.$?.[ANDROID_NAME] === FEATURE);
}

function fixture(withPortrait: boolean): ManifestResult {
  const entries: Array<Record<string, any>> = [
    { $: { [ANDROID_NAME]: 'android.hardware.camera', [ANDROID_REQUIRED]: 'true' } },
  ];
  if (withPortrait) {
    entries.push({ $: { [ANDROID_NAME]: FEATURE, [ANDROID_REQUIRED]: 'true', 'tools:keep': 'portrait' } });
  }
  return {
    manifest: {
      $: { package: 'com.dshext.companion' },
      'uses-permission': [{ $: { [ANDROID_NAME]: 'android.permission.CAMERA' } }],
      'uses-feature': entries,
      application: [{ $: { 'android:name': '.MainApplication', 'android:allowBackup': 'false' } }],
    },
  };
}

describe('spec 048 — optional Android portrait feature', () => {
  it('sets an existing exact portrait feature to required=false and keeps its other attributes', () => {
    const result = plugin.setPortraitFeatureOptional(fixture(true));
    const target = portrait(result);
    assert.ok(target, 'the exact portrait feature remains');
    assert.equal(FEATURE, 'android.hardware.screen.portrait');
    assert.equal(target.$?.[ANDROID_REQUIRED], 'false');
    assert.equal(target.$?.['tools:keep'], 'portrait');
    assert.equal(features(result)[0]?.$?.[ANDROID_REQUIRED], 'true', 'unrelated feature untouched');
  });

  it('creates the exact feature node when Expo emitted none', () => {
    const before = fixture(false);
    const preserved = JSON.stringify(before.manifest['uses-permission']);
    const result = plugin.setPortraitFeatureOptional(before);
    const target = portrait(result);
    assert.ok(target, 'portrait feature was created');
    assert.deepEqual(target.$, { [ANDROID_NAME]: 'android.hardware.screen.portrait', [ANDROID_REQUIRED]: 'false' });
    assert.equal(features(result).length, 2, 'only the portrait node was added');
    assert.equal(JSON.stringify(result.manifest['uses-permission']), preserved);
    assert.equal(result.manifest.application[0]?.$?.['android:allowBackup'], 'false');
    assert.equal(result.manifest.$?.package, 'com.dshext.companion');
  });

  it('is idempotent and exposes the prebuild mod', () => {
    const once = plugin.setPortraitFeatureOptional(fixture(false));
    const twice = plugin.setPortraitFeatureOptional(once);
    assert.equal(features(twice).length, 2);
    assert.equal(portrait(twice)?.$?.[ANDROID_REQUIRED], 'false');
    assert.equal(typeof plugin.withAndroidOptionalPortrait, 'function');
    assert.equal(plugin.PLUGIN_NAME, 'dsh-android-optional-portrait');
  });

  it('is registered after release signing with portrait orientation and versionCode 8', () => {
    assert.equal(APP_JSON.expo.orientation, 'portrait');
    assert.equal(APP_JSON.expo.android?.versionCode, 8);
    assert.deepEqual((APP_JSON.expo.plugins ?? []).slice(-2), [
      './plugins/withAndroidReleaseSigning',
      './plugins/withAndroidOptionalPortrait',
    ]);
  });
});
