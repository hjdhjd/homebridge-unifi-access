/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webhooks.ts: The plugin's HTTP listener for inbound webhook deliveries.
 *
 * This is the plugin's one HTTP surface. The unifi-access library hosts none of its own by design: it owns the webhook protocol - the delivery shapes, signature
 * verification, and the registration endpoints - while where a listener binds, what address a controller can reach it on, and how long a delivery stays fresh are
 * deployment decisions belonging to whoever runs the plugin.
 *
 * Nothing below knows anything about Access. The server, the path routing, the body limit, the address probe, and the replay ledger are plain HTTP and networking
 * machinery over values handed in from outside...even the port the routing probe connects toward is immaterial to what that probe establishes, since no datagram
 * is ever sent. That is deliberate: this module is written as the thing a shared plugin library would be given whole, so lifting it there is a move rather than a
 * rewrite.
 */
import { ACCESS_WEBHOOK_BODY_LIMIT, ACCESS_WEBHOOK_LISTEN_RETRY_MS } from "./settings.ts";
import { formatErrorMessage, onAbort } from "homebridge-plugin-utils";
import { ACCESS_OFFICIAL_API_PORT } from "unifi-access";
import { Buffer } from "node:buffer";
import type { HomebridgePluginLogging } from "homebridge-plugin-utils";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { createSocket } from "node:dgram";
import { isIP } from "node:net";

/**
 * One inbound delivery, as the route sees it: the body exactly as it arrived, and the signature header that came with it.
 *
 * The body stays raw bytes. A signature covers what was sent, so parsing and re-serializing the payload before verification would change whitespace and key order
 * the signature was computed over and turn every authentic delivery into a refusal.
 */
export interface AccessWebhookRequest {

  readonly body: Buffer;
  readonly signature: string | undefined;
}

/**
 * A route's verdict on one delivery: `true` to accept it, `false` to refuse it.
 *
 * The verdict is synchronous, which is what keeps the whole delivery inside the sender's own receive budget: the response is written the moment the route answers,
 * rather than after whatever work the delivery went on to trigger.
 */
export type AccessWebhookRoute = (request: AccessWebhookRequest) => boolean;

/**
 * One HTTP listener, shared by every consumer that registers a path on it.
 *
 * Its lifetime is the signal it is constructed with: the signal firing closes the server, drops every connection, and cancels a pending listen retry, so a plugin
 * reload releases the port rather than leaking it. A port already in use is retried on an interval for as long as the signal lives, because the usual cause is a
 * previous instance of this same process still letting go of it during a restart.
 */
export class AccessWebhookListener {

  #closed: boolean;
  readonly #log: HomebridgePluginLogging;
  #retryTimer: NodeJS.Timeout | undefined;
  readonly #routes: Map<string, AccessWebhookRoute>;
  readonly #server: Server;

  /**
   * @param options       - The listener's inputs.
   * @param options.log   - Where the listener's own lines go.
   * @param options.port  - The port to bind. Zero asks the operating system for an ephemeral one, which {@link AccessWebhookListener.boundPort} then reports.
   * @param options.retryMs - How long to wait before retrying a port that was in use.
   * @param options.signal  - The listener's lifetime. Firing it closes the server for good.
   */
  constructor(options: { log: HomebridgePluginLogging; port: number; retryMs?: number; signal: AbortSignal }) {

    const { log, port, retryMs = ACCESS_WEBHOOK_LISTEN_RETRY_MS, signal } = options;

    this.#closed = false;
    this.#log = log;
    this.#retryTimer = undefined;
    this.#routes = new Map();
    this.#server = createServer();

    this.#server.on("request", (request, response) => {

      // Deliveries are posted. Anything else is answered without reading a body at all.
      if(request.method !== "POST") {

        response.writeHead(405).end();

        return;
      }

      /* The path alone, with any query string set aside. A route is registered for one exact path, and matching the path rather than the whole request target is
       * what keeps a sender that appends anything of its own from falling through to a refusal it cannot diagnose.
       */
      const path = (request.url ?? "").split("?")[0] ?? "";
      const route = this.#routes.get(path);

      if(!route) {

        response.writeHead(404).end();

        return;
      }

      /* Node types a header outside its own well-known set as a string, an array of strings, or nothing at all. A header sent more than once arrives as the array,
       * which is not a signature any sender legitimately produces, so both that and an absent header reach the route as nothing and the route refuses.
       */
      const header = request.headers["signature"];
      const signature = (typeof header === "string") ? header : undefined;
      const chunks: Buffer[] = [];
      let length = 0;
      let refused = false;

      request.on("data", (chunk: Buffer) => {

        if(refused) {

          return;
        }

        length += chunk.length;

        // A body past the limit is refused the moment it crosses, and the socket is destroyed rather than drained: there is no reason to read the rest of
        // something already known to be unusable.
        if(length > ACCESS_WEBHOOK_BODY_LIMIT) {

          refused = true;

          response.writeHead(413).end();
          request.socket.destroy();

          return;
        }

        chunks.push(chunk);
      });

      request.on("end", () => {

        if(refused) {

          return;
        }

        let accepted: boolean;

        try {

          accepted = route({ body: Buffer.concat(chunks), signature });
        } catch(error) {

          // A fault inside one route is that route's alone. The sender is told the delivery failed here rather than that it was refused, since those mean
          // different things to whatever is retrying on the other end.
          this.#log.error("A webhook delivery handler failed: %s.", formatErrorMessage(error));
          response.writeHead(500).end();

          return;
        }

        response.writeHead(accepted ? 200 : 401).end();
      });
    });

    this.#server.on("error", (error) => {

      /* Already shutting down: arm nothing. Binding returns synchronously while its failure arrives a tick later, possibly after the teardown below has already
       * run, so a retry armed at that point would be a live timer with nothing left to cancel it.
       */
      if(signal.aborted) {

        return;
      }

      if((error as NodeJS.ErrnoException).code === "EADDRINUSE") {

        this.#log.error("The port the Access webhook listener needs is in use by something else. Retrying shortly.");

        // The handler stands for the life of the server, so each failed attempt arms the next one and a port held for a long time is waited out rather than
        // giving up on webhooks for the life of the process.
        this.#retryTimer = setTimeout(() => {

          this.#retryTimer = undefined;

          this.#server.close();
          this.#server.listen(port);
        }, retryMs);

        return;
      }

      this.#log.error("The Access webhook listener encountered an error and has stopped: %s.", formatErrorMessage(error));
      this.#close();
    });

    this.#server.on("listening", () => {

      this.#log.info("Listening for Access webhook deliveries on port %s.", this.boundPort);
    });

    /* Tear the server down when the lifetime ends, cancelling a pending retry on the way out. onAbort runs its handler inline when the signal has already fired,
     * which is a case this genuinely reaches: a controller configures its webhooks from an unawaited login that can race a shutdown.
     */
    onAbort(signal, () => {

      if(this.#retryTimer) {

        clearTimeout(this.#retryTimer);
        this.#retryTimer = undefined;
      }

      this.#close();
    });

    // An already-aborted signal tore the server down inline above, on a server that never listened. There is nothing to bind.
    if(signal.aborted) {

      return;
    }

    this.#server.listen(port);
  }

  // Whether the server has been closed - by its lifetime signal, or by a fatal server error. A closed listener accepts no routes.
  public get closed(): boolean {

    return this.#closed;
  }

  // The port the listener is actually bound to, or zero before it has bound one. A caller that asked for an ephemeral port learns here which one it was given.
  public get boundPort(): number {

    const address = this.#server.address();

    return ((address === null) || (typeof address === "string")) ? 0 : address.port;
  }

  /**
   * Register a handler for one exact path.
   *
   * @param path    - The path to route, exactly as a sender will address it.
   * @param handler - The verdict function for deliveries to that path.
   *
   * @returns A handle that removes the route when disposed.
   *
   * @throws {TypeError} If the listener is closed, or the path is already routed. The message names which of the two refused, so a caller can log it rather than
   * having to tell two failure shapes apart.
   */
  public route(path: string, handler: AccessWebhookRoute): Disposable {

    if(this.#closed) {

      throw new TypeError("The webhook listener is closed and cannot accept a route for " + path + ".");
    }

    if(this.#routes.has(path)) {

      throw new TypeError("The webhook listener already routed " + path + " to another handler.");
    }

    this.#routes.set(path, handler);

    return { [Symbol.dispose]: (): void => void this.#routes.delete(path) };
  }

  // Close the server for good and drop the connections it is holding. Safe to call more than once, which is what lets the fatal-error path and the teardown share
  // it without either having to know whether the other already ran.
  #close(): void {

    this.#closed = true;

    this.#server.closeAllConnections();
    this.#server.close();
  }
}

/**
 * A bounded memory of the deliveries already accepted, keyed by the identifier the sender mints per delivery, so a captured delivery replayed inside the freshness
 * window is refused the second time.
 *
 * Entries expire on that same horizon: a delivery older than the window is refused before this ledger is ever consulted, so nothing older needs remembering, and
 * the ledger's size is bounded by the delivery rate over one window rather than by uptime.
 */
export class AccessDeliveryLedger {

  readonly #seen: Map<string, number>;
  readonly #windowMs: number;

  /**
   * @param options          - The ledger's inputs.
   * @param options.windowMs - How long an accepted identifier is remembered.
   */
  constructor(options: { windowMs: number }) {

    this.#seen = new Map();
    this.#windowMs = options.windowMs;
  }

  /**
   * Admit a delivery once.
   *
   * @param options       - The delivery's identifier and the clock reading to judge it against.
   * @param options.id    - The identifier the sender minted for this delivery.
   * @param options.nowMs - The current clock reading, injected so the ledger stays testable without waiting on real time.
   *
   * @returns `true` the first time an identifier is seen inside the window, and `false` for a repeat.
   */
  public admit(options: { id: string; nowMs: number }): boolean {

    const { id, nowMs } = options;
    const horizon = nowMs - this.#windowMs;

    // Prune on every call rather than on a timer of its own. The work is proportional to what the window actually holds, and it means the ledger owns no
    // lifecycle a caller would have to end.
    for(const [ seen, acceptedAt ] of this.#seen) {

      if(acceptedAt < horizon) {

        this.#seen.delete(seen);
      }
    }

    if(this.#seen.has(id)) {

      return false;
    }

    this.#seen.set(id, nowMs);

    return true;
  }

  // Forget every delivery this ledger remembers.
  public clear(): void {

    this.#seen.clear();
  }
}

/**
 * The local address the operating system routes toward a host - which is the interface a peer at that host can reach this process on.
 *
 * A datagram socket is connected and its local address read. No packet is sent: connecting a datagram socket only fixes its default destination, and fixing that
 * destination is what makes the kernel consult its routing table and bind the local address it would send from. That is a more honest answer than enumerating the
 * host's interfaces and guessing which one faces the peer, because a host with several interfaces has no single right answer to guess at.
 *
 * @param host - The peer's address or hostname.
 *
 * @returns The local address the route toward that host would leave from.
 */
export async function localAddressFor(host: string): Promise<string> {

  const socket = createSocket((isIP(host) === 6) ? "udp6" : "udp4");

  try {

    return await new Promise<string>((resolve, reject) => {

      // The handler stands rather than firing once, so a socket that errors again after this promise has settled has somewhere for that error to land instead of
      // going unhandled and taking the process with it.
      socket.on("error", (error) => reject(error));
      socket.connect(ACCESS_OFFICIAL_API_PORT, host, () => resolve(socket.address().address));
    });
  } finally {

    try {

      socket.close();
    } catch {

      // A socket that never opened, or one its own error already tore down, has nothing left to close and nothing a caller could do about it either way.
    }
  }
}
