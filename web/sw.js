// Emkay – Service Worker: serves the stock ovos-control-panel.
//
// On a device the panel is a web server on a port. A browser cannot listen
// on a port, so the panel runs inside the worker (py/emkay_mobile/panel.py)
// and this Service Worker is its "network": every request the panel's pages
// make is answered by the panel app itself, through the Emkay page that
// owns the worker:
//
//   panel iframe --fetch--> here --MessageChannel--> app.js --> worker.js
//
// The panel is unchanged. Two things a server on its own port never needs
// are done here:
//   * Its pages use absolute paths ("/controls", "/static/app.js",
//     location.href = "/login"). The site may live below a path (GitHub
//     Pages: /emkay/), so links and redirects in what it sends get
//     the panel's prefix (./panel/), and requests under that prefix get it
//     removed again. fetch()es to its root paths (/api/, /static/) come
//     here anyway, since the iframe is one of this worker's pages.
//   * Its cross-site check reads Sec-Fetch-Site, which a Service Worker
//     cannot pass on. It is set here from where the request really came
//     from: "same-origin" only for this site's own pages, otherwise
//     "cross-site", which the panel refuses for anything that writes.
//   * It forbids every frame (X-Frame-Options: DENY, frame-ancestors
//     'none') against clickjacking by other sites. Emkay shows it in a frame
//     over the face, because leaving the page would stop OVOS, so this one
//     site may frame it (SAMEORIGIN, 'self'); other sites still may not.

const PREFIX = new URL("./panel/", self.registration.scope).pathname;
/** The panel's own absolute paths, outside the prefix. */
const ROOTS = ["/api/", "/static/", "/login", "/healthz"];
/**
 * How long a request may wait for the Emkay page. OVOS runs in one thread,
 * so while it trains a newly installed skill (minutes on a phone) the panel
 * waits for its answer rather than getting an error.
 */
const TIMEOUT_MS = 300000;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/** The panel's path for a request URL, or null if it is not the panel's. */
function panelPath(url) {
  if (url.origin !== self.location.origin) return null;
  if (url.pathname.startsWith(PREFIX)) return "/" + url.pathname.slice(PREFIX.length);
  if (ROOTS.some((r) => url.pathname.startsWith(r) || url.pathname === r.replace(/\/$/, ""))) {
    return url.pathname;
  }
  return null;
}

/**
 * The visage (web/visage2/) fetches GUI resources from
 * res/ (ovos-gui's cache) and res-abs/ (absolute paths), which its nginx
 * sidecar serves from OVOS' disk on a device. Here they come from the
 * worker's file system (worker_main.res_file).
 */
const VISAGE2 = new URL("./visage2/", self.registration.scope).pathname;
const RES_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  svg: "image/svg+xml", webp: "image/webp", json: "application/json", mp3: "audio/mpeg",
  wav: "audio/wav", ogg: "audio/ogg", html: "text/html", txt: "text/plain" };

async function serveRes(path) {
  const page = await emkayPage();
  if (!page) return new Response("", { status: 503 });
  const reply = await new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve({}), 30000);
    channel.port1.onmessage = ({ data }) => { clearTimeout(timer); resolve(data); };
    page.postMessage({ resRequest: decodeURIComponent(path) }, [channel.port2]);
  });
  if (!reply.body) return new Response("", { status: 404 });
  const ext = path.split(".").pop().toLowerCase();
  const headers = new Headers({ "content-type": RES_TYPES[ext] || "application/octet-stream" });
  embeddable(headers);
  return new Response(reply.body, { headers });
}

/**
 * What this worker makes up can be shown inside a cross-origin isolated
 * Emkay: in VS Code for the Web (Emkay Dev, ?dev) Emkay itself sits in a
 * frame of a page with COEP: require-corp, so everything it frames or loads
 * must allow that too (the site's own files get the same headers from
 * Cloudflare). Outside such a page the headers change nothing.
 */
function embeddable(headers) {
  if (!headers.has("cross-origin-embedder-policy")) headers.set("cross-origin-embedder-policy", "credentialless");
  if (!headers.has("cross-origin-resource-policy")) headers.set("cross-origin-resource-policy", "cross-origin");
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith(VISAGE2)) {
    const rest = url.pathname.slice(VISAGE2.length);
    if (rest.startsWith("res/") || rest.startsWith("res-abs/")) return event.respondWith(serveRes(rest));
  }
  const path = panelPath(url);
  if (path !== null) return event.respondWith(serve(event, path, url));
  if (fresh(event.request, url)) event.respondWith(revalidated(event.request));
});

/**
 * The site's own files are served with max-age=14400 (Cloudflare), and a
 * reload checks the page, not the modules its workers import: after a
 * release a device ran the old whisper.js for hours, next to the new
 * app.js. Every one of them is asked for again here, with the copy the
 * browser has (no-cache: a 304 when nothing changed). Not the page itself
 * (a navigation can't be asked for this way; it is max-age=600), not a
 * range (media), and not other sites.
 */
function fresh(req, url) {
  return req.method === "GET" && url.origin === self.location.origin && req.mode !== "navigate"
    && !req.headers.has("range");
}

/** `req` checked with the server; offline: the copy the browser has, as before. */
async function revalidated(req) {
  try {
    return await fetch(req, { cache: "no-cache" });
  } catch {
    return fetch(req, { cache: "force-cache" });   // even an expired one
  }
}

/** True when the request came from one of this site's own pages. */
async function fromThisSite(event) {
  const req = event.request;
  if (event.clientId) {
    const client = await self.clients.get(event.clientId);
    if (client) return new URL(client.url).origin === self.location.origin;
  }
  // a navigation has no client yet: go by the page it came from
  try {
    return new URL(req.referrer).origin === self.location.origin;
  } catch {
    return false;
  }
}

/** The top-level Emkay page that owns the worker (not a panel frame). */
async function emkayPage() {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return all.find((c) => !new URL(c.url).pathname.startsWith(PREFIX) && c.frameType === "top-level")
    || all.find((c) => !new URL(c.url).pathname.startsWith(PREFIX));
}

/** Answer one panel request through the Emkay page's worker. */
async function serve(event, path, url) {
  const req = event.request;
  const page = await emkayPage();
  if (!page) {
    return new Response("Open Emkay first: the settings live inside it.", {
      status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const headers = [];
  for (const [k, v] of req.headers) {
    if (!["origin", "referer", "sec-fetch-site"].includes(k)) headers.push([k, v]);
  }
  headers.push(["sec-fetch-site", (await fromThisSite(event)) ? "same-origin" : "cross-site"]);
  const body = ["GET", "HEAD"].includes(req.method) ? null : await req.arrayBuffer();

  const reply = await new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), TIMEOUT_MS);
    channel.port1.onmessage = ({ data }) => { clearTimeout(timer); resolve(data); };
    page.postMessage({ panelRequest: {
      method: req.method, path, query: url.search.slice(1), headers, body,
    } }, [channel.port2, ...(body ? [body] : [])]);
  });
  if (!reply) return new Response("Emkay did not answer in time.", { status: 504 });
  return toResponse(reply);
}

/** The panel's answer as a Response, with its absolute paths prefixed. */
function toResponse({ status, headers, body }) {
  const out = new Headers();
  let type = "";
  for (const [k, v] of headers) {
    const name = k.toLowerCase();
    if (name === "content-length") continue;   // the body may be rewritten
    if (name === "location" && v.startsWith("/") && !v.startsWith("//")) {
      out.append(k, PREFIX + v.slice(1));
      continue;
    }
    if (name === "content-type") type = v;
    if (name === "x-frame-options") { out.append(k, "SAMEORIGIN"); continue; }
    if (name === "content-security-policy") {
      out.append(k, v.replace(/frame-ancestors\s+'none'/, "frame-ancestors 'self'"));
      continue;
    }
    out.append(k, v);
  }
  let data = body;
  if (/text\/html|javascript/.test(type) && PREFIX !== "/") {
    data = prefixPaths(new TextDecoder().decode(body), type.includes("html"));
  }
  const nullBody = [101, 204, 205, 304].includes(status);
  embeddable(out);
  return new Response(nullBody ? null : data, { status, headers: out });
}

/**
 * Put the panel's prefix on the absolute paths its pages navigate to:
 * href/src/action="/..." and location.href = "/...". Plain fetch("/api/...")
 * needs nothing (it comes here either way) but is harmless to prefix too.
 */
function prefixPaths(text, html) {
  const out = text
    .replace(/\b(href|src|action)="\/(?!\/)/g, `$1="${PREFIX}`)
    .replace(/(location\.href\s*=\s*["'`])\/(?!\/)/g, `$1${PREFIX}`);
  return html ? out.replace(/<\/head>/i, `${LINK_FIX}</head>`) : out;
}

/**
 * The panel also builds links in JavaScript (its menu). This, added to each
 * of its pages (its CSP allows inline scripts), puts the prefix on a
 * root-absolute link just before the browser follows it.
 */
const LINK_FIX = `<script>/* emkay: keep links inside ${PREFIX} (see sw.js) */
addEventListener("click", (e) => {
  const a = e.target.closest && e.target.closest("a[href]");
  const h = a && a.getAttribute("href");
  if (h && h[0] === "/" && h[1] !== "/" && !h.startsWith(${JSON.stringify(PREFIX)})) {
    a.setAttribute("href", ${JSON.stringify(PREFIX)} + h.slice(1));
  }
}, true);
</script>`;

