import { describe, expect, it } from "vitest";
import { LighterSigner } from "../../src/exchanges/lighter/signer";
import { LIGHTER_ORDER_TYPE, LIGHTER_TIME_IN_FORCE } from "../../src/exchanges/lighter/constants";

describe("LighterSigner", () => {
  it("produces a valid create order signature", async () => {
    const signer = new LighterSigner({
      accountIndex: 65,
      chainId: 300,
      // Throwaway test fixture; not a funded account.
      apiKeys: {
        3: "0x13e5f39d25709c1f4c07bfb4bbbde4f01eac5ca79e0ea6be702d6c39eb8b39f33bc5e974d70ccd39",
      },
    });

    const signed = await signer.signCreateOrder({
      marketIndex: 0,
      clientOrderIndex: 123n,
      baseAmount: 1000n,
      price: 170000,
      isAsk: 1,
      orderType: LIGHTER_ORDER_TYPE.MARKET,
      timeInForce: LIGHTER_TIME_IN_FORCE.IMMEDIATE_OR_CANCEL,
      reduceOnly: 0,
      triggerPrice: 0,
      orderExpiry: 0n,
      apiKeyIndex: 3,
      nonce: 42n,
    });

    const payload = JSON.parse(signed.txInfo);
    expect(payload.AccountIndex).toBe(65);
    expect(payload.ApiKeyIndex).toBe(3);
    expect(payload).toMatchObject({
      MarketIndex: 0,
      ClientOrderIndex: 123,
      BaseAmount: 1000,
      Price: 170000,
      IsAsk: 1,
      Type: LIGHTER_ORDER_TYPE.MARKET,
      TimeInForce: LIGHTER_TIME_IN_FORCE.IMMEDIATE_OR_CANCEL,
      ReduceOnly: 0,
      TriggerPrice: 0,
      OrderExpiry: 0,
    });
    expect(typeof payload.Sig).toBe("string");
    expect(payload.Sig.length).toBeGreaterThan(0);
    expect(signed.txHash ?? "").toMatch(/^[0-9a-f]+$/);
    expect(typeof signed.signature).toBe("string");
    expect(signed.signature.length).toBeGreaterThan(0);
  });
});
