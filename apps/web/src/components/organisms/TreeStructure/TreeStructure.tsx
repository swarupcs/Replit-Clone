import { useEffect } from "react";
import { Flex, Spin, Typography } from "antd";
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
      <Typography.Text
        style={{
          display: "block",
          padding: "10px 12px 6px",
          fontSize: 11,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--rc-text-subtle)",
        }}
      >
        Files
      </Typography.Text>

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
