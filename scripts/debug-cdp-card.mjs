const port = Number(process.argv[2] ?? 9222);
const noteId = String(process.argv[3] ?? "6719a379000000002401507f");

const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
const page = list.find(item => item.type === "page" && item.url.includes("xiaohongshu.com"));
if (!page) throw new Error("No Xiaohongshu page found");

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
ws.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  pending.get(message.id)(message);
  pending.delete(message.id);
});
await new Promise(resolve => ws.addEventListener("open", resolve, { once: true }));

function send(method, params = {}) {
  const id = nextId++;
  return new Promise(resolve => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send("Runtime.enable");
await send("Page.bringToFront");

const expression = `(${function inspectCard(noteId) {
  const href = `/explore/${noteId}`;
  const link =
    document.querySelector(`a[href="${href}"]`) ||
    document.querySelector(`a[href="https://www.xiaohongshu.com${href}"]`);
  const card = link?.closest(".note-item") || link;
  if (!card) {
    return {
      found: false,
      url: location.href,
      title: document.title,
      body: (document.body.innerText || "").slice(0, 800)
    };
  }
  card.scrollIntoView({ block: "center", inline: "center" });
  const rect = card.getBoundingClientRect();
  const linkRect = link.getBoundingClientRect();
  const points = [
    ["card-top", rect.left + rect.width / 2, rect.top + 30],
    ["card-mid", rect.left + rect.width / 2, rect.top + Math.min(160, rect.height / 2)],
    ["safe-click", rect.left + rect.width / 2, Math.min(rect.bottom - 30, Math.max(180, rect.top + rect.height / 2))],
    ["link-top", linkRect.left + linkRect.width / 2, linkRect.top + 20],
    ["link-mid", linkRect.left + linkRect.width / 2, linkRect.top + linkRect.height / 2],
    ["left-top", rect.left + 30, rect.top + 30]
  ].map(([name, x, y]) => {
    const el = document.elementFromPoint(x, y);
    return {
      name,
      x: Math.round(x),
      y: Math.round(y),
      tag: el?.tagName ?? "",
      className: String(el?.className ?? ""),
      text: String(el?.innerText || el?.alt || "").slice(0, 120),
      closestHref: el?.closest?.("a")?.href ?? ""
    };
  });

  return {
    found: true,
    url: location.href,
    title: document.title,
    rect: {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    },
    linkRect: {
      left: Math.round(linkRect.left),
      top: Math.round(linkRect.top),
      width: Math.round(linkRect.width),
      height: Math.round(linkRect.height)
    },
    linkHref: link.href,
    cardClass: String(card.className ?? ""),
    cardText: (card.innerText || "").slice(0, 240),
    points
  };
}})(${JSON.stringify(noteId)})`;

const result = await send("Runtime.evaluate", {
  expression,
  returnByValue: true,
  awaitPromise: true
});
console.log(JSON.stringify(result.result.result.value, null, 2));
ws.close();
