import { useEffect, useState } from "react";
import type { MonitorSnapshot } from "../../shared/monitor";
import { api } from "./api";

export function useMonitorState() {
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectionLabel, setConnectionLabel] = useState("connecting");

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retryHandle: number | null = null;
    let disposed = false;

    const loadSnapshot = async () => {
      try {
        const next = await api.fetchSnapshot();
        if (!disposed) {
          setSnapshot(next);
          setError(null);
        }
      } catch (loadError) {
        if (!disposed) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      }
    };

    const connect = async () => {
      await loadSnapshot();
      if (disposed) {
        return;
      }

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

      socket.onopen = () => {
        setConnectionLabel("live");
      };

      socket.onmessage = (event) => {
        const message = JSON.parse(event.data) as {
          type: string;
          payload?: MonitorSnapshot;
        };

        if (message.type === "snapshot" && message.payload) {
          setSnapshot(message.payload);
          setError(null);
        }
      };

      socket.onerror = () => {
        setConnectionLabel("retrying");
      };

      socket.onclose = () => {
        setConnectionLabel("reconnecting");
        if (!disposed) {
          retryHandle = window.setTimeout(connect, 1500);
        }
      };
    };

    void connect();

    return () => {
      disposed = true;
      if (retryHandle !== null) {
        window.clearTimeout(retryHandle);
      }
      socket?.close();
    };
  }, []);

  return {
    snapshot,
    error,
    connectionLabel
  };
}
