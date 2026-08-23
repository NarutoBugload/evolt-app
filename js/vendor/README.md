# Vendored third-party libraries

These are committed rather than pulled from a CDN at runtime. Evolt is a
privacy tool: a CDN request would tell a third party the IP of everyone who
opens the app, and it would mean the code executing in the browser could
change without this repo changing. Both are unacceptable here.

| File | Library | Version | Licence |
|---|---|---|---|
| `pako.umd.min.js` | [pako](https://github.com/nodeca/pako) | 3.x | MIT |
| `qrcode.js` | [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) | 2.0.4 | MIT |

Both are the unmodified browser builds from the corresponding npm package.
To update one, copy the build out of `node_modules/` again rather than
editing the file here.
