import { describe, expect, it } from "vitest";
import { WatcherStore } from "./store.js";

describe("watcher store", () => {
  it("a folder the service may not write to starts empty instead of stopping the watcher", () => {
    // /dev/null is a file, so a folder below it cannot be created (ENOTDIR).
    const store = new WatcherStore("/dev/null/openrail/watcher.sqlite");
    expect(store.load()).toEqual([]);
    store.close();
  });
});
