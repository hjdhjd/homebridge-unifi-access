/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * server.js: homebridge-unifi-access webUI server API.
 *
 * This module is heavily inspired by, and borrows from, the homebridge-config-ui-x source code.
 * Thank you oznu for your contributions to the HomeKit world.
 */
"use strict";

import { ACCESS_STATUS_CONTEXT_ROUTE, AccessStatusFeed, narrowStatusContextRequest } from "../dist/webui-status.js";
import { AccessClient, noopLog } from "unifi-access";
import { STATUS_EVENT, STATUS_VIEW_ROUTE, consoleLog, narrowStatusViewRequest } from "homebridge-plugin-utils";
import { accessMethodChoices, composeConnectIdentity, deviceSerial, doorGuardChoices, membershipRecords, officialDeviceModel, serialForm } from "../dist/policy.js";
import { featureOptionCategories, featureOptions } from "../dist/options.js";
import { HomebridgePluginUiServer } from "@homebridge/plugin-ui-utils";
import { officialUsers } from "./users-census.js";
import util from "node:util";

// The adapter's process generation: an opaque per-process value whose only requirement is uniqueness across this plugin's helper processes, so a panel that outlived
// a helper restart can tell a fresh helper from the one it was talking to. The boot-time millisecond timestamp serves - the frontend compares generations by
// equality alone and claims no ordering.
const generation = Date.now();

// The first of the supplied values that carries anything, or the empty string when none of them does. The collation below reads a device's name through several
// spellings, and not every surface answers all of them.
const nonEmpty = (...args) => args.find(value => (value !== undefined) && (value !== null) && (value !== "")) ?? "";

// Sort by display name, falling back through the spellings a device may be named by. The emitted order IS the sidebar's order - the webUI framework never re-sorts a
// list a plugin supplied - so the collation belongs here, once, and serves both of the surfaces a device can be listed from.
const byName = (a, b) => {

  const aCase = nonEmpty(a.alias, a.name, a.model, a.display_model).toLowerCase();
  const bCase = nonEmpty(b.alias, b.name, b.model, b.display_model).toLowerCase();

  return (aCase > bCase) ? 1 : ((bCase > aCase) ? -1 : 0);
};

/* The adopted devices as the OFFICIAL API answers them, decorated into the same shape a topology device carries so the browser renders both through one path.
 *
 * The payload arrives grouped by the door each device serves. That grouping is real information the library deliberately preserves, and it is not information this
 * page uses, so it is flattened here rather than upstream. The official record carries a hardware type and no display model at all, so the display model comes from
 * the plugin's own policy mapping - reached through the same dist import that carries the identity composition - and a type the mapping does not name answers itself.
 * The door guard picker's list and the access methods the reader supports are attached here too, from the users census alone, because this surface names no door's
 * guards.
 *
 * There is no address on this surface, so the rendered IP row is empty for these devices. That is the honest answer: the official API does not report one.
 */
const officialDevices = (grouped, users) => grouped.flat().filter(device => device.is_managed).map(device => ({

  // The methods this reader supports, as the settings page offers them, from the one catalog the switches themselves read.
  accessMethods: accessMethodChoices(device),
  alias: device.alias,
  // A record arriving without a capability list is stored carrying an empty one, which is the same accommodation the library's own reducer makes for the topology
  // path. The browser reads this array to group the sidebar and to gate options, so an absent one would throw rather than degrade.
  capabilities: [...(device.capabilities ?? [])],
  /* eslint-disable-next-line camelcase */
  connected_uah_id: device.connected_uah_id,
  /* eslint-disable-next-line camelcase */
  display_model: officialDeviceModel(device.type),
  // The official listing carries no door guards, so the picker offers the whole census; a guard the ring names is always among them.
  doorGuards: doorGuardChoices({ guardIds: undefined, users }),
  /* eslint-disable-next-line camelcase */
  is_online: device.is_online,
  name: device.name,
  serialNumber: serialForm(device.id),
  /* eslint-disable-next-line camelcase */
  unique_id: device.id
})).sort(byName);

class PluginUiServer extends HomebridgePluginUiServer {

  constructor() {

    super();

    this.#registerGetDevices();

    this.#registerGetOptions();

    this.#registerStatusFeed();

    this.ready();

    // Introduce this fresh adapter process to any surviving panel: a hello carrying this process's generation lets a page that outlived a helper restart clear its
    // stale token floors and re-elicit its context and view. Delivery is advisory - it goes through the same push relay every status event does. Placed after ready() so
    // the bridge channel is as established as the adapter can make it before the introduction goes out.
    this.pushEvent(STATUS_EVENT, { generation, kind: "hello" });
  }

  #registerStatusFeed() {

    /* One status feed for the lifetime of this custom-UI child process. push routes every status event to the iframe over the sanctioned plugin-ui-utils channel,
     * and the feed and its client log through the shared console-backed adapter, which carries its own account of why the console is the transport at this
     * boundary and why its debug channel stays silent.
     *
     * The one-shot probe below keeps a capturing shim of its own rather than reaching for this adapter, because it serves a different purpose: returning a failure
     * with the response it belongs to.
     */
    const feed = new AccessStatusFeed({ log: consoleLog, push: (payload) => this.pushEvent(STATUS_EVENT, payload) });

    // Replace the feed's controller context. We narrow the untrusted body in the tested module and drop a malformed body without dispatching. feed.context is
    // synchronous and total by the feed's contract, so we call it and return null; connection progress flows over push events.
    this.onRequest(ACCESS_STATUS_CONTEXT_ROUTE, (body) => {

      const request = narrowStatusContextRequest(body);

      if(request === null) {

        return null;
      }

      feed.context(request);

      return null;
    });

    // Switch the panel's view to one selected device. We narrow the untrusted body through the shared homebridge-plugin-utils narrowing and drop a malformed body
    // without dispatching. The view route is fire-and-forget by the shared contract - results flow over push events - so the async view is voided and null answers
    // the bridge at once.
    this.onRequest(STATUS_VIEW_ROUTE, (body) => {

      const request = narrowStatusViewRequest(body);

      if(request === null) {

        return null;
      }

      void feed.view(request.serialNumber);

      return null;
    });
  }

  #registerGetDevices() {

    /* Retrieve the list of devices from an Access controller to populate the feature options device picker.
     *
     * The answer is a KIND-TAGGED union rather than a bare list, because the two successful outcomes differ in what the user can do with them rather than in what
     * they look like. A credentialed connect reads the topology document and answers the controller itself followed by its devices. A token-only connect reads the
     * official API's adopted inventory and answers those devices with no console identity to lead with, since the topology and the controller document both live
     * behind the Access application's own endpoints, which a token never reaches. A failure answers its reason. Tagging the outcome is what lets the browser explain
     * that door-level accessories still need credentials without ever presenting a working controller as broken.
     */
    this.onRequest("/getDevices", async (controller) => {

      // The connection outcome is probe-local state that travels back with the response: a failed probe fills this with a user-facing message and the response returns
      // it, so the webUI reads the failure from the answer it belongs to.
      let errorInfo = "";

      // A quiet logging shim for the short-lived client: debug/info/warn stay silent (noopLog), while error captures the message so the probe can return the most
      // recent failure reason to the user. The unifi-access AccessLogging signature is (message, ...parameters), so we spread the rest parameters into util.format.
      const log = { ...noopLog, error: (message, ...parameters) => {

        errorInfo = util.format(message, ...parameters);

        // eslint-disable-next-line no-console
        console.error(errorInfo);
      } };

      /* What counts as an identity the client can connect with is the plugin's own policy, and this probe consumes the very function the platform's configuration
       * gate consumes, so the two cannot drift apart on it. A body the composition rejects is answered with the composition's own sentence, which is the same text
       * the user would read in the Homebridge log, and nothing here ever hand-builds an identity object of its own.
       */
      const identity = composeConnectIdentity(controller ?? {});

      if(identity.error !== undefined) {

        return { kind: "error", message: identity.error };
      }

      try {

        /* Connect to the controller. AccessClient.connect() authenticates, fetches what the identity can reach, and seeds the state model as one ready-or-throws
         * operation. This file ships as raw JavaScript executed directly by the host's Node runtime with no transpile step, so an `await using` declaration cannot
         * appear here while the package's engines floor is below the release that provides it. The inner try/finally is the equivalent: it guarantees the client and
         * its realtime connection are released on every exit path, success or throw. The periodic refresh failsafe is disabled since this is a one-shot probe.
         *
         * The composed identity is spread first so the connection facts stated here cannot be overwritten by it.
         */
        const client = await AccessClient.connect({ ...identity.identity, host: controller.address, log: log, refreshIntervalMs: false,
          verifyTls: controller.verifyTls === true });

        try {

          const controllerInfo = client.controllerInfo;

          // The users census, read once per probe and only where a token reaches it, so every record below labels its guards from one list.
          const users = client.official ? await officialUsers(client.official) : [];

          /* No controller information document means a token-only client: that document and the device topology both live behind the Access application's own
           * endpoints, which a token never reaches. The official API answers the adopted inventory regardless, so this arm lists the REAL devices rather than an
           * empty set - which is what lets a token-only user configure per-device options in the very keyspace the runtime resolves, ready the moment credentials
           * are added.
           *
           * No controller row comes out of this arm. The official surface exposes no console identity at all, and inventing one would put option entries under a key
           * nothing can read.
           */
          if(!controllerInfo) {

            return { devices: officialDevices(await client.official.devices.fetchAll(), users), kind: "token-only" };
          }

          const host = controllerInfo.host;

          /* The controller itself, projected into the shape a device record carries so the browser renders it through the same path as everything else. The serial is
           * the controller's MAC in the exact spelling the plugin's runtime keys controller-scoped option entries by, which is what makes an option edited on the
           * controller's own page resolve at runtime.
           */
          /* eslint-disable camelcase */
          const controllerRecord = {

            alias: host.hostname,
            capabilities: [],
            device_type: host.device_type,
            display_model: "controller",
            ip: host.ip,
            is_online: true,
            mac: host.mac,
            model: host.device_type,
            name: host.hostname,
            serialNumber: serialForm(host.mac),
            unique_id: host.mac
          };
          /* eslint-enable camelcase */

          /* The devices this plugin projects into HomeKit, listed through the same statement the runtime's own membership comes from: an Enterprise hub's ports are
           * listed as the devices they become, and the building-hosted parent, which never becomes an accessory, is not. Each is decorated with the plugin's
           * device identity, computed by the function the runtime keys every read on, so what the webUI writes an option entry against is what the plugin reads
           * it back by...the browser can reach neither statement to derive one for itself. Each record also carries the door guard picker's list and the access methods
           * the reader supports, joined here from the door the device serves and the users census, because the browser can reach neither.
           */
          const doors = client.state.snapshot().doors;
          const devices = [...membershipRecords(client.state.snapshot())].sort(byName).map(device => ({ ...device,
            accessMethods: accessMethodChoices(device), doorGuards: doorGuardChoices({ guardIds: doors.get(device.location_id)?.door_guard, users }),
            serialNumber: deviceSerial(device) }));

          // The controller is element 0 - the controller-as-device entry the feature options webUI selects on initial load.
          return { devices: [ controllerRecord, ...devices ], kind: "connected" };
        } finally {

          // Release the client and its realtime connection on every exit path... the raw-JavaScript equivalent of an `await using` declaration's scope-bound disposal.
          await client[Symbol.asyncDispose]();
        }
      } catch(error) {

        // The library reports failures through the log shim above, which captured a friendly message into errorInfo and already logged it. The typed transport errors,
        // however, propagate WITHOUT logging - so when errorInfo is still empty we capture the thrown error's friendly .message and log that single clean sentence here.
        // We never log the raw error object, which would dump its stack and chained cause into the log; and the empty-errorInfo guard avoids logging the same failure
        // twice when the shim already reported it.
        if(!errorInfo) {

          errorInfo = (error instanceof Error) ? error.message : String(error);

          // eslint-disable-next-line no-console
          console.error(errorInfo);
        }

        return { kind: "error", message: errorInfo };
      }
    });
  }

  #registerGetOptions() {

    // Return the full feature-option category and option catalog the webUI renders; per-device filtering happens client-side.
    this.onRequest("/getOptions", () => ({ categories: featureOptionCategories, options: featureOptions }));
  }
}

(() => new PluginUiServer())();
