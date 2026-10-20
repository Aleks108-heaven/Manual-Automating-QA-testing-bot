// A second local server on a DIFFERENT host name (localhost, not 127.0.0.1). It stands in for
// "the outside world" in the allowlist tests. It counts every connection, including websocket
// upgrades, so a test can prove that the bot sent it nothing.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface OutsideServer {
  origin: string;
  /** Every request line and every upgrade received. */
  hits: string[];
  close(): Promise<void>;
}

export async function startOutsideServer(): Promise<OutsideServer> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>outside</title><h1>OUTSIDE</h1>");
  });
  server.on("upgrade", (req, socket) => {
    hits.push(`UPGRADE ${req.url}`);
    socket.destroy();
  });
  server.on("connection", () => hits.push("CONNECTION"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://localhost:${port}`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
