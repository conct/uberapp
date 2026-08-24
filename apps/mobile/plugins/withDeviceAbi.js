/**
 * Optionally build native code for one CPU architecture instead of four.
 *
 * A debug build compiles every native module — reanimated, worklets,
 * nitro-modules, quick-crypto, gesture-handler, screens — once per ABI. The
 * default list is armeabi-v7a, arm64-v8a, x86 and x86_64, so a cold build does
 * the same C++ work four times and three of those results are never installed
 * on anything. Measured here: 1h22m cold, most of it in those three.
 *
 * reactNativeArchitectures is the knob for it. The React Native Gradle plugin
 * reads it and applies it across the library subprojects too, which is where
 * the time actually goes — setting ndk.abiFilters on the app module instead
 * would only affect what gets packaged, and the subprojects would keep
 * building all four.
 *
 * ---------------------------------------------------------------------------
 * Why this is opt-in rather than simply on
 *
 * Narrowing the ABI list is a property of a *machine*, not of the project. A
 * build made for arm64 alone installs on nearly every physical phone since
 * about 2017 — and on no common Android emulator, since those images are
 * x86_64:
 *
 *   INSTALL_FAILED_NO_MATCHING_ABIS
 *
 * A release build for distribution needs the full set too. So committing a
 * hard-coded narrowing would hand everyone else a broken emulator build to
 * save time on one developer's machine.
 *
 * Unset, this plugin does nothing at all and the defaults stand. To turn it on,
 * put the architectures your device actually runs in the environment — an
 * apps/mobile/.env file is the easy place, and it is gitignored, which is
 * exactly right for a machine-local setting:
 *
 *   UBERCTRL_ANDROID_ABIS=arm64-v8a
 *
 * (`adb shell getprop ro.product.cpu.abi` names the one your device wants.)
 *
 * Either way the command line still wins over both, for a one-off:
 *
 *   ./gradlew assembleDebug -PreactNativeArchitectures=x86_64
 *
 * ---------------------------------------------------------------------------
 * Why a config plugin and not just a hand edit
 *
 * android/gradle.properties is generated and gitignored. `expo prebuild`
 * restores the four-ABI default, and the setting is quietly gone. That is not
 * hypothetical here: a prebuild has already emptied android/local.properties
 * once in this project, which cost a build that hung for ten minutes with no
 * output at all before anyone noticed the SDK path was missing.
 */

const { withGradleProperties } = require('expo/config-plugins');

const KEY = 'reactNativeArchitectures';
const ENV_VAR = 'UBERCTRL_ANDROID_ABIS';

/** Reject anything that is not a plain ABI list, rather than write it out. */
const VALID = /^[a-z0-9-]+(,[a-z0-9-]+)*$/;

/** @type {import('expo/config-plugins').ConfigPlugin} */
module.exports = function withDeviceAbi(config) {
  const requested = (process.env[ENV_VAR] ?? '').trim();

  // The common case: nothing set, nothing changed, defaults apply.
  if (!requested) return config;

  if (!VALID.test(requested)) {
    throw new Error(
      `${ENV_VAR}="${requested}" is not a comma-separated list of Android ABIs ` +
        '(for example "arm64-v8a" or "arm64-v8a,x86_64").',
    );
  }

  return withGradleProperties(config, (gradleConfig) => {
    const properties = gradleConfig.modResults;

    const existing = properties.find(
      (item) => item.type === 'property' && item.key === KEY,
    );

    if (existing) {
      existing.value = requested;
      return gradleConfig;
    }

    properties.push(
      { type: 'empty' },
      {
        type: 'comment',
        value: ` Set from ${ENV_VAR} by plugins/withDeviceAbi.js — see that file.`,
      },
      { type: 'property', key: KEY, value: requested },
    );

    return gradleConfig;
  });
};
