import { describe, expect, it } from "vitest";
import { collectSettingsSections } from "./module-settings";

const Panel = () => null;

describe("collectSettingsSections", () => {
  it("returns nothing for no modules", () => {
    expect(collectSettingsSections([])).toEqual([]);
  });

  it("collects the sections of every module that has them", () => {
    const sections = collectSettingsSections([
      { module: { settingsSections: [{ id: "a", label: "A", Panel }] } },
      { module: {} },
      { module: null },
      { module: { settingsSections: [{ id: "b", label: "B", Panel }] } },
    ]);
    expect(sections.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("skips a malformed section instead of breaking the page", () => {
    const sections = collectSettingsSections([
      { module: { settingsSections: [{ id: 1 }, null, { id: "ok", label: "Ok", Panel }] } },
      { module: { settingsSections: "nope" } },
    ]);
    expect(sections.map((s) => s.id)).toEqual(["ok"]);
  });
});
