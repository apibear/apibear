import { describe, expect, it, vi } from "vitest";

import { HELP_TEXT, parseCliArgs, parseHeader, type ParsedArgs, type RunnerOptions } from "../../src/cli/args.js";
import { UsageError } from "../../src/cli/errors.js";
import { VERSION } from "../../src/cli/version.js";

const SPEC = "petstore.json";

function runOptions(argv: string[]): RunnerOptions {
  const parsed = parseCliArgs(argv);
  if (parsed.kind !== "run") {
    throw new Error(`expected a run result, got ${parsed.kind}: ${JSON.stringify(parsed)}`);
  }
  return parsed.options;
}

function errorMessage(parsed: ParsedArgs): string {
  if (parsed.kind !== "error") {
    throw new Error(`expected an error result, got ${parsed.kind}: ${JSON.stringify(parsed)}`);
  }
  return parsed.message;
}

describe("parseCliArgs defaults", () => {
  it("defaults timeout to 30000, listTools to false, headers to {}, and omits only/baseUrl", () => {
    const options = runOptions(["--spec", SPEC]);

    expect(options.spec).toBe(SPEC);
    expect(options.timeoutMs).toBe(30000);
    expect(options.listTools).toBe(false);
    expect(options.headers).toEqual({});
    expect(options.only).toBeUndefined();
    expect("only" in options).toBe(false);
    expect(options.baseUrl).toBeUndefined();
    expect("baseUrl" in options).toBe(false);
  });

  it("sets listTools when --list-tools is present", () => {
    expect(runOptions(["--spec", SPEC, "--list-tools"]).listTools).toBe(true);
  });
});

describe("--header parsing", () => {
  it("splits on the first colon only", () => {
    const { headers } = runOptions(["--spec", SPEC, "--header", "Authorization: Bearer a:b:c"]);
    expect(headers).toEqual({ Authorization: "Bearer a:b:c" });
  });

  it("trims whitespace around name and value", () => {
    const { headers } = runOptions(["--spec", SPEC, "--header", "   X-Key   :   spaced value   "]);
    expect(headers).toEqual({ "X-Key": "spaced value" });
  });

  it("allows an empty value", () => {
    const { headers } = runOptions(["--spec", SPEC, "--header", "X-Empty:"]);
    expect(headers).toEqual({ "X-Empty": "" });

    const { headers: padded } = runOptions(["--spec", SPEC, "--header", "X-Empty:   "]);
    expect(padded).toEqual({ "X-Empty": "" });
  });

  it("supports multiple --header flags", () => {
    const { headers } = runOptions([
      "--spec",
      SPEC,
      "--header",
      "Authorization: Bearer token",
      "--header",
      "x-api-key: abc",
    ]);
    expect(headers).toEqual({ Authorization: "Bearer token", "x-api-key": "abc" });
  });

  it("accepts the --header=value form", () => {
    const { headers } = runOptions(["--spec", SPEC, "--header=X-Test: yes"]);
    expect(headers).toEqual({ "X-Test": "yes" });
  });

  it("errors on a missing colon without echoing the raw value", () => {
    const secret = "Authorization Bearer sk-123";
    const message = errorMessage(parseCliArgs(["--spec", SPEC, "--header", secret]));

    expect(message).toContain("--header");
    expect(message).not.toContain(secret);
    expect(message).not.toContain("sk-123");
  });

  it("errors on an empty header name", () => {
    const message = errorMessage(parseCliArgs(["--spec", SPEC, "--header", ": value"]));
    expect(message).toContain("--header");
    expect(message).not.toContain("value");
  });

  it("errors on invalid characters in the header name", () => {
    const message = errorMessage(parseCliArgs(["--spec", SPEC, "--header", "Bad Name: v"]));
    expect(message).toContain("Bad Name");
    expect(message).toContain("not a valid HTTP header name");
  });

  it("keeps the last duplicate case-insensitively", () => {
    const { headers } = runOptions([
      "--spec",
      SPEC,
      "--header",
      "X-Key: 1",
      "--header",
      "x-key: 2",
    ]);
    expect(Object.keys(headers)).toHaveLength(1);
    expect(headers["x-key"]).toBe("2");
    expect(headers["X-Key"]).toBeUndefined();
  });

  it("keeps the casing of the last duplicate", () => {
    const { headers } = runOptions([
      "--spec",
      SPEC,
      "--header",
      "x-key: 1",
      "--header",
      "X-Key: 2",
    ]);
    expect(Object.keys(headers)).toHaveLength(1);
    expect(headers["X-Key"]).toBe("2");
    expect(headers["x-key"]).toBeUndefined();
  });
});

describe("--header environment expansion", () => {
  const headersOf = (argv: string[], env: Record<string, string | undefined>) => {
    const parsed = parseCliArgs(argv, env);
    if (parsed.kind !== "run") {
      throw new Error(`expected a run result, got ${JSON.stringify(parsed)}`);
    }
    return parsed.options.headers;
  };

  it("expands ${VAR} references from the environment", () => {
    expect(
      headersOf(["--spec", SPEC, "--header", "Authorization: Bearer ${API_TOKEN}"], { API_TOKEN: "sk-1" }),
    ).toEqual({ Authorization: "Bearer sk-1" });
  });

  it("expands several references in one value", () => {
    expect(headersOf(["--spec", SPEC, "--header", "X-Pair: ${A}:${B}"], { A: "1", B: "2" })).toEqual({
      "X-Pair": "1:2",
    });
  });

  it("treats $${ as a literal ${", () => {
    expect(headersOf(["--spec", SPEC, "--header", "X-Raw: $${NOT_A_VAR}"], {})).toEqual({
      "X-Raw": "${NOT_A_VAR}",
    });
  });

  it("leaves a bare $NAME untouched", () => {
    expect(headersOf(["--spec", SPEC, "--header", "X-Raw: $HOME"], { HOME: "/root" })).toEqual({
      "X-Raw": "$HOME",
    });
  });

  it("errors on an unset or empty variable, naming it but never the value text", () => {
    for (const env of [{}, { MISSING_TOKEN: "" }]) {
      const parsed = parseCliArgs(
        ["--spec", SPEC, "--header", "X-Key: secret-prefix-${MISSING_TOKEN}"],
        env,
      );
      const message = errorMessage(parsed);
      expect(message).toBe(
        '--header "X-Key" references environment variable MISSING_TOKEN, which is not set',
      );
      expect(message).not.toContain("secret-prefix");
    }
  });
});

describe("--only parsing", () => {
  it("splits, trims, and dedupes preserving first-seen order", () => {
    const options = runOptions(["--spec", SPEC, "--only", " a, b ,c,a ,b"]);
    expect(options.only).toEqual(["a", "b", "c"]);
  });

  it("drops empty entries", () => {
    const options = runOptions(["--spec", SPEC, "--only", ",,a,,b,,"]);
    expect(options.only).toEqual(["a", "b"]);
  });

  it("errors when --only yields no ids", () => {
    expect(errorMessage(parseCliArgs(["--spec", SPEC, "--only", " , , "]))).toBe(
      "--only needs at least one operationId",
    );
    expect(errorMessage(parseCliArgs(["--spec", SPEC, "--only", ""]))).toBe(
      "--only needs at least one operationId",
    );
  });
});

describe("--base-url parsing", () => {
  it("accepts http and https URLs and returns them as given", () => {
    expect(runOptions(["--spec", SPEC, "--base-url", "http://127.0.0.1:3000/api"]).baseUrl).toBe(
      "http://127.0.0.1:3000/api",
    );
    expect(runOptions(["--spec", SPEC, "--base-url", "https://example.com/v1/"]).baseUrl).toBe(
      "https://example.com/v1/",
    );
  });

  it("rejects non-http(s) protocols", () => {
    expect(parseCliArgs(["--spec", SPEC, "--base-url", "ftp://x"]).kind).toBe("error");
  });

  it("rejects values that are not absolute URLs", () => {
    expect(parseCliArgs(["--spec", SPEC, "--base-url", "not a url"]).kind).toBe("error");
    expect(parseCliArgs(["--spec", SPEC, "--base-url", "/relative/path"]).kind).toBe("error");
  });
});

describe("--timeout parsing", () => {
  it("accepts a positive integer", () => {
    expect(runOptions(["--spec", SPEC, "--timeout", "1000"]).timeoutMs).toBe(1000);
  });

  it.each(["0", "-5", "abc", "1.5", "", " 100", "1e3"])(
    "rejects %j as a positive integer",
    (raw) => {
      expect(errorMessage(parseCliArgs(["--spec", SPEC, "--timeout", raw]))).toBe(
        "--timeout must be a positive integer (milliseconds)",
      );
    },
  );
});

describe("general CLI errors", () => {
  it("errors on an unknown flag", () => {
    const message = errorMessage(parseCliArgs(["--spec", SPEC, "--nope"]));
    expect(message).toContain("--nope");
  });

  it("errors on a positional argument", () => {
    expect(parseCliArgs(["--spec", SPEC, "extra"]).kind).toBe("error");
  });

  it("requires --spec", () => {
    expect(errorMessage(parseCliArgs([]))).toBe("--spec is required");
    expect(errorMessage(parseCliArgs(["--list-tools"]))).toBe("--spec is required");
    expect(errorMessage(parseCliArgs(["--spec", ""]))).toBe("--spec is required");
    expect(errorMessage(parseCliArgs(["--spec", "   "]))).toBe("--spec is required");
  });

  it("errors when --header has no value", () => {
    expect(parseCliArgs(["--spec", SPEC, "--header"]).kind).toBe("error");
  });
});

describe("help and version", () => {
  it("returns help for --help and -h without requiring --spec", () => {
    for (const flag of ["--help", "-h"]) {
      const parsed = parseCliArgs([flag]);
      expect(parsed).toEqual({ kind: "help", text: HELP_TEXT });
    }
  });

  it("returns the version for --version without requiring --spec", () => {
    expect(parseCliArgs(["--version"])).toEqual({ kind: "version", text: VERSION });
  });

  it("lets help and version win over other arguments, including a missing spec", () => {
    expect(parseCliArgs(["--list-tools", "--help"]).kind).toBe("help");
    expect(parseCliArgs(["--version", "--only", "a"]).kind).toBe("version");
    expect(parseCliArgs(["--help", "--version"]).kind).toBe("help");
  });

  it("exposes real help text with the usage line and exit codes", () => {
    expect(HELP_TEXT).toContain("apibear --spec <path|url> [options]");
    expect(HELP_TEXT).toContain("--header");
    expect(HELP_TEXT).toContain("--only");
    expect(HELP_TEXT).toContain("--base-url");
    expect(HELP_TEXT).toContain("--timeout");
    expect(HELP_TEXT).toContain("--list-tools");
    expect(HELP_TEXT).toContain("--help");
    expect(HELP_TEXT).toContain("--version");
    expect(HELP_TEXT).toContain("stderr");
    expect(HELP_TEXT).not.toContain("TODO");
  });
});

describe("parseHeader", () => {
  it("splits on the first colon and trims both sides", () => {
    expect(parseHeader("  Authorization :  Bearer a:b:c ")).toEqual({
      name: "Authorization",
      value: "Bearer a:b:c",
    });
  });

  it("allows an empty value", () => {
    expect(parseHeader("X-Empty:")).toEqual({ name: "X-Empty", value: "" });
    expect(parseHeader("X-Empty:   ")).toEqual({ name: "X-Empty", value: "" });
  });

  it("throws UsageError when the colon is missing, without echoing the raw input", () => {
    const secret = "Authorization Bearer sk-123";
    let caught: unknown;
    try {
      parseHeader(secret);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UsageError);
    expect((caught as Error).message).not.toContain(secret);
    expect((caught as Error).message).not.toContain("sk-123");
  });

  it("throws UsageError for an empty name", () => {
    expect(() => parseHeader(": value")).toThrow(UsageError);
    expect(() => parseHeader("   : value")).toThrow(UsageError);
  });

  it("throws UsageError for an invalid token name", () => {
    expect(() => parseHeader("Bad Name: value")).toThrow(UsageError);
    expect(() => parseHeader("Bad@Name: value")).toThrow(UsageError);
    expect(() => parseHeader("Bad\u0000Name: value")).toThrow(UsageError);
  });

  it("accepts all valid token characters", () => {
    expect(() => parseHeader("!#$%&'*+-.^_`|~09AZaz: v")).not.toThrow();
  });
});

describe("purity", () => {
  it("writes nothing to stdout or stderr", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      parseCliArgs(["--spec", SPEC]);
      parseCliArgs(["--help"]);
      parseCliArgs(["--version"]);
      parseCliArgs([]);
      parseCliArgs(["--spec", SPEC, "--header", "Authorization Bearer sk-123"]);
      parseCliArgs(["--nope"]);

      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
