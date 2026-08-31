import type { ApiSuccess, NotificationList } from "@replit-clone/shared";
import axios from "../config/axiosConfig.ts";

/** Somebody's own notifications.
 *
 *  No id in any path: every one of these is scoped to whoever holds the token,
 *  which is the only scoping that cannot be forgotten.
 */
export const listNotificationsApi = async (): Promise<NotificationList> => {
  const response =
    await axios.get<ApiSuccess<NotificationList>>("/api/v1/notifications");
  return response.data.data;
};

/** Marks notifications read, or all of them when given none.
 *
 *  Answers with the new list rather than nothing, so the badge and the list
 *  cannot disagree — two round trips is exactly how they come to.
 */
export const markNotificationsReadApi = async (
  ids?: string[],
): Promise<NotificationList> => {
  const response = await axios.post<ApiSuccess<NotificationList>>(
    "/api/v1/notifications/read",
    ids ? { ids } : {},
  );
  return response.data.data;
};
