/**
 * Vault Commitments — typed API client
 *
 * Backend contract (for when the real API lands):
 *
 *   GET  /api/v1/vaults/{vaultId}/commitments
 *        ?lp={address}           ← LP-scoped (own commitment)
 *        ?role=operator          ← all LP commitments for operator
 *   → VaultCommitment[]
 *
 *   POST /api/v1/vaults/{vaultId}/commitments
 *        { lp_wallet_address, committed_amount, expires_at,
 *          reserves_capacity, notes }
 *   → VaultCommitment
 *
 *   POST /api/v1/vaults/{vaultId}/commitments/{id}/acknowledge
 *   → VaultCommitment
 *
 *   POST /api/v1/vaults/{vaultId}/commitments/{id}/calls
 *        { call_amount, grace_period_ms?, note? }
 *   → CapitalCall
 *
 *   POST /api/v1/vaults/{vaultId}/calls/{callId}/fund
 *        { funding_amount, funding_epoch, share_price }
 *   → { call: CapitalCall; commitment: VaultCommitment; tx_id: string }
 *
 *   POST /api/v1/vaults/{vaultId}/calls/{callId}/default
 *   → CapitalCall
 *
 *   POST /api/v1/vaults/{vaultId}/calls/{callId}/waive
 *        { note? }
 *   → CapitalCall
 *
 *   GET  /api/v1/vaults/{vaultId}/commitments/{id}/events
 *   → CommitmentEvent[]
 *
 * Until the backend ships, a mock implementation is used when
 * NEXT_PUBLIC_VAULTS !== "live".
 */

import {
  buildCommitment,
  buildCapitalCall,
  applyFunding,
  computeRemainingCallable,
  DEFAULT_GRACE_PERIOD_MS,
  type VaultCommitment,
  type CapitalCall,
  type CommitmentEvent,
  type CommitmentSummary,
} from "../vaultCommitments";

// ---------------------------------------------------------------------------
// Request / response types
// ---------------------------------------------------------------------------

export interface CreateCommitmentRequest {
  lpWalletAddress: string;
  committedAmount: number;
  expiresAt: string; // ISO-8601
  reservesCapacity: boolean;
  notes?: string;
}

export interface IssueCapitalCallRequest {
  callAmount: number;
  gracePeriodMs?: number;
  note?: string;
}

export interface FundCallRequest {
  fundingAmount: number;
  fundingEpoch: number;
  sharePrice: number;
}

export interface FundCallResult {
  call: CapitalCall;
  commitment: VaultCommitment;
  txId: string;
}

// ---------------------------------------------------------------------------
// In-memory mock store
// ---------------------------------------------------------------------------

let mockCommitments: VaultCommitment[] = [];
let mockCalls: CapitalCall[] = [];
let mockEvents: CommitmentEvent[] = [];
let _idCounter = 1;

function nextId(): string {
  return `mock-${(_idCounter++).toString().padStart(4, "0")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function emitEvent(
  type: CommitmentEvent["type"],
  commitmentId: string,
  capitalCallId: string | null,
  actorAddress: string,
  metadata: CommitmentEvent["metadata"] = {},
): CommitmentEvent {
  const evt: CommitmentEvent = {
    id: nextId(),
    commitmentId,
    capitalCallId,
    type,
    occurredAt: nowIso(),
    actorAddress,
    metadata,
  };
  mockEvents.push(evt);
  return evt;
}

function seedMockData(vaultId: string, operatorAddress: string) {
  // Only seed once per vault
  if (mockCommitments.some(c => c.vaultId === vaultId)) return;

  const lp1 = "GINSTITUTION1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
  const lp2 = "GINSTITUTION2XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

  // LP1 — active commitment, one funded call, one open call
  const c1 = buildCommitment({
    id: nextId(),
    vaultId,
    lpWalletAddress: lp1,
    committedAmount: 500_000,
    expiresAt: new Date(Date.now() + 90 * 86400_000).toISOString(),
    reservesCapacity: true,
    notes: "Q4 2026 institutional allocation",
    nowIso: new Date(Date.now() - 30 * 86400_000).toISOString(),
  });
  c1.state = "ACTIVE";
  c1.acknowledgedAt = new Date(Date.now() - 29 * 86400_000).toISOString();
  c1.calledAmount = 200_000;
  c1.remainingCallable = computeRemainingCallable(500_000, 200_000);
  mockCommitments.push(c1);

  // Funded call on c1
  const call1 = buildCapitalCall({
    id: nextId(),
    commitmentId: c1.id,
    vaultId,
    lpWalletAddress: lp1,
    callAmount: 200_000,
    gracePeriodMs: DEFAULT_GRACE_PERIOD_MS,
    note: "Epoch 45 capital call",
    nowIso: new Date(Date.now() - 20 * 86400_000).toISOString(),
  });
  call1.state = "FUNDED";
  call1.fundedAmount = 200_000;
  call1.settledAt = new Date(Date.now() - 18 * 86400_000).toISOString();
  call1.fundingEpoch = 45;
  call1.sharePrice = 1.042;
  call1.sharesMinted = parseFloat((200_000 / 1.042).toFixed(4));
  mockCalls.push(call1);

  // Open call on c1
  const call2 = buildCapitalCall({
    id: nextId(),
    commitmentId: c1.id,
    vaultId,
    lpWalletAddress: lp1,
    callAmount: 100_000,
    gracePeriodMs: DEFAULT_GRACE_PERIOD_MS,
    note: "Epoch 47 capital call",
    nowIso: new Date(Date.now() - 2 * 86400_000).toISOString(),
  });
  mockCalls.push(call2);

  // LP2 — pending acknowledgement
  const c2 = buildCommitment({
    id: nextId(),
    vaultId,
    lpWalletAddress: lp2,
    committedAmount: 250_000,
    expiresAt: new Date(Date.now() + 60 * 86400_000).toISOString(),
    reservesCapacity: false,
    notes: "Pending LP2 onboarding",
    nowIso: new Date(Date.now() - 1 * 86400_000).toISOString(),
  });
  mockCommitments.push(c2);

  emitEvent("COMMITMENT_CREATED", c1.id, null, operatorAddress, { committedAmount: 500_000 });
  emitEvent("COMMITMENT_ACKNOWLEDGED", c1.id, null, lp1, {});
  emitEvent("CALL_ISSUED", c1.id, call1.id, operatorAddress, { callAmount: 200_000 });
  emitEvent("CALL_FUNDED", c1.id, call1.id, lp1, { fundedAmount: 200_000, sharesMinted: call1.sharesMinted });
  emitEvent("CALL_ISSUED", c1.id, call2.id, operatorAddress, { callAmount: 100_000 });
  emitEvent("COMMITMENT_CREATED", c2.id, null, operatorAddress, { committedAmount: 250_000 });
}

// ---------------------------------------------------------------------------
// Mock implementations
// ---------------------------------------------------------------------------

async function mockGetCommitments(
  vaultId: string,
  opts: { lpWalletAddress?: string; allForOperator?: boolean; operatorAddress?: string },
): Promise<VaultCommitment[]> {
  await new Promise(r => setTimeout(r, 300));
  seedMockData(vaultId, opts.operatorAddress ?? "GOPERATOR");
  return mockCommitments
    .filter(c => c.vaultId === vaultId)
    .filter(c => opts.lpWalletAddress ? c.lpWalletAddress === opts.lpWalletAddress : true);
}

async function mockCreateCommitment(
  vaultId: string,
  req: CreateCommitmentRequest,
  operatorAddress: string,
): Promise<VaultCommitment> {
  await new Promise(r => setTimeout(r, 400));
  const commitment = buildCommitment({
    id: nextId(),
    vaultId,
    lpWalletAddress: req.lpWalletAddress,
    committedAmount: req.committedAmount,
    expiresAt: req.expiresAt,
    reservesCapacity: req.reservesCapacity,
    notes: req.notes,
    nowIso: nowIso(),
  });
  mockCommitments.push(commitment);
  emitEvent("COMMITMENT_CREATED", commitment.id, null, operatorAddress, { committedAmount: req.committedAmount });
  return commitment;
}

async function mockAcknowledgeCommitment(
  vaultId: string,
  commitmentId: string,
  lpAddress: string,
): Promise<VaultCommitment> {
  await new Promise(r => setTimeout(r, 300));
  const idx = mockCommitments.findIndex(c => c.id === commitmentId && c.vaultId === vaultId);
  if (idx === -1) throw new Error(`Commitment ${commitmentId} not found.`);
  const c = mockCommitments[idx];
  if (c.state !== "PENDING_ACKNOWLEDGEMENT") throw new Error(`Commitment is not pending acknowledgement.`);
  const updated: VaultCommitment = { ...c, state: "ACTIVE", acknowledgedAt: nowIso() };
  mockCommitments[idx] = updated;
  emitEvent("COMMITMENT_ACKNOWLEDGED", commitmentId, null, lpAddress, {});
  return updated;
}

async function mockIssueCapitalCall(
  vaultId: string,
  commitmentId: string,
  req: IssueCapitalCallRequest,
  operatorAddress: string,
): Promise<CapitalCall> {
  await new Promise(r => setTimeout(r, 400));
  const commitment = mockCommitments.find(c => c.id === commitmentId && c.vaultId === vaultId);
  if (!commitment) throw new Error(`Commitment ${commitmentId} not found.`);
  if (commitment.state !== "ACTIVE") throw new Error(`Commitment is not ACTIVE.`);
  if (req.callAmount > commitment.remainingCallable) {
    throw new Error(`Call amount exceeds remaining callable.`);
  }
  const call = buildCapitalCall({
    id: nextId(),
    commitmentId,
    vaultId,
    lpWalletAddress: commitment.lpWalletAddress,
    callAmount: req.callAmount,
    gracePeriodMs: req.gracePeriodMs,
    note: req.note,
    nowIso: nowIso(),
  });
  mockCalls.push(call);
  // Update commitment
  const newCalledAmount = commitment.calledAmount + req.callAmount;
  const idx = mockCommitments.indexOf(commitment);
  mockCommitments[idx] = {
    ...commitment,
    calledAmount: newCalledAmount,
    remainingCallable: computeRemainingCallable(commitment.committedAmount, newCalledAmount),
    state: computeRemainingCallable(commitment.committedAmount, newCalledAmount) <= 0 ? "FULLY_CALLED" : "ACTIVE",
  };
  emitEvent("CALL_ISSUED", commitmentId, call.id, operatorAddress, { callAmount: req.callAmount });
  return call;
}

async function mockFundCall(
  vaultId: string,
  callId: string,
  req: FundCallRequest,
  lpAddress: string,
): Promise<FundCallResult> {
  await new Promise(r => setTimeout(r, 600));
  const callIdx = mockCalls.findIndex(c => c.id === callId && c.vaultId === vaultId);
  if (callIdx === -1) throw new Error(`Call ${callId} not found.`);
  const commitmentIdx = mockCommitments.findIndex(c => c.id === mockCalls[callIdx].commitmentId);
  if (commitmentIdx === -1) throw new Error(`Commitment not found.`);

  const { updatedCall, updatedCommitment } = applyFunding({
    call: mockCalls[callIdx],
    commitment: mockCommitments[commitmentIdx],
    fundingAmount: req.fundingAmount,
    sharePrice: req.sharePrice,
    fundingEpoch: req.fundingEpoch,
    nowIso: nowIso(),
  });
  mockCalls[callIdx] = updatedCall;
  mockCommitments[commitmentIdx] = updatedCommitment;

  const eventType = updatedCall.state === "FUNDED" ? "CALL_FUNDED" : "CALL_PARTIALLY_FUNDED";
  emitEvent(eventType, updatedCall.commitmentId, callId, lpAddress, {
    fundedAmount: req.fundingAmount,
    sharesMinted: updatedCall.sharesMinted ?? 0,
  });
  if (updatedCommitment.state === "FULLY_CALLED") {
    emitEvent("COMMITMENT_FULLY_CALLED", updatedCommitment.id, null, lpAddress, {});
  }

  return { call: updatedCall, commitment: updatedCommitment, txId: `mock-tx-fund-${callId}-${Date.now()}` };
}

async function mockDefaultCall(
  vaultId: string,
  callId: string,
  operatorAddress: string,
): Promise<CapitalCall> {
  await new Promise(r => setTimeout(r, 300));
  const idx = mockCalls.findIndex(c => c.id === callId && c.vaultId === vaultId);
  if (idx === -1) throw new Error(`Call ${callId} not found.`);
  const call = mockCalls[idx];
  if (call.state !== "ISSUED" && call.state !== "PARTIALLY_FUNDED") {
    throw new Error(`Call cannot be defaulted from state ${call.state}.`);
  }
  const updated: CapitalCall = { ...call, state: "DEFAULTED" };
  mockCalls[idx] = updated;
  emitEvent("CALL_DEFAULTED", call.commitmentId, callId, operatorAddress, {
    unfundedAmount: call.callAmount - call.fundedAmount,
  });
  return updated;
}

async function mockWaiveCall(
  vaultId: string,
  callId: string,
  note: string,
  operatorAddress: string,
): Promise<CapitalCall> {
  await new Promise(r => setTimeout(r, 300));
  const idx = mockCalls.findIndex(c => c.id === callId && c.vaultId === vaultId);
  if (idx === -1) throw new Error(`Call ${callId} not found.`);
  const call = mockCalls[idx];
  if (call.state !== "ISSUED" && call.state !== "PARTIALLY_FUNDED" && call.state !== "DEFAULTED") {
    throw new Error(`Call cannot be waived from state ${call.state}.`);
  }
  const updated: CapitalCall = { ...call, state: "WAIVED", settledAt: nowIso(), note };
  mockCalls[idx] = updated;
  emitEvent("CALL_WAIVED", call.commitmentId, callId, operatorAddress, { note });
  return updated;
}

async function mockGetCallsForCommitment(
  vaultId: string,
  commitmentId: string,
): Promise<CapitalCall[]> {
  await new Promise(r => setTimeout(r, 200));
  return mockCalls.filter(c => c.commitmentId === commitmentId && c.vaultId === vaultId);
}

async function mockGetEvents(commitmentId: string): Promise<CommitmentEvent[]> {
  await new Promise(r => setTimeout(r, 200));
  return mockEvents.filter(e => e.commitmentId === commitmentId);
}

async function mockGetSummary(
  vaultId: string,
  commitmentId: string,
): Promise<CommitmentSummary> {
  await new Promise(r => setTimeout(r, 300));
  const commitment = mockCommitments.find(c => c.id === commitmentId && c.vaultId === vaultId);
  if (!commitment) throw new Error(`Commitment ${commitmentId} not found.`);
  const calls = await mockGetCallsForCommitment(vaultId, commitmentId);
  const events = await mockGetEvents(commitmentId);
  const openCalls = calls.filter(c => c.state === "ISSUED" || c.state === "PARTIALLY_FUNDED");
  return { commitment, openCalls, recentEvents: events.slice(-10).reverse() };
}

// ---------------------------------------------------------------------------
// Public adapter
// ---------------------------------------------------------------------------

/** Fetch commitments. Pass lpWalletAddress for LP view, omit for operator view. */
export async function getVaultCommitments(
  vaultId: string,
  opts: { lpWalletAddress?: string; allForOperator?: boolean; operatorAddress?: string },
  _token?: string | null,
): Promise<VaultCommitment[]> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") throw new Error("Live vault commitments API not yet implemented.");
  return mockGetCommitments(vaultId, opts);
}

/** Fetch all capital calls for a commitment. */
export async function getCapitalCalls(
  vaultId: string,
  commitmentId: string,
  _token?: string | null,
): Promise<CapitalCall[]> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") throw new Error("Live vault commitments API not yet implemented.");
  return mockGetCallsForCommitment(vaultId, commitmentId);
}

/** Fetch the full summary (commitment + open calls + events) for one commitment. */
export async function getCommitmentSummary(
  vaultId: string,
  commitmentId: string,
  _token?: string | null,
): Promise<CommitmentSummary> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") throw new Error("Live vault commitments API not yet implemented.");
  return mockGetSummary(vaultId, commitmentId);
}

/** Create a new commitment (operator action). */
export async function createCommitment(
  vaultId: string,
  req: CreateCommitmentRequest,
  operatorAddress: string,
  _token?: string | null,
): Promise<VaultCommitment> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") throw new Error("Live vault commitments API not yet implemented.");
  return mockCreateCommitment(vaultId, req, operatorAddress);
}

/** LP acknowledges (signs) their commitment. */
export async function acknowledgeCommitment(
  vaultId: string,
  commitmentId: string,
  lpAddress: string,
  _token?: string | null,
): Promise<VaultCommitment> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") throw new Error("Live vault commitments API not yet implemented.");
  return mockAcknowledgeCommitment(vaultId, commitmentId, lpAddress);
}

/** Operator issues a capital call against a commitment. */
export async function issueCapitalCall(
  vaultId: string,
  commitmentId: string,
  req: IssueCapitalCallRequest,
  operatorAddress: string,
  _token?: string | null,
): Promise<CapitalCall> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") throw new Error("Live vault commitments API not yet implemented.");
  return mockIssueCapitalCall(vaultId, commitmentId, req, operatorAddress);
}

/** LP funds a capital call (produces a vault deposit with attribution). */
export async function fundCapitalCall(
  vaultId: string,
  callId: string,
  req: FundCallRequest,
  lpAddress: string,
  _token?: string | null,
): Promise<FundCallResult> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") throw new Error("Live vault commitments API not yet implemented.");
  return mockFundCall(vaultId, callId, req, lpAddress);
}

/** Operator marks a call as defaulted. */
export async function defaultCapitalCall(
  vaultId: string,
  callId: string,
  operatorAddress: string,
  _token?: string | null,
): Promise<CapitalCall> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") throw new Error("Live vault commitments API not yet implemented.");
  return mockDefaultCall(vaultId, callId, operatorAddress);
}

/** Operator waives the unfunded remainder of a call. */
export async function waiveCapitalCall(
  vaultId: string,
  callId: string,
  note: string,
  operatorAddress: string,
  _token?: string | null,
): Promise<CapitalCall> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") throw new Error("Live vault commitments API not yet implemented.");
  return mockWaiveCall(vaultId, callId, note, operatorAddress);
}

/** Fetch event log for a commitment. */
export async function getCommitmentEvents(
  _vaultId: string,
  commitmentId: string,
  _token?: string | null,
): Promise<CommitmentEvent[]> {
  if (process.env.NEXT_PUBLIC_VAULTS === "live") throw new Error("Live vault commitments API not yet implemented.");
  return mockGetEvents(commitmentId);
}

/** Reset mock store (for tests only). */
export function _resetMockStore(): void {
  mockCommitments = [];
  mockCalls = [];
  mockEvents = [];
  _idCounter = 1;
}
