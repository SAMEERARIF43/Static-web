# Anime Hub Android wrapper configuration

This directory contains local wrapper metadata only. It does not add a Gradle
project, install Capacitor/TWA dependencies, deploy an origin, or run an app
store pipeline.

## Sources of truth

- Capacitor: `../capacitor.config.json`
- PWA/TWA web manifest: `../public/manifest.json`
- Offline service worker: `../public/sw.js`
- Local source icons: `../public/assets/favicon-192.svg` and `../public/assets/favicon-512.svg`
- Android icon mapping: `icon-map.json`
- TWA wrapper metadata: `twa-manifest.json`

The TWA metadata intentionally points at the local web manifest and service
worker as source files. A real Trusted Web Activity still requires a deployed
HTTPS origin and Digital Asset Links; those are not created here.

## Capacitor asset flow

When a native Capacitor project is generated later, `webDir: "public"` makes
the complete `public/` directory the WebView asset root. The existing
`public/index.html` already links `manifest.json`, and the existing client
registers `/sw.js`, so the native shell receives the same PWA metadata and
offline cache behavior without changing SPA routes or CSS.

The launcher mapping is represented by the local vector resource at
`app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml`; it is the Android
resource target for both local SVG source assets listed in `icon-map.json`.
