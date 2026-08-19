import { useEffect } from "react";
import { useTreeStructureStore } from "../../../store/treeStructureStore.ts";
import { useFileContextMenuStore } from "../../../store/fileContextMenuStore.ts";
import { TreeNode } from "../../molecules/TreeNode/TreeNode.tsx";
import { FileContextMenu } from "../../molecules/ContextMenu/FileContextMenu.tsx";

export const TreeStructure = () => {
  const { treeStructure, setTreeStructure } = useTreeStructureStore();
  const {
    file,
    isOpen: isFileContextOpen,
    x: fileContextX,
    y: fileContextY,
  } = useFileContextMenuStore();

  useEffect(() => {
    if (!treeStructure) {
      void setTreeStructure();
    }
  }, [setTreeStructure, treeStructure]);

  return (
    <>
      {isFileContextOpen &&
        fileContextX !== null &&
        fileContextY !== null &&
        file !== null && (
          <FileContextMenu x={fileContextX} y={fileContextY} path={file} />
        )}
      <TreeNode fileFolderData={treeStructure} />
    </>
  );
};
