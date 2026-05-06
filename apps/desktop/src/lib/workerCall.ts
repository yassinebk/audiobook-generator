import { invoke } from "@tauri-apps/api/core";

export async function workerCall(
  command: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const raw = await invoke<string>("run_worker", {
    command,
    inputJson: JSON.stringify(input),
  });
  return JSON.parse(raw) as Record<string, unknown>;
}
