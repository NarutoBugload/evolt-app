// public/js/config.js
//
// Build-time configuration. Loaded before app.js, so whatever it sets here
// becomes the default before anything reads it.
//
// Why this exists: an APK cannot contain the backend. Capacitor wraps the
// web client; it cannot bundle a Node process. So an installed build has to
// be TOLD where the backend lives, and making each person type a URL on
// first launch is a bad first run. Setting it here bakes a default into the
// build instead.
//
// This is only a DEFAULT. Anything the person sets under "Server" on the
// sign-in screen wins over it, and clearing that falls back to this. It is
// not a lock-in: someone who wants to point the app at their own deployment
// still can, which matters for a tool whose whole claim is that you do not
// have to trust one operator.
//
// To set it for a release, define EVOLT_SERVER_URL when building - the
// release workflow writes this file from that variable. To set it by hand,
// just edit the line below.
//
// Leave it empty for:
//   - the web app served by its own server (same-origin already works)
//   - a build meant to be used with no backend at all
window.EVOLT_DEFAULT_SERVER = '';
