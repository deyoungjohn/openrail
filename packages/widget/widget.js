/* global document, window, URL */
(function () {
  "use strict";
  var script = document.currentScript;
  if (!script) return;
  var invoice = script.getAttribute("data-invoice");
  if (!invoice) return;
  var base = (
    script.getAttribute("data-pay-url") || new URL(script.src, document.baseURI).origin
  ).replace(/\/+$/, "");
  var label = script.getAttribute("data-label") || "Pay invoice";
  var button = document.createElement("button");
  button.type = "button";
  button.className = "openrail-widget";
  button.textContent = label;
  button.setAttribute("aria-haspopup", "dialog");
  if (script.parentNode) script.parentNode.insertBefore(button, script.nextSibling);

  var style = document.createElement("style");
  style.textContent =
    ".openrail-widget{font:inherit;padding:.7em 1.05em;border:0;border-radius:.5em;background:var(--openrail-button-bg,#111);color:var(--openrail-button-fg,#fff);cursor:pointer}" +
    ".openrail-widget:focus-visible{outline:3px solid var(--openrail-focus,#6ea8fe);outline-offset:2px}" +
    ".openrail-overlay{position:fixed;inset:0;z-index:var(--openrail-z,9999);display:grid;place-items:center;background:var(--openrail-overlay,rgba(0,0,0,.65))}" +
    ".openrail-frame{width:min(560px,100%);height:min(760px,100%);border:0;border-radius:.5em;background:var(--openrail-frame-bg,#fff)}" +
    ".openrail-close{position:fixed;top:1rem;right:1rem;width:2.5rem;height:2.5rem;border:0;border-radius:50%;font-size:1.4rem;line-height:1;cursor:pointer;background:var(--openrail-close-bg,#fff);color:var(--openrail-close-fg,#111)}" +
    ".openrail-close:focus-visible{outline:3px solid var(--openrail-focus,#6ea8fe)}";
  document.head.appendChild(style);

  var overlay = null;
  var lastFocus = null;
  function close() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("message", onMessage);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function onKey(event) {
    if (event.key === "Escape") close();
  }
  function onMessage(event) {
    if (event.origin !== new URL(base).origin) return;
    var data = event.data;
    if (
      data === "openrail:payment-complete" ||
      (data && (data.type === "openrail:payment-complete" || data.type === "openrail:paid"))
    )
      close();
  }
  function open() {
    if (overlay) return;
    lastFocus = document.activeElement;
    overlay = document.createElement("div");
    overlay.className = "openrail-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Invoice payment");
    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) close();
    });
    var frame = document.createElement("iframe");
    frame.className = "openrail-frame";
    frame.title = "Pay invoice";
    frame.src = base + "/pay/" + encodeURIComponent(invoice);
    frame.setAttribute("allow", "clipboard-write");
    var closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "openrail-close";
    closeButton.setAttribute("aria-label", "Close payment");
    closeButton.textContent = "\u00d7";
    closeButton.addEventListener("click", close);
    overlay.appendChild(frame);
    overlay.appendChild(closeButton);
    document.body.appendChild(overlay);
    closeButton.focus();
    document.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);
  }
  button.addEventListener("click", open);
})();
