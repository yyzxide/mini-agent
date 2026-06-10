import { Collapse, Timeline, Typography } from "antd";
import type { AgentTaskEvent } from "../types/event";
import { formatTime } from "../utils/formatTime";
import { getEventDisplayMeta, parsePayload, summarizePayload } from "../utils/eventMapper";
import { EmptyState } from "./EmptyState";

interface EventTimelineProps {
  events: AgentTaskEvent[];
}

export function EventTimeline({ events }: EventTimelineProps) {
  if (events.length === 0) {
    return <EmptyState description="No events yet" />;
  }

  return (
    <Timeline
      items={events.map((event) => {
        const meta = getEventDisplayMeta(event.eventType);
        return {
          color: meta.color,
          dot: meta.icon,
          children: (
            <div className="event-item">
              <div className="event-row">
                <Typography.Text strong>{event.eventType}</Typography.Text>
                <Typography.Text type="secondary">{formatTime(event.createdAt)}</Typography.Text>
              </div>
              <Typography.Paragraph className="event-summary" ellipsis={{ rows: 2 }}>
                {summarizePayload(event.payload)}
              </Typography.Paragraph>
              <Collapse
                size="small"
                ghost
                items={[
                  {
                    key: "payload",
                    label: "Payload",
                    children: <pre className="json-block">{JSON.stringify(parsePayload(event.payload), null, 2)}</pre>,
                  },
                ]}
              />
            </div>
          ),
        };
      })}
    />
  );
}
