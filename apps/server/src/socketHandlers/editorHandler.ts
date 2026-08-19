import fs from "node:fs/promises";
import type { Namespace, Socket } from "socket.io";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SocketData,
} from "@replit-clone/shared";
import { getContainerPort } from "../containers/handleContainerCreate.js";

export type EditorSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

export type EditorNamespace = Namespace<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

export const handleEditorSocketEvents = (
  socket: EditorSocket,
  editorNamespace: EditorNamespace,
): void => {
  socket.on("writeFile", async ({ data, pathToFileOrFolder }) => {
    try {
      await fs.writeFile(pathToFileOrFolder, data);
      editorNamespace.emit("writeFileSuccess", {
        data: "File written successfully",
        path: pathToFileOrFolder,
      });
    } catch (error) {
      console.error("Error writing the file", error);
      socket.emit("error", { data: "Error writing the file" });
    }
  });

  socket.on("createFile", async ({ pathToFileOrFolder }) => {
    // `fs.stat` REJECTS when the path is absent, so the previous truthiness
    // check never ran and an existing file was silently truncated.
    if (await exists(pathToFileOrFolder)) {
      socket.emit("error", { data: "File already exists" });
      return;
    }

    try {
      await fs.writeFile(pathToFileOrFolder, "");
      socket.emit("createFileSuccess", { data: "File created successfully" });
    } catch (error) {
      console.error("Error creating the file", error);
      socket.emit("error", { data: "Error creating the file" });
    }
  });

  socket.on("readFile", async ({ pathToFileOrFolder }) => {
    try {
      const contents = await fs.readFile(pathToFileOrFolder);
      socket.emit("readFileSuccess", {
        value: contents.toString(),
        path: pathToFileOrFolder,
      });
    } catch (error) {
      console.error("Error reading the file", error);
      socket.emit("error", { data: "Error reading the file" });
    }
  });

  socket.on("deleteFile", async ({ pathToFileOrFolder }) => {
    try {
      await fs.unlink(pathToFileOrFolder);
      socket.emit("deleteFileSuccess", { data: "File deleted successfully" });
    } catch (error) {
      console.error("Error deleting the file", error);
      socket.emit("error", { data: "Error deleting the file" });
    }
  });

  socket.on("createFolder", async ({ pathToFileOrFolder }) => {
    try {
      await fs.mkdir(pathToFileOrFolder);
      socket.emit("createFolderSuccess", {
        data: "Folder created successfully",
      });
    } catch (error) {
      console.error("Error creating the folder", error);
      socket.emit("error", { data: "Error creating the folder" });
    }
  });

  socket.on("deleteFolder", async ({ pathToFileOrFolder }) => {
    try {
      // `fs.rmdir` with `recursive` is deprecated and a no-op on newer Node.
      await fs.rm(pathToFileOrFolder, { recursive: true, force: true });
      socket.emit("deleteFolderSuccess", {
        data: "Folder deleted successfully",
      });
    } catch (error) {
      console.error("Error deleting the folder", error);
      socket.emit("error", { data: "Error deleting the folder" });
    }
  });

  socket.on("getPort", async ({ containerName }) => {
    const port = await getContainerPort(containerName);
    socket.emit("getPortSuccess", { port });
  });
};
