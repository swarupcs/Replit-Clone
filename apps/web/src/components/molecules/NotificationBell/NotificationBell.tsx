import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge, Button, Dropdown, Empty, Spin } from "antd";
import { VscBell } from "react-icons/vsc";
import type { Notification, NotificationList } from "@replit-clone/shared";
import {
  listNotificationsApi,
  markNotificationsReadApi,
} from "../../../apis/notifications.ts";

/** What the platform has told this person.
 *
 *  The counterpart to a decision made on the server: a notification is a
 *  stored record, and mail is opportunistic. This is the channel that always
 *  works — no SMTP, no verified address, nothing to configure — which is why
 *  it is the one that has to be right.
 *
 *  Polled rather than pushed. There is a socket, but it is per-project and
 *  these are not: the news that matters most here is about a project nobody
 *  has open, which is precisely the case a project socket cannot cover.
 */
const POLL_MS = 60_000;

/** Failures are swallowed on purpose. A bell that cannot reach the server is a
 *  bell with nothing to show — and a toast every minute on a flaky connection
 *  would be worse than the silence this feature exists to end. */
export const NotificationBell = () => {
  const navigate = useNavigate();
  const [list, setList] = useState<NotificationList | null>(null);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setList(await listNotificationsApi());
    } catch {
      setList((current) => current ?? { items: [], unread: 0 });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [refresh]);

  const markAll = async () => {
    try {
      setList(await markNotificationsReadApi());
    } catch {
      // Left unread rather than optimistically cleared: a badge that clears
      // and comes back is worse than one that did not clear.
    }
  };

  const follow = async (item: Notification) => {
    setOpen(false);

    if (!item.readAt) {
      try {
        setList(await markNotificationsReadApi([item.id]));
      } catch {
        // Going where they asked matters more than the badge.
      }
    }

    if (item.link) void navigate(item.link);
  };

  const items = list?.items ?? [];

  return (
    <Dropdown
      open={open}
      onOpenChange={setOpen}
      trigger={["click"]}
      placement="bottomRight"
      popupRender={() => (
        <div className="rc-notifs">
          <div className="rc-notifs-head">
            <span>Notifications</span>
            {(list?.unread ?? 0) > 0 && (
              <Button size="small" type="link" onClick={() => void markAll()}>
                Mark all read
              </Button>
            )}
          </div>

          {list === null ? (
            <div className="rc-notifs-loading">
              <Spin size="small" />
            </div>
          ) : items.length === 0 ? (
            <div className="rc-notifs-empty">
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <span className="rc-deploy-blurb">
                    Nothing yet. A scheduled job that starts failing, or a
                    change to one of your projects, shows up here.
                  </span>
                }
              />
            </div>
          ) : (
            <div className="rc-notifs-list">
              {items.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className="rc-notif"
                  data-unread={item.readAt ? undefined : "yes"}
                  onClick={() => void follow(item)}
                >
                  <span className="rc-notif-title">{item.title}</span>
                  <span className="rc-notif-body">{item.body}</span>
                  <span className="rc-notif-when">{when(item.createdAt)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    >
      <Badge count={list?.unread ?? 0} size="small" offset={[-2, 2]}>
        <Button
          icon={<VscBell />}
          aria-label={
            (list?.unread ?? 0) > 0
              ? `Notifications, ${String(list?.unread ?? 0)} unread`
              : "Notifications"
          }
        />
      </Badge>
    </Dropdown>
  );
};

/** How long ago, in the coarsest unit that is still true. */
function when(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${String(minutes)}m ago`;
  if (minutes < 60 * 24) return `${String(Math.round(minutes / 60))}h ago`;
  return `${String(Math.round(minutes / (60 * 24)))}d ago`;
}
