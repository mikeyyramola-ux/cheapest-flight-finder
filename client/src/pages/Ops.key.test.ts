import { describe, expect, it, vi } from "vitest";
import { takeUrlKey } from "./Ops";

/**
 * The operations key can arrive in the query string, which is how the PRIME dashboard
 * embeds this board: an iframe pointing at /ops?token=... so the operator never types it.
 *
 * Storage is denied outright for a cross-origin iframe - the SecurityError is thrown by
 * reading the `sessionStorage` property, not by the write - so remembering the key and
 * honouring it have to be independent. They were not: setItem ran before setToken, the
 * throw escaped the whole branch, and the page showed its key gate while sitting on a
 * valid key. Confirmed against fareloop.in framed inside the PRIME dashboard, where the
 * board never rendered and the URL still carried ?token=.
 */
describe("operations key supplied in the query string", () => {
  it("finds nothing when no key was passed", () => {
    const remember = vi.fn();
    const strip = vi.fn();
    expect(takeUrlKey("", remember, strip)).toBeNull();
    expect(takeUrlKey("?from=DEL&to=DXB", remember, strip)).toBeNull();
    expect(remember).not.toHaveBeenCalled();
    expect(strip).not.toHaveBeenCalled();
  });

  it("remembers the key and takes it back out of the address bar", () => {
    let stored = "";
    let address = "?token=abc123";
    const key = takeUrlKey(
      address,
      value => {
        stored = value;
      },
      () => {
        address = "/ops";
      },
    );
    expect(key).toBe("abc123");
    expect(stored).toBe("abc123");
    expect(address).toBe("/ops");
  });

  // The regression this file exists for.
  it("still honours the key when storage is denied", () => {
    const remember = (): void => {
      throw new Error("Failed to read the 'sessionStorage' property from 'Window': Access is denied for this document.");
    };
    const strip = vi.fn();
    expect(takeUrlKey("?token=abc123", remember, strip)).toBe("abc123");
    expect(strip).toHaveBeenCalledOnce();
  });

  it("keeps the key when the address bar cannot be rewritten", () => {
    const strip = (): void => {
      throw new Error("SecurityError: replaceState is not allowed");
    };
    expect(takeUrlKey("?token=abc123", vi.fn(), strip)).toBe("abc123");
  });

  it("survives both optional parts failing together", () => {
    const boom = (): never => {
      throw new Error("denied");
    };
    expect(takeUrlKey("?token=abc123", boom, boom)).toBe("abc123");
  });

  it("passes the key through exactly as given", () => {
    expect(takeUrlKey("?token=%20abc%20", vi.fn(), vi.fn())).toBe(" abc ");
  });
});
