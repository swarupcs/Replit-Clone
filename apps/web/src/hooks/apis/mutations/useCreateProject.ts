import { useMutation } from "@tanstack/react-query";
import { createProjectApi } from "../../../apis/projects.ts";

export const useCreateProject = () => {
  const { mutateAsync, isPending, isSuccess, error } = useMutation({
    mutationFn: createProjectApi,
  });

  return {
    createProjectMutation: mutateAsync,
    isPending,
    isSuccess,
    error,
  };
};
