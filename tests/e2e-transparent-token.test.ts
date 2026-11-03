import { describe, expect, it } from "vitest";
import { hasTransparentToken, TRANSPARENT_TOKEN } from "../scripts/e2e/transparent-token.mjs";

const V1 = `[SGP1:${"deadbeef".repeat(4)}-00000001]`;
const V2 = "[SGP2:PII_EMAIL-abcd-efgh-ijkl]";

describe("E2E transparent token matcher", () => {
  it.each([V1, V2])("matches %s", (token) => {
    expect(TRANSPARENT_TOKEN.test(`before ${token} after`)).toBe(true);
  });

  it.each(["[SGP1:…]", "[SGP2:…]", "[SGP2:pii-abcd-efgh-ijkl]", "[SGP1:deadbeef-1]"])(
    "rejects malformed %s",
    (text) => {
      expect(TRANSPARENT_TOKEN.test(text)).toBe(false);
    },
  );

  it("does not count literal fixtures as protection", () => {
    expect(hasTransparentToken(`explain ${V1} and ${V2}`, [V1, V2])).toBe(false);
  });

  it("still finds a minted token beside literal fixtures", () => {
    const minted = "[SGP2:SECRET-wxyz-abcd-efgh]";
    expect(hasTransparentToken(`explain ${V1} and ${V2} for ${minted}`, [V1, V2])).toBe(true);
  });
});
