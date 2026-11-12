import { describe, expect, it } from "vitest";

import { dedupeName, fallbackOperationId, sanitizeName } from "../../src/core/naming.js";

describe("sanitizeName", () => {
  it("passes valid operation ids through unchanged", () => {
    expect(sanitizeName("getPets")).toBe("getPets");
    expect(sanitizeName("list_pets-v1")).toBe("list_pets-v1");
    expect(sanitizeName("A1_b-2")).toBe("A1_b-2");
  });

  it("replaces illegal characters with underscores", () => {
    expect(sanitizeName("pets/get")).toBe("pets_get");
    expect(sanitizeName("get pets")).toBe("get_pets");
    expect(sanitizeName("pets.list")).toBe("pets_list");
    expect(sanitizeName("caf\u00e9")).toBe("caf_");
  });

  it("replaces unicode characters (including surrogate pairs) with a single underscore", () => {
    expect(sanitizeName("getPets\u{1F43B}")).toBe("getPets_");
    expect(sanitizeName("g\u00e9t\u00e9")).toBe("g_t_");
  });

  it("collapses runs of underscores and strips leading underscores", () => {
    expect(sanitizeName("a//b")).toBe("a_b");
    expect(sanitizeName("a   b")).toBe("a_b");
    expect(sanitizeName("a___b")).toBe("a_b");
    expect(sanitizeName("_pets")).toBe("pets");
    expect(sanitizeName("___pets")).toBe("pets");
    expect(sanitizeName("///pets")).toBe("pets");
  });

  it("truncates to 64 characters", () => {
    const result = sanitizeName("a".repeat(100));
    expect(result).toHaveLength(64);
    expect(result).toBe("a".repeat(64));
  });

  it("returns an empty string for input with only illegal characters", () => {
    expect(sanitizeName("///")).toBe("");
    expect(sanitizeName("")).toBe("");
  });
});

describe("dedupeName", () => {
  it("returns a fresh candidate unchanged and records it lowercased", () => {
    const used = new Set<string>();
    expect(dedupeName("x", used)).toBe("x");
    expect(used.has("x")).toBe(true);
  });

  it("appends _2, _3, ... on repeated collisions", () => {
    const used = new Set<string>();
    expect(dedupeName("x", used)).toBe("x");
    expect(dedupeName("x", used)).toBe("x_2");
    expect(dedupeName("x", used)).toBe("x_3");
    expect(used).toEqual(new Set(["x", "x_2", "x_3"]));
  });

  it("treats collisions case-insensitively", () => {
    const used = new Set<string>();
    expect(dedupeName("getPets", used)).toBe("getPets");
    expect(dedupeName("getpets", used)).toBe("getpets_2");
    expect(used.has("getpets")).toBe(true);
    expect(used.has("getpets_2")).toBe(true);
  });

  it("keeps deduped names within the 64-character cap", () => {
    const used = new Set<string>();
    const longName = "a".repeat(64);
    expect(dedupeName(longName, used)).toBe(longName);

    const second = dedupeName(longName, used);
    expect(second).toHaveLength(64);
    expect(second).toBe(`${"a".repeat(62)}_2`);

    const third = dedupeName(longName, used);
    expect(third).toHaveLength(64);
    expect(third).toBe(`${"a".repeat(62)}_3`);
  });

  it("falls back to operation_N for an empty candidate", () => {
    const used = new Set<string>();
    expect(dedupeName("", used)).toBe("operation_1");
    expect(dedupeName("", used)).toBe("operation_2");
    expect(used).toEqual(new Set(["operation_1", "operation_2"]));
  });

  it("skips operation_N counters already present in the set", () => {
    const used = new Set<string>(["operation_1", "operation_3"]);
    expect(dedupeName("", used)).toBe("operation_2");
    expect(dedupeName("", used)).toBe("operation_4");
  });
});

describe("fallbackOperationId", () => {
  it("builds a fallback id from a path template with braces", () => {
    expect(fallbackOperationId("get", "/pets/{petId}")).toBe("get_pets_petId");
    expect(fallbackOperationId("patch", "/users/{userId}/pets/{petId}")).toBe(
      "patch_users_userId_pets_petId",
    );
  });

  it("builds a fallback id for paths without templates", () => {
    expect(fallbackOperationId("post", "/pets")).toBe("post_pets");
    expect(fallbackOperationId("delete", "/pets/")).toBe("delete_pets_");
  });

  it("returns the pre-sanitization id (sanitization is applied separately)", () => {
    expect(fallbackOperationId("get", "/pets/{pet id}")).toBe("get_pets_pet id");
    expect(sanitizeName(fallbackOperationId("get", "/pets/{pet id}"))).toBe("get_pets_pet_id");
  });
});
