import { useQuery } from "@tanstack/react-query";
import { pingApi } from "../../../apis/ping.ts";

export default function usePing() {
  // `queryKey` must be an array — it was previously the bare string 'ping'.
  const { isLoading, isError, data, error } = useQuery({
    queryKey: ["ping"],
    queryFn: pingApi,
    staleTime: 10_000,
  });

  return { isLoading, isError, data, error };
}
