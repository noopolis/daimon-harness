import type { OrganizationRuntimeHost, OrganizationRuntimeWakeRequest, OrganizationRuntimeWakeResult } from "./organizationRuntime.js";

// Internal capabilities are object identities, never caller-provided wire fields.
type DurableAdmission = "awake" | "dream";
const durableRequests = new WeakMap<OrganizationRuntimeWakeRequest, DurableAdmission>();
const recordingVerifiers = new WeakMap<OrganizationRuntimeHost, (agentId: string) => Promise<void>>();

export async function wakeFromDurableInbox(host: OrganizationRuntimeHost, request: OrganizationRuntimeWakeRequest, admission: DurableAdmission = "awake"): Promise<OrganizationRuntimeWakeResult> {
  durableRequests.set(request, admission);
  try { return await host.wake(request); }
  finally { durableRequests.delete(request); }
}

export function consumeDurableAdmission(request: OrganizationRuntimeWakeRequest): DurableAdmission | undefined {
  const admission = durableRequests.get(request);
  durableRequests.delete(request);
  return admission;
}

export function registerRecordingVerifier(host: OrganizationRuntimeHost, verify: (agentId: string) => Promise<void>): OrganizationRuntimeHost {
  recordingVerifiers.set(host, verify);
  return host;
}

export async function verifyHostRecordingStore(host: OrganizationRuntimeHost, agentId: string): Promise<void> {
  await recordingVerifiers.get(host)?.(agentId);
}
