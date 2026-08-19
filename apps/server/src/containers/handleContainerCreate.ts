import Docker from "dockerode";
import type { Container, ContainerInfo } from "dockerode";
import { projectDir } from "../service/projectService.js";

const docker = new Docker();

/** Port the scaffolded Vite dev server listens on inside the container.
 *  Phase 3 replaces this constant with a per-template `devPort`. */
const DEV_PORT = "5173/tcp";

export const listContainer = async (): Promise<ContainerInfo[]> => {
  const containers = await docker.listContainers();
  return containers;
};

/** Find a container by its exact name.
 *
 *  dockerode expects `{ filters: { name: [...] } }` — passing a bare `name`
 *  key is silently ignored, which previously returned ALL containers and could
 *  force-remove an unrelated one. Docker's name filter is a substring match, so
 *  we still compare exactly ("/" prefix included) on the way out.
 */
async function findContainerByName(
  name: string,
): Promise<ContainerInfo | undefined> {
  const containers = await docker.listContainers({
    all: true,
    filters: { name: [name] },
  });

  return containers.find((info) => info.Names.includes(`/${name}`));
}

export const handleContainerCreate = async (
  projectId: string,
): Promise<Container | undefined> => {
  try {
    const existing = await findContainerByName(projectId);

    if (existing) {
      await docker.getContainer(existing.Id).remove({ force: true });
    }

    const container = await docker.createContainer({
      Image: "sandbox",
      name: projectId,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Cmd: ["/bin/bash"],
      Tty: true,
      User: "sandbox",
      Volumes: {
        "/home/sandbox/app": {},
      },
      ExposedPorts: {
        [DEV_PORT]: {},
      },
      Env: ["HOST=0.0.0.0"],
      HostConfig: {
        Binds: [`${projectDir(projectId)}:/home/sandbox/app`],
        PortBindings: {
          [DEV_PORT]: [{ HostPort: "0" }],
        },
      },
    });

    await container.start();

    return container;
  } catch (error) {
    console.error("Error while creating container", error);
    return undefined;
  }
};

export async function getContainerPort(
  containerName: string,
): Promise<string | undefined> {
  const info = await findContainerByName(containerName);
  if (!info) return undefined;

  const inspected = await docker.getContainer(info.Id).inspect();
  return inspected.NetworkSettings?.Ports?.[DEV_PORT]?.[0]?.HostPort;
}
