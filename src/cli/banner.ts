/**
 * ASCII-art banner shown above `--help` output.
 *
 * Only `--help` gets the banner, and only when a human is looking: stdout must
 * be a TTY and wide enough to fit it. Serve mode never prints it (stdout is the
 * MCP transport, and stderr ends up in MCP client logs), and `--version` /
 * `--list-tools` stay plain so they remain pipe- and grep-friendly.
 *
 * Pure ASCII and no color, so it renders the same in every terminal.
 */

/** Narrowest terminal (in columns) that still gets the banner. */
export const MIN_BANNER_COLUMNS = 60;

/** The banner text, including the version and tagline beside the bear. */
export function renderBanner(version: string): string {
  // Mirrors brand/logo-mark.svg: squared-off "connector prong" ears on a wide
  // rounded-square head, dot eyes, and a boxed muzzle with the nose on top.
  return [
    "  .---.      .---.",
    "  |   |------|   |",
    " .'              '.",
    ` |   o        o   |     apibear v${version}`,
    " |     .----.     |     Spec in. Tools out.",
    " |     | == |     |     OpenAPI -> MCP tools over stdio",
    " '.    '----'    .'",
    "   '------------'",
  ].join("\n");
}

/** Terminal facts the banner decision depends on (a subset of `process.stdout`). */
export interface BannerTarget {
  isTTY?: boolean;
  columns?: number;
}

/** Whether `--help` output going to `target` should start with the banner. */
export function shouldShowBanner(target: BannerTarget): boolean {
  if (target.isTTY !== true) {
    return false;
  }
  // Headless ptys report no width (undefined or 0); assume it is wide enough.
  const columns = target.columns ?? 0;
  return columns === 0 || columns >= MIN_BANNER_COLUMNS;
}
