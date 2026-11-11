// GENERATED, do not edit. Source: openrail.modules.json (scripts/gen-modules.ts).
import * as m_checkout from "./modules/checkout";
import * as m_settle from "./modules/settle";

export interface EnabledModule {
  readonly id: string;
  readonly module: unknown;
}

export const enabledModules: readonly EnabledModule[] = [
  { id: "checkout", module: m_checkout },
  { id: "settle", module: m_settle },
];
