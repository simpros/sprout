export type DeploySnapshotFields = {
  status?: string;
  preview_url?: string | null;
  last_error?: string | null;
  last_error_detail?: string | null;
};

export type DeployOutcome =
  | { kind: "ready"; previewUrl: string }
  | { kind: "failed"; message: string }
  | { kind: "pending" };

export function deployOutcome(data: DeploySnapshotFields): DeployOutcome {
  if (data.last_error) {
    if (
      typeof data.last_error_detail === "string" &&
      data.last_error_detail.trim() !== ""
    ) {
      return {
        kind: "failed",
        message: `${data.last_error}: ${data.last_error_detail.trim()}`,
      };
    }
    return { kind: "failed", message: data.last_error };
  }
  if (data.status === "failed") {
    return { kind: "failed", message: "preview_failed" };
  }
  if (
    data.status === "running" &&
    typeof data.preview_url === "string" &&
    data.preview_url.length > 0
  ) {
    return { kind: "ready", previewUrl: data.preview_url };
  }
  return { kind: "pending" };
}
