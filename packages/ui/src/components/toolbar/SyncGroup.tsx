import React from "react";
import { CloudDownload, CloudUpload } from "lucide-react";
import { IconButton } from "./IconButton.js";

interface SyncGroupProps {
  onPull: () => void;
  onPush: () => void;
  syncing: "pull" | "push" | null;
  lastSyncedAt?: string;
}

export function SyncGroup({ onPull, onPush, syncing, lastSyncedAt }: SyncGroupProps) {
  return (
    <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
      <IconButton
        icon={<CloudDownload size={14} />}
        title="Pull from GitHub"
        onClick={onPull}
        disabled={!!syncing}
      >
        {syncing === "pull" ? "…" : null}
      </IconButton>
      <IconButton
        icon={<CloudUpload size={14} />}
        title="Push to GitHub"
        onClick={onPush}
        disabled={!!syncing}
      >
        {syncing === "push" ? "…" : null}
      </IconButton>
      {lastSyncedAt && (
        <span style={{ color: "#888", fontSize: 10 }}>
          {new Date(lastSyncedAt).toLocaleTimeString()}
        </span>
      )}
    </div>
  );
}
