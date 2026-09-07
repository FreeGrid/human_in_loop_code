import { canonicalHash } from "./authority.ts";

export type ReviewResult = "passed" | "failed" | "disputed" | "invalidated";
export type ReviewType = "deterministic" | "independent" | "human";

export interface ReviewReceipt {
  receipt_version: 1;
  node_id: string;
  contract_hash: string;
  review_type: ReviewType;
  result: ReviewResult;
  reviewer: string;
  summary: string;
  evidence_ref?: string;
  created_at: string;
  invalidated_reason?: string;
}

export function createReviewReceipt(input: Omit<ReviewReceipt, "receipt_version" | "result"> & { result?: ReviewResult }): ReviewReceipt {
  if (!input || typeof input !== "object" || Object.keys(input).some(k => !["node_id","contract_hash","review_type","result","reviewer","summary","evidence_ref","created_at","invalidated_reason"].includes(k))) throw new Error("Invalid Review receipt fields");
  if (!["deterministic","independent","human"].includes(input.review_type) || !["passed","failed","disputed","invalidated"].includes(input.result ?? "passed")) throw new Error("Invalid Review receipt type or result");
  if (input.result === "invalidated" && !input.invalidated_reason?.trim()) throw new Error("Invalidated Review needs a reason");
  if (!/^T\d{3}$/.test(input.node_id)) throw new Error("Review receipt node_id must use TNNN");
  if (!/^[a-f0-9]{64}$/.test(input.contract_hash)) throw new Error("Review receipt contract_hash must be SHA-256");
  if (!input.reviewer.trim() || !input.summary.trim()) throw new Error("Review receipt reviewer and summary are required");
  if (Number.isNaN(Date.parse(input.created_at))) throw new Error("Review receipt created_at must be an ISO date");
  return { receipt_version: 1, ...input, result: input.result ?? "passed", reviewer: input.reviewer.trim(), summary: input.summary.trim() };
}

export function invalidateReviewReceipt(receipt: ReviewReceipt, currentContractHash: string): ReviewReceipt {
  if (receipt.result === "invalidated" && receipt.invalidated_reason) return receipt;
  if (receipt.contract_hash === currentContractHash) return receipt;
  return { ...receipt, result: "invalidated", invalidated_reason: "contract_hash_changed" };
}

export function reviewReceiptHash(receipt: ReviewReceipt): string {
  return canonicalHash(receipt);
}
