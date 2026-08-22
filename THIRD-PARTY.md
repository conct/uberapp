# Drittanbieter-Code / Third-party code

Die gebauten Pakete dieses Projekts — `apps/mobile/web-dist` und das Android-APK
— enthalten Code aus den unten genannten Bibliotheken. MIT und Apache-2.0
verlangen, dass Lizenztext und Copyright-Vermerk mit der Verteilung mitgehen;
diese Datei erfüllt das für die direkten Abhängigkeiten. Die vollständigen
Lizenztexte stehen jeweils in `node_modules/<paket>/LICENSE`.

*The built artefacts of this project bundle code from the libraries listed
below. MIT and Apache-2.0 require the licence text and copyright notice to
accompany a distribution; this file does that for the direct dependencies. The
full texts live in `node_modules/<package>/LICENSE`.*

Besonders hervorzuheben, weil sie den Kern tragen / worth naming, because they
carry the core:

- **[ssh2](https://github.com/mscdex/ssh2)** (MIT, Brian White) — die
  SSH-Umsetzung, mit der die App den Agenten selbst installiert.
- **[jsQR](https://github.com/cozmo/jsQR)** (Apache-2.0) — der QR-Decoder der
  Web-Variante.
- **[react-native-quick-crypto](https://github.com/margelo/react-native-quick-crypto)**
  (MIT) — Kryptografie unter Hermes.
- **[react-native-tcp-socket](https://github.com/Rapsssito/react-native-tcp-socket)**
  (MIT) — rohe TCP-Verbindungen, ohne die ssh2 nichts hätte.
- **[Expo](https://expo.dev)** und **[React Native](https://reactnative.dev)** (MIT).

## Direkte Abhängigkeiten

| Paket | Lizenz |
| --- | --- |
| `@expo/vector-icons` | MIT |
| `assert` | MIT |
| `buffer` | MIT |
| `events` | MIT |
| `expo` | MIT |
| `expo-camera` | MIT |
| `expo-clipboard` | MIT |
| `expo-constants` | MIT |
| `expo-dev-client` | MIT |
| `expo-linking` | MIT |
| `expo-navigation-bar` | MIT |
| `expo-router` | MIT |
| `expo-secure-store` | MIT |
| `expo-status-bar` | MIT |
| `jsqr` | Apache-2.0 |
| `path-browserify` | MIT |
| `qrcode-generator` | MIT |
| `react` | MIT |
| `react-dom` | MIT |
| `react-native` | MIT |
| `react-native-nitro-modules` | MIT |
| `react-native-quick-base64` | MIT |
| `react-native-quick-crypto` | MIT |
| `react-native-safe-area-context` | MIT |
| `react-native-screens` | MIT |
| `react-native-svg` | MIT |
| `react-native-tcp-socket` | MIT |
| `react-native-web` | MIT |
| `readable-stream` | MIT |
| `ssh2` | MIT |
| `string_decoder` | MIT |
| `util` | MIT |
| `ws` | MIT |

Erzeugt aus den `package.json`-Angaben der installierten Pakete. Transitive
Abhängigkeiten sind nicht aufgeführt — wer das Projekt veröffentlicht, sollte
sie mit einem Werkzeug wie `license-checker` erfassen und die Lizenztexte dem
Paket beilegen.

*Generated from the installed packages' `package.json`. Transitive dependencies
are not listed — anyone publishing this should collect them with a tool such as
`license-checker` and ship the licence texts with the artefact.*
