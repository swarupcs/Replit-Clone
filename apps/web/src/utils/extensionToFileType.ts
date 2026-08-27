import { fileTypeFor } from "../lib/fileTypes.ts";

/** Maps a file to a Monaco language id.
 *
 *  A thin accessor over `lib/fileTypes.ts` rather than a table of its own.
 *  It used to be the second of two tables describing the same property, and
 *  the two disagreed — this one was the wider, so a `.rs` file was
 *  highlighted as Rust under a generic file glyph. The signature is
 *  unchanged; only what stands behind it is.
 *
 *  `null` in the table means the format genuinely has no Monaco language, and
 *  `undefined` here means the file is not in the table at all. Both surface
 *  as `undefined` to callers, which treat that as plain text — the right
 *  answer for an unknown format.
 */
export const extensionToFileType = (
  extension: string | undefined,
  name?: string,
): string | undefined => fileTypeFor(extension, name)?.language ?? undefined;
