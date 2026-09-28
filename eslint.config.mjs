/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * eslint.config.mjs: Linting defaults for Homebridge plugins.
 */
import hbPluginUtils from "homebridge-plugin-utils/eslint";

export default hbPluginUtils({

  // These are the JS and config files that sit outside the main TypeScript project, so the parser needs its default-project fallback to lint them at all.
  allowDefaultProject: [ "eslint.config.mjs", "homebridge-ui/*.@(js|mjs)", "homebridge-ui/public/*.@(js|mjs)" ],
  // The webUI library directory holds a build-time copy of the homebridge-plugin-utils webUI framework rather than anything authored here, so linting it would report
  // findings against code this repository does not own. The ignore stops being needed once that framework is consumed as a versioned bundle rather than a flat copy.
  ignores: ["homebridge-ui/public/lib/**"],
  // The js preset applies the plain-JavaScript rule set (no type-aware checks) to every file here that is not compiled TypeScript. The ui preset layers
  // browser globals - window, document, fetch, the Homebridge configuration API - on top of that for the files that run inside the Config UI X browser
  // page rather than under Node, which is why every module under homebridge-ui/public/ carries both.
  js: [ "homebridge-ui/public/access-config.mjs", "homebridge-ui/public/controller-actions.mjs", "homebridge-ui/public/ui.mjs", "homebridge-ui/server.js",
    "homebridge-ui/users-census.js", "eslint.config.mjs" ],
  // These files run under Node in the Config UI X server process rather than in the browser page, so the node preset declares the Node runtime's globals for them.
  node: [ "homebridge-ui/server.js", "homebridge-ui/users-census.js" ],
  ts: ["src/**/*.ts"],
  ui: [ "homebridge-ui/public/access-config.mjs", "homebridge-ui/public/controller-actions.mjs", "homebridge-ui/public/ui.mjs" ]
});
