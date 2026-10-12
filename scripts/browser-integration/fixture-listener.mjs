import { randomInt } from "node:crypto";

// Keep HTTP fixtures outside Chromium's restricted service ports. In the
// pinned browser (f842f52ef39fd97b449eb27cff414bf05a98ddce), the highest entry in
// net/base/port_util.cc's kRestrictedPorts is 10080. Windows may assign one of
// those ports to listen(0); reserve a dynamic/private port directly instead.
// Browser policies/field trials can restrict more ports; do not bypass them.
export async function listenFixture(server, { choosePort = () => randomInt(49152, 65536), attempts = 16 } = {}) {
  if (server.listening) throw new Error("Fixture server is already listening");
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 16) throw new Error("Invalid fixture bind limit");
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const port = choosePort();
    if (!Number.isInteger(port) || port < 49152 || port > 65535) throw new Error("Fixture port must be in the dynamic/private range");
    try {
      await new Promise((resolve, reject) => {
        const cleanup = () => { server.off("error", onError); server.off("listening", onListening); };
        const onError = error => { cleanup(); reject(error); };
        const onListening = () => { cleanup(); resolve(); };
        server.once("error", onError); server.once("listening", onListening);
        try { server.listen({ port, host: "127.0.0.1", exclusive: true }); }
        catch (error) { cleanup(); reject(error); }
      });
      const address = server.address();
      if (!address || typeof address !== "object" || address.port !== port || address.address !== "127.0.0.1")
        throw new Error("Fixture listener does not match its reserved endpoint");
      return port;
    } catch (error) {
      if (server.listening || !["EADDRINUSE", "EACCES"].includes(error.code)) throw error;
      lastError = error;
    }
  }
  throw new Error("Could not bind an available loopback fixture port", { cause: lastError });
}
