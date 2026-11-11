import type { ComponentType } from "react";

/** A settings tab an enabled module adds. The core settings screen names none of them. */
export interface SettingsSection {
  id: string;
  label: string;
  Panel: ComponentType;
}

/** Sections from a list of modules; a module without `settingsSections`, or with a malformed one, adds nothing. */
export function collectSettingsSections(
  modules: readonly { module: unknown }[],
): SettingsSection[] {
  return modules.flatMap(({ module }) => {
    const sections = (module as { settingsSections?: unknown } | null)?.settingsSections;
    if (!Array.isArray(sections)) return [];
    return sections.filter(
      (s): s is SettingsSection =>
        typeof s === "object" &&
        s !== null &&
        typeof (s as SettingsSection).id === "string" &&
        typeof (s as SettingsSection).label === "string" &&
        (s as SettingsSection).Panel !== undefined,
    );
  });
}
