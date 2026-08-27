import {
  DEFAULT_FILE,
  fileTypeFor,
  folderTypeFor,
} from "../../../lib/fileTypes.ts";

const SIZE = 15;

interface FileIconProps {
  extension: string | undefined;
  /** Full filename, when available -- lets `package.json` and `.gitignore`
   *  render distinctly from any other .json / extensionless file. */
  name?: string;
}

/** One 15px slot, whatever goes in it.
 *
 *  Fixed size and centred so that a row's label sits at the same indent
 *  whichever glyph landed beside it — the reason this renders a fallback
 *  rather than nothing when a file is unrecognised. */
const Slot = ({ children }: { children: React.ReactNode }) => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: SIZE,
      height: SIZE,
      flex: "none",
    }}
  >
    {children}
  </span>
);

/** Always renders something.
 *
 *  The mapping lives in `lib/fileTypes.ts`, shared with the Monaco language
 *  lookup, so the icon and the highlighting cannot disagree about what a file
 *  is — which they did while each had a table of its own.
 */
export const FileIcon = ({ extension, name }: FileIconProps) => {
  const { icon: Icon, color } = fileTypeFor(extension, name) ?? DEFAULT_FILE;

  return (
    <Slot>
      <Icon color={color} size={SIZE} />
    </Slot>
  );
};

interface FolderIconProps {
  name: string;
  open: boolean;
}

/** The folder equivalent, open and closed.
 *
 *  VS Code gives `src`, `test`, `node_modules` and about eighty others their
 *  own glyph, and it is more of what makes a tree recognisable than the file
 *  icons are — a folder is what someone is actually scanning for.
 */
export const FolderIcon = ({ name, open }: FolderIconProps) => {
  const type = folderTypeFor(name);
  const Icon = open ? type.open : type.closed;

  return (
    <Slot>
      <Icon color={type.color} size={SIZE} />
    </Slot>
  );
};
