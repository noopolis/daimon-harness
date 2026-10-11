import type { OrganizationRuntimeHost, OrganizationRuntimeWakeRequest, OrganizationRuntimeWakeResult } from "./organizationRuntime.js";

// Internal capabilities are object identities, never caller-provided wire fields.
const durableRequests = new WeakSet<OrganizationRuntimeWakeRequest>();
const recordingVerifiers = new WeakMap<OrganizationRuntimeHost, (agentId: string) => Promise<void>>();

export async function wakeFromDurableInbox(host: OrganizationRuntimeHost, request: OrganizationRuntimeWakeRequest): Promise<OrganizationRuntimeWakeResult> {
  durableRequests.add(request);
  try { return await host.wake(request); }
  finally { durableRequests.delete(request); }
}

export function consumeDurableAdmission(request: OrganizationRuntimeWakeRequest): boolean {
  return durableRequests.delete(request);
}

export function registerRecordingVerifier(host: OrganizationRuntimeHost, verify: (agentId: string) => Promise<void>): OrganizationRuntimeHost {
  recordingVerifiers.set(host, verify);
  return host;
}

export async function verifyHostRecordingStore(host: OrganizationRuntimeHost, agentId: string): Promise<void> {
  await recordingVerifiers.get(host)?.(agentId);
}
