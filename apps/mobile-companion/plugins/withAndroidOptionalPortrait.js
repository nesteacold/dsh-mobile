// Config plugin for DSH Orbit — optional Android portrait hardware feature (spec 048).
//
// `app.json` keeps `"orientation": "portrait"` as an intentional UX choice, but Expo translates that
// into a REQUIRED `<uses-feature android:name="android.hardware.screen.portrait">` in the generated
// AndroidManifest.xml. Play reported that this required declaration restricts availability on
// phones, tablets, desktop and Android XR. The app still requests portrait orientation; it simply
// does not require portrait-only hardware to install.
//
// What it guarantees for `npx expo prebuild --platform android`:
//
//   * an existing exact `android.hardware.screen.portrait` uses-feature is changed to
//     `android:required="false"` while all its other attributes and all other manifest entries stay
//     untouched;
//   * when Expo did not emit that node, one is created with the exact feature name and
//     `android:required="false"`;
//   * the mod is idempotent: a second prebuild leaves the same manifest.
//
// The pure helper `setPortraitFeatureOptional` holds all the logic so it is unit-testable without a
// native project (`test/android-optional-portrait.test.ts`); the `with*` wrapper only wires it to
// prebuild's `android.manifest` mod.
//
// Registered in `app.json` `expo.plugins` as `"./plugins/withAndroidOptionalPortrait"`.

const { withAndroidManifest, createRunOncePlugin } = require('expo/config-plugins');

const PLUGIN_NAME = 'dsh-android-optional-portrait';
const PLUGIN_VERSION = '1.0.0';
const PORTRAIT_FEATURE = 'android.hardware.screen.portrait';
const ANDROID_NAME = 'android:name';
const ANDROID_REQUIRED = 'android:required';

/**
 * Make the portrait hardware feature optional in Expo's parsed AndroidManifest mod result.
 *
 * @param {object} modResults `config.modResults` from `withAndroidManifest`.
 * @returns {object} the same mod result, with only the exact portrait uses-feature changed/added.
 */
function setPortraitFeatureOptional(modResults) {
  const manifest = modResults && modResults.manifest;
  if (!manifest || typeof manifest !== 'object') {
    throw new Error(`${PLUGIN_NAME}: AndroidManifest mod result has no manifest object`);
  }
  const features = manifest['uses-feature'] === undefined ? [] : manifest['uses-feature'];
  if (!Array.isArray(features)) {
    throw new Error(`${PLUGIN_NAME}: AndroidManifest uses-feature is not a list`);
  }

  const existing = features.find((feature) => feature && feature.$ && feature.$[ANDROID_NAME] === PORTRAIT_FEATURE);
  if (existing) {
    existing.$[ANDROID_REQUIRED] = 'false';
  } else {
    features.push({ $: { [ANDROID_NAME]: PORTRAIT_FEATURE, [ANDROID_REQUIRED]: 'false' } });
  }
  manifest['uses-feature'] = features;
  return modResults;
}

const withAndroidOptionalPortrait = (config) =>
  withAndroidManifest(config, (config) => {
    setPortraitFeatureOptional(config.modResults);
    return config;
  });

module.exports = createRunOncePlugin(withAndroidOptionalPortrait, PLUGIN_NAME, PLUGIN_VERSION);
module.exports.default = module.exports;
module.exports.withAndroidOptionalPortrait = withAndroidOptionalPortrait;
module.exports.setPortraitFeatureOptional = setPortraitFeatureOptional;
module.exports.PORTRAIT_FEATURE = PORTRAIT_FEATURE;
module.exports.PLUGIN_NAME = PLUGIN_NAME;
