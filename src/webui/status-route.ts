/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * status-route.ts: The route the settings page sends its controller context to the live-status feed on.
 */

// The onRequest route the context extension registers - the plugin's addition to the shared status protocol. It carries the browser's controller context: each
// configured controller's identity beside the decorated serials of the devices its kept probe answer listed, which is what lets a view request resolve the
// controller serving a serial. This module is its one owner, and each end of the bridge reads it: the server through webui-status.ts, which re-exports it, and the
// page through this module's compiled copy beside its own logic. The push-event name and the view route are the shared homebridge-plugin-utils contract.
export const ACCESS_STATUS_CONTEXT_ROUTE = "/statusContext";
