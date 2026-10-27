/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * eslint.config.mjs: Linting defaults for Homebridge plugins.
 */
import hbPluginUtils from "homebridge-plugin-utils/eslint";

export default hbPluginUtils({

  // These are the JS and config files that sit outside the main TypeScript project, so the parser needs its default-project fallback to lint them at all.
  allowDefaultProject: [ "eslint.config.mjs", "homebridge-ui/*.@(js|mjs)", "homebridge-ui/public/*.@(js|mjs)" ],
  // The webUI library directory holds build output rather than source: a mirror of the homebridge-plugin-utils webUI framework, stamped into a versioned
  // subdirectory, and the page's own modules, compiled from src/webui, where they are linted. Any lint that walks the tree, an editor's included, would otherwise
  // report findings against code this repository does not own or already lints at its source.
  ignores: ["homebridge-ui/public/lib/**"],
  // The js preset applies the plain-JavaScript rule set (no type-aware checks) to the hand-written JavaScript files and this config file. The ui preset layers
  // browser globals - window, document, fetch, the Homebridge configuration API - on top of that for the page's entry module, which runs inside the Config UI X
  // browser page rather than under Node. The logic that page loads is TypeScript under src/webui, held to the preset's browser-safe webui rules.
  js: [ "homebridge-ui/public/ui.mjs", "homebridge-ui/server.js", "eslint.config.mjs" ],
  // The server runs under Node in the Config UI X server process rather than in the browser page, so the node preset declares the Node runtime's globals for it.
  node: ["homebridge-ui/server.js"],
  ts: ["src/**/*.ts"],
  ui: ["homebridge-ui/public/ui.mjs"]
});
