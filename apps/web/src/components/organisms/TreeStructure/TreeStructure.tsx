import { useEffect } from "react";
import { Flex, Spin } from "antd";
import { useTreeStructureStore } from "../../../store/treeStructureStore.ts";
import { TreeNode } from "../../molecules/TreeNode/TreeNode.tsx";
import { FileContextMenu } from "../../molecules/ContextMenu/FileContextMenu.tsx";

export const TreeStructure = () => {
  const { treeStructure, refreshTree, projectId } = useTreeStructureStore();

  useEffect(() => {
    if (projectId && !treeStructure) void refreshTree();
  }, [projectId, treeStructure, refreshTree]);

  return (
    <>
      <div className="rc-pane-label">Files</div>

      {treeStructure ? (
        <TreeNode node={treeStructure} />
      ) : (
        <Flex justify="center" style={{ padding: 24 }}>
          <Spin size="small" />
        </Flex>
      )}

      <FileContextMenu />
    </>
  );
};
