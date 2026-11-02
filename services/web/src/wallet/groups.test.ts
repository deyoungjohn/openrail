import { describe, expect, it } from "vitest";
import { groupWallets } from "./groups";
import type { NearWalletInfo } from "./near";

const w = (id: string, over: Partial<NearWalletInfo> = {}): NearWalletInfo => ({
  id,
  name: id,
  iconUrl: null,
  type: "injected",
  available: true,
  signsMessage: null,
  ...over,
});

describe("groupWallets", () => {
  const list = [
    w("a", { signsMessage: false }),
    w("b", { signsMessage: true }),
    w("c"),
    w("d", { available: false, signsMessage: true }),
  ];

  it("sign-in puts wallets that can sign a message first, and keeps the rest apart", () => {
    const g = groupWallets(list, "signIn");
    expect(g.usable.map((x) => x.id)).toEqual(["b"]);
    expect(g.checking.map((x) => x.id)).toEqual(["c"]);
    expect(g.cannotSign.map((x) => x.id)).toEqual(["a"]);
    expect(g.unavailable.map((x) => x.id)).toEqual(["d"]);
  });

  it("connecting for a transaction does not care about signMessage", () => {
    const g = groupWallets(list, "connect");
    expect(g.usable.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(g.cannotSign).toEqual([]);
    expect(g.unavailable.map((x) => x.id)).toEqual(["d"]);
  });

  it("an unknown capability is never counted as supported", () => {
    expect(groupWallets([w("x")], "signIn").usable).toEqual([]);
  });
});
