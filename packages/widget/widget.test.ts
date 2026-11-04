import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./widget.js", import.meta.url), "utf8");

interface FakeElement {
  tagName: string;
  className: string;
  type: string;
  src: string;
  title: string;
  textContent: string;
  removed: boolean;
  attributes: Record<string, string>;
  children: FakeElement[];
  parentNode: FakeElement | null;
  nextSibling: FakeElement | null;
  handlers: Record<string, (event: { target?: FakeElement; key?: string }) => void>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  appendChild(child: FakeElement): void;
  insertBefore(child: FakeElement, before: FakeElement | null): void;
  addEventListener(
    name: string,
    handler: (event: { target?: FakeElement; key?: string }) => void,
  ): void;
  remove(): void;
  focus(): void;
}

function element(tagName: string): FakeElement {
  const node: FakeElement = {
    tagName,
    className: "",
    type: "",
    src: "",
    title: "",
    textContent: "",
    removed: false,
    attributes: {},
    children: [],
    parentNode: null,
    nextSibling: null,
    handlers: {},
    getAttribute(name) {
      return node.attributes[name] ?? null;
    },
    setAttribute(name, value) {
      node.attributes[name] = value;
    },
    appendChild(child) {
      child.parentNode = node;
      node.children.push(child);
    },
    insertBefore(child, before) {
      child.parentNode = node;
      const index = before === null ? node.children.length : node.children.indexOf(before);
      node.children.splice(index < 0 ? node.children.length : index, 0, child);
    },
    addEventListener(name, handler) {
      node.handlers[name] = handler;
    },
    remove() {
      node.removed = true;
    },
    focus() {
      document.activeElement = node;
    },
  };
  return node;
}

const document: {
  currentScript: FakeElement | null;
  baseURI: string;
  activeElement: FakeElement | null;
  head: FakeElement;
  body: FakeElement;
  listeners: Record<string, (event: { key?: string }) => void>;
  createElement(tag: string): FakeElement;
  addEventListener(name: string, handler: (event: { key?: string }) => void): void;
  removeEventListener(name: string): void;
} = {
  currentScript: null,
  baseURI: "https://pay.example.com/docs",
  activeElement: null,
  head: element("head"),
  body: element("body"),
  listeners: {},
  createElement: element,
  addEventListener(name, handler) {
    document.listeners[name] = handler;
  },
  removeEventListener(name) {
    delete document.listeners[name];
  },
};

const window = {
  listeners: {} as Record<string, (event: { origin: string; data: unknown }) => void>,
  addEventListener(name: string, handler: (event: { origin: string; data: unknown }) => void) {
    window.listeners[name] = handler;
  },
  removeEventListener(name: string) {
    delete window.listeners[name];
  },
};

function mount(): { button: FakeElement; script: FakeElement } {
  document.body.children = [];
  document.head.children = [];
  document.listeners = {};
  window.listeners = {};
  const script = element("script");
  script.src = "https://pay.example.com/widget.js";
  script.attributes["data-invoice"] = "c-1";
  const parent = element("div");
  parent.appendChild(script);
  document.currentScript = script;
  runInNewContext(source, { document, window, URL, encodeURIComponent });
  const button = parent.children.find((child) => child.tagName === "button");
  if (button === undefined) throw new Error("button not rendered");
  return { button, script };
}

describe("widget", () => {
  it("stays under 6 KB gzipped", () => {
    expect(gzipSync(source).length).toBeLessThan(6 * 1024);
  });

  it("opens a dialog with the hosted pay page and closes on Esc", () => {
    const { button } = mount();
    expect(button.textContent).toBe("Pay invoice");
    button.handlers.click?.({});
    const overlay = document.body.children.find((child) => child.className === "openrail-overlay");
    expect(overlay).toBeDefined();
    const frame = overlay?.children.find((child) => child.tagName === "iframe");
    expect(frame?.src).toBe("https://pay.example.com/pay/c-1");
    expect(overlay?.attributes.role).toBe("dialog");
    document.listeners.keydown?.({ key: "Escape" });
    expect(overlay?.removed).toBe(true);
  });

  it("closes on the payment-complete message from the pay origin only", () => {
    const { button } = mount();
    button.handlers.click?.({});
    const overlay = document.body.children.find((child) => child.className === "openrail-overlay");
    window.listeners.message?.({ origin: "https://evil.example", data: { type: "openrail:paid" } });
    expect(overlay?.removed).toBe(false);
    window.listeners.message?.({
      origin: "https://pay.example.com",
      data: { type: "openrail:payment-complete" },
    });
    expect(overlay?.removed).toBe(true);
  });

  it("has no inline style attributes", () => {
    expect(source).not.toMatch(/style=/);
    expect(source).toContain("--openrail-");
  });
});
