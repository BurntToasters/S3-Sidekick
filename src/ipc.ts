import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { IpcCommand, IpcCommandArgs } from "./generated/ipc-contract.ts";

export type { IpcCommand, IpcCommandArgs };

type RequiredKeys<T> = {
  [K in keyof T]-?: undefined extends T[K] ? never : K;
}[keyof T];

/** `[command, args]`, with `args` optional when nothing is required. */
type CallFor<K extends IpcCommand, A> = [RequiredKeys<A>] extends [never]
  ? [command: K, args?: A]
  : [command: K, args: A];

export type InvokeCall = {
  [K in IpcCommand]: CallFor<K, IpcCommandArgs[K]>;
}[IpcCommand];

/**
 * Typed `invoke`: the command name and argument keys are checked against
 * the contract generated from the Rust commands, so a rename on either side
 * fails the type check instead of failing at runtime.
 */
export function invoke<T = unknown>(...call: InvokeCall): Promise<T> {
  const [command, args] = call;
  return call.length > 1
    ? tauriInvoke<T>(command, args as Record<string, unknown>)
    : tauriInvoke<T>(command);
}

/** Commands scoped to an S3 connection session. */
export type S3Command = {
  [K in IpcCommand]: "connectionId" extends keyof IpcCommandArgs[K] ? K : never;
}[IpcCommand];

export type S3InvokeCall = {
  [K in S3Command]: CallFor<K, Omit<IpcCommandArgs[K], "connectionId">>;
}[S3Command];
