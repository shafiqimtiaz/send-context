import { SessionMessage } from "../adapters/types.js";

/**
 * The v2 wire format for encrypted handoff payloads.
 *
 * v1 (pre-0.2.0) was a bare Markdown string rendered by the old fixed-schema
 * formatter. v2 wraps the rendered Markdown in a JSON envelope with explicit
 * versioning, source metadata, and an optional raw-message appendix. v1
 * payloads are no longer accepted; receivers that encounter one return the
 * error from {@link decodePayload}, asking the sender to upgrade.
 */
export const PAYLOAD_VERSION = 2 as const;

export interface HandoffPayload {
  version: 2;
  source: {
    /** Display name of the source coding agent, e.g. "Pi", "Claude Code", "OpenCode". */
    agent: string;
    /** ISO 8601 timestamp of when the payload was assembled. */
    capturedAt: string;
  };
  /** The sender's rendered Markdown handoff brief (preamble + body + appendix). */
  markdown: string;
  /**
   * Optional raw-message appendix. Unused in the distill path (where the
   * rendered Markdown already includes a formatted appendix). Reserved for
   * future use as a safety-net tail of the original session.
   */
  appendix?: SessionMessage[];
}

export interface EncodePayloadInput {
  sourceAgent: string;
  timestamp: string;
  markdown: string;
  appendix?: SessionMessage[];
}

/**
 * Encode a handoff payload as a JSON string suitable for encryption.
 */
export function encodePayload(input: EncodePayloadInput): string {
  const payload: HandoffPayload = {
    version: PAYLOAD_VERSION,
    source: {
      agent: input.sourceAgent,
      capturedAt: input.timestamp,
    },
    markdown: input.markdown,
    ...(input.appendix && input.appendix.length > 0 ? { appendix: input.appendix } : {}),
  };
  return JSON.stringify(payload);
}

/**
 * Decode a JSON handoff payload, validating the version field. Throws a
 * user-facing error if the payload is v1 (older format) or v3+ (newer than
 * this build) so the receiver can surface a clear "ask the sender to upgrade"
 * message.
 */
export function decodePayload(json: string): HandoffPayload {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `Could not parse handoff payload as JSON: ${(err as Error).message}`,
    );
  }

  if (!obj || typeof obj !== "object") {
    throw new Error("Handoff payload is not a JSON object.");
  }

  const record = obj as Record<string, unknown>;
  const version = record.version;
  if (version === 1) {
    throw new Error(
      "This handoff link uses an older format (v1) that this build no longer accepts. " +
      "Ask the sender to upgrade ctx-handoff and re-send.",
    );
  }
  if (version !== PAYLOAD_VERSION) {
    throw new Error(
      `This handoff link uses payload version ${JSON.stringify(version)}, which is ` +
      `newer than this build of ctx-handoff supports (v${PAYLOAD_VERSION}). ` +
      "Ask the sender to downgrade or upgrade the receiver.",
    );
  }

  const source = record.source as Record<string, unknown> | undefined;
  if (!source || typeof source.agent !== "string" || typeof source.capturedAt !== "string") {
    throw new Error("Handoff payload is missing source metadata (agent, capturedAt).");
  }

  if (typeof record.markdown !== "string") {
    throw new Error("Handoff payload is missing the markdown field.");
  }

  return {
    version: PAYLOAD_VERSION,
    source: {
      agent: source.agent,
      capturedAt: source.capturedAt,
    },
    markdown: record.markdown,
    ...(Array.isArray(record.appendix)
      ? { appendix: record.appendix as SessionMessage[] }
      : {}),
  };
}
