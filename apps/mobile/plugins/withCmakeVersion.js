/**
 * Pin the CMake version used for the Android build.
 *
 * The Android Gradle Plugin does not pick the newest CMake it can find; it uses
 * its own default, which is 3.22.1. That version ships ninja 1.10, and ninja
 * 1.10 rejects paths over 260 characters in its own code — regardless of
 * whether Windows has long paths enabled. react-native-gesture-handler's
 * generated object file paths are longer than that and cannot be shortened:
 * measured at 372 characters, of which 249 are parts no project layout can
 * change. Ninja 1.12 asks the operating system instead of refusing outright,
 * and it comes with CMake 3.30 and up.
 *
 * This lives in a config plugin rather than in android/app/build.gradle
 * because that directory is generated — `expo prebuild` would throw the change
 * away, and the build would fail again with an error that points at
 * gesture-handler rather than at the toolchain.
 *
 * Requires the version to be installed via the SDK Manager (SDK Tools ->
 * "Show Package Details" -> CMake). If it is missing, Gradle says so plainly.
 */

const { withAppBuildGradle } = require('expo/config-plugins');

const CMAKE_VERSION = '3.31.6';

const BLOCK = `    externalNativeBuild {
        cmake {
            version "${CMAKE_VERSION}"
        }
    }
`;

/** @type {import('expo/config-plugins').ConfigPlugin} */
module.exports = function withCmakeVersion(config) {
  return withAppBuildGradle(config, (gradleConfig) => {
    const contents = gradleConfig.modResults.contents;

    if (contents.includes(`version "${CMAKE_VERSION}"`)) {
      return gradleConfig;
    }

    // Insert at the top of the android block. Anchoring on `android {` keeps
    // this working even as the rest of the generated file changes around it.
    const anchor = 'android {\n';
    const at = contents.indexOf(anchor);
    if (at === -1) {
      throw new Error(
        'withCmakeVersion: no `android {` block in app/build.gradle — the ' +
          'generated file changed shape and this plugin needs updating.',
      );
    }

    const insertAt = at + anchor.length;
    gradleConfig.modResults.contents =
      contents.slice(0, insertAt) + BLOCK + contents.slice(insertAt);

    return gradleConfig;
  });
};
