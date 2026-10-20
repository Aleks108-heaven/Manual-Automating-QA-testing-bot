// A second local server on a DIFFERENT host than the fixture. It stands in for "the outside world": the allowlist
// tests and the injection eval use it to prove that the bot sent it nothing. It counts every connection, including
// websocket upgrades, and keeps what each request carried, so a test can also search it for leaked secrets.
//   host "localhost"  : a different host name (the fixture is on 127.0.0.1)
//   host "127.0.0.2"  : a different IP literal, which DNS rules cannot catch
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface OutsideRequest {
  line: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface OutsideServer {
  origin: string;
  /** Every request line and every upgrade received. */
  hits: string[];
  /** What each request carried: headers and body. */
  requests: OutsideRequest[];
  /** Forgets what was received so far, between runs. */
  clear(): void;
  close(): Promise<void>;
}

export async function startOutsideServer(host: "localhost" | "127.0.0.2" = "localhost"): Promise<OutsideServer> {
  const hits: string[] = [];
  const requests: OutsideRequest[] = [];
  const server: Server = createServer((req, res) => {
    // Counted the moment it arrives, even if the connection is cut before the body is complete.
    hits.push(`${req.method} ${req.url}`);
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push({ line: `${req.method} ${req.url}`, headers: { ...req.headers }, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>outside</title><h1>OUTSIDE</h1>");
    });
  });
  server.on("upgrade", (req, socket) => {
    hits.push(`UPGRADE ${req.url}`);
    requests.push({ line: `UPGRADE ${req.url}`, headers: { ...req.headers }, body: "" });
    socket.destroy();
  });
  server.on("connection", () => hits.push("CONNECTION"));
  await new Promise<void>((resolve) => server.listen(0, host === "localhost" ? "127.0.0.1" : host, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://${host}:${port}`,
    hits,
    requests,
    clear() {
      hits.length = 0;
      requests.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
