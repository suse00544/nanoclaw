const UPSTREAM = "https://api.b.ai";

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const relayToken = request.headers.get("x-nanoclaw-relay");

  if (!env.RELAY_TOKEN || relayToken !== env.RELAY_TOKEN) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (!url.pathname.startsWith("/v1/")) {
    return new Response("Not found", { status: 404 });
  }

  const headers = new Headers(request.headers);
  headers.delete("x-nanoclaw-relay");
  headers.delete("host");

  const upstreamUrl = new URL(url.pathname + url.search, UPSTREAM);
  return fetch(upstreamUrl, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD"
      ? undefined
      : request.body,
    redirect: "manual",
  });
}
