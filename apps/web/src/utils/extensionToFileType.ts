/** Maps a bare file extension (no leading dot) to a Monaco language id. */
const extensionToTypeMap: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  html: "html",
  css: "css",
  md: "markdown",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  svg: "svg",
};

export const extensionToFileType = (
  extension: string | undefined,
): string | undefined => {
  if (!extension) return undefined;
  return extensionToTypeMap[extension];
};
