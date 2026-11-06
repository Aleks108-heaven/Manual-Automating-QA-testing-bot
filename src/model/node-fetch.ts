// A small `fetch` over node:http and node:https, used to talk to a model server.
//
// Why not the built-in fetch: Node's fetch (undici) gives up on a response whose headers take more than five minutes
// (UND_ERR_HEADERS_TIMEOUT), and the same for a body that pauses for five minutes. A model on a laptop CPU reads a long prompt for
// longer than that before it writes the first byte, so the built-in fetch ends a call that was going to succeed (a log from Ollama
// shows it: the request ended at exactly 5m0s with the prompt almost read). The node:http client has no such limit. The only limit
// here is the one the caller sets with its signal (provider.requestTimeoutMs, and the kill switch).
//
// It supports what the model client needs: a method, headers, a string body, a signal, and a streamed response. It never follows a
// redirect (a 3xx answer is returned as it is, and the caller treats it as an error).
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

const NO_BODY = new Set([101, 204, 205, 304]);

export const nodeFetch: typeof fetch = (input, init) =>
  new Promise<Response>((resolve, reject) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = init?.body === undefined || init.body === null ? null : String(init.body);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    // A fixed length, as the built-in fetch sends, so that no server has to handle a chunked request body.
    if (body !== null) headers["content-length"] = String(Buffer.byteLength(body));
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(url, { method: init?.method ?? "GET", headers, ...(init?.signal ? { signal: init.signal } : {}) }, (res) => {
      const status = res.statusCode ?? 0;
      if (status < 200 || status > 599) {
        res.destroy();
        reject(new Error(`unexpected HTTP status ${status}`));
        return;
      }
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      if (NO_BODY.has(status)) res.resume();
      resolve(new Response(NO_BODY.has(status) ? null : (Readable.toWeb(res) as unknown as ReadableStream), { status, statusText: res.statusMessage ?? "", headers: responseHeaders }));
    });
    req.on("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
