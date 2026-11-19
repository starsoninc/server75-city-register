/* Service worker — push alerts only (push p1). No fetch handler and no cache:
   the page loads exactly as it did before this file existed. */
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener("push", function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: "Alert", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Alert", {
    body: d.body || "",
    tag: d.tag || undefined,
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-72.png",
    data: { url: d.url || "/" }
  }));
});

self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (wins) {
    for (var i = 0; i < wins.length; i++) {
      var w = wins[i];
      if (new URL(w.url).origin === new URL(url).origin && "focus" in w) {
        return (w.navigate && w.url !== url ? w.navigate(url) : Promise.resolve(w)).then(function (x) { return (x || w).focus(); });
      }
    }
    return self.clients.openWindow(url);
  }));
});
