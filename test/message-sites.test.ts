import { describe, expect, it } from "vitest";
import { foreignSites } from "../src/core";

describe("sign-in text from another site", () => {
  it("says nothing when the message names the requesting site, its subdomains or its parent", () => {
    expect(foreignSites("Sign in to app.pearl.xyz\nNonce: 8f2a", "https://app.pearl.xyz")).toEqual([]);
    expect(foreignSites("Welcome to pearl.xyz", "https://app.pearl.xyz")).toEqual([]);
    expect(foreignSites("Login at https://www.shop.example.com/login", "https://shop.example.com")).toEqual([]);
  });
  it("flags another site named in the message", () => {
    expect(foreignSites("Sign in to bigvault.io\nNonce: 1234", "https://evil.example")).toEqual(["bigvault.io"]);
    expect(foreignSites("https://www.Other-Site.com/auth?x=1", "https://pearl.xyz")).toEqual(["other-site.com"]);
  });
  it("ignores amounts, versions, e-mails and file names", () => {
    expect(foreignSites("Pay 0.05 PRL with Keshi v1.0.1, e.g. now. Contact me@mail.com. File: photo.png", "https://pearl.xyz")).toEqual([]);
  });
  it("lists at most three and copes with a bad origin", () => {
    expect(foreignSites("a1.com b2.com c3.com d4.com", "https://pearl.xyz")).toHaveLength(3);
    expect(foreignSites("a1.com", "not a url")).toEqual([]);
  });
});
