import { describe, it, expect } from "vitest";
import { toMcpDecisionPayload } from "../src/transports/mcp-payload.js";
import type { ScanResult, Finding, GuardConfig } from "../src/types.js";
import type { McpDecisionPayload } from "../src/transports/mcp-payload.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function safeScan(): ScanResult {
  return {
    safe: true,
    total_findings: 0,
    findings: [],
    summary: "✅ No sensitive content detected.",
    recommendation: "Content is safe to send.",
  };
}

function scanWith(findings: Finding[]): ScanResult {
  return {
    safe: findings.length === 0,
    total_findings: findings.length,
    findings,
    summary:
      findings.length > 0
        ? `🚨 ${findings.length} sensitive items found.`
        : "✅ No sensitive content detected.",
    recommendation:
      findings.length > 0
        ? "Review before sending."
        : "Content is safe to send.",
  };
}

const HIGH: Finding = {
  type: "API_KEY",
  severity: "HIGH",
  line: 1,
  column: 1,
  preview: "****",
  description: "OpenAI API Key",
  match_start: 10,
  match_end: 50,
  match_text: "sk-proj-real-secret-key-value",
};

const MEDIUM: Finding = {
  type: "PII_EMAIL",
  severity: "MEDIUM",
  line: 2,
  column: 1,
  preview: "****",
  description: "Email address",
  match_start: 60,
  match_end: 80,
  match_text: "user@example.com",
};

const LOW: Finding = {
  type: "PRIVATE_DOMAIN",
  severity: "LOW",
  line: 3,
  column: 1,
  preview: "****",
  description: "Private domain reference",
};

// ─── safe scan → ALLOW ─────────────────────────────────────────────────────

describe("toMcpDecisionPayload() — safe scan", () => {
  it("returns decision=ALLOW and riskLevel=LOW for a clean scan", () => {
    const payload = toMcpDecisionPayload(safeScan(), "hello world");
    expect(payload.decision).toBe("ALLOW");
    expect(payload.riskLevel).toBe("LOW");
  });

  it("sets safe=true for ALLOW decision", () => {
    const payload = toMcpDecisionPayload(safeScan(), "hello world");
    expect(payload.safe).toBe(true);
  });

  it("preserves total_findings and summary from scan result", () => {
    const payload = toMcpDecisionPayload(safeScan(), "hello world");
    expect(payload.total_findings).toBe(0);
    expect(payload.summary).toContain("No sensitive content");
  });

  it("returns empty findings array for safe scan", () => {
    const payload = toMcpDecisionPayload(safeScan(), "hello world");
    expect(payload.findings).toEqual([]);
  });

  it("does not include recommendedAction for ALLOW", () => {
    const payload = toMcpDecisionPayload(safeScan(), "hello world");
    expect(payload.recommendedAction).toBeUndefined();
  });

  it("does not include safePreview for ALLOW", () => {
    const payload = toMcpDecisionPayload(safeScan(), "hello world");
    expect(payload.safePreview).toBeUndefined();
  });
});

// ─── low-only findings → WARN ──────────────────────────────────────────────

describe("toMcpDecisionPayload() — low-only findings", () => {
  it("returns decision=WARN and riskLevel=MEDIUM", () => {
    const payload = toMcpDecisionPayload(scanWith([LOW]), "some text");
    expect(payload.decision).toBe("WARN");
    expect(payload.riskLevel).toBe("MEDIUM");
  });

  it("sets safe=false for non-ALLOW decisions", () => {
    const payload = toMcpDecisionPayload(scanWith([LOW]), "some text");
    expect(payload.safe).toBe(false);
  });
});

// ─── medium findings → CONFIRM ─────────────────────────────────────────────

describe("toMcpDecisionPayload() — medium findings", () => {
  it("returns decision=CONFIRM with recommendedAction=REVIEW", () => {
    const payload = toMcpDecisionPayload(scanWith([MEDIUM]), "some text");
    expect(payload.decision).toBe("CONFIRM");
    expect(payload.riskLevel).toBe("HIGH");
    expect(payload.recommendedAction).toBe("REVIEW");
  });

  it("sets safe=false", () => {
    const payload = toMcpDecisionPayload(scanWith([MEDIUM]), "some text");
    expect(payload.safe).toBe(false);
  });
});

// ─── high findings → CONFIRM/BLOCK ─────────────────────────────────────────

describe("toMcpDecisionPayload() — high findings", () => {
  it("returns decision=CONFIRM with recommendedAction=BLOCK", () => {
    const payload = toMcpDecisionPayload(scanWith([HIGH]), "some text");
    expect(payload.decision).toBe("CONFIRM");
    expect(payload.riskLevel).toBe("CRITICAL");
    expect(payload.recommendedAction).toBe("BLOCK");
  });

  it("sets safe=false", () => {
    const payload = toMcpDecisionPayload(scanWith([HIGH]), "some text");
    expect(payload.safe).toBe(false);
  });
});

// ─── Finding sanitization ──────────────────────────────────────────────────

describe("toMcpDecisionPayload() — finding sanitization", () => {
  it("strips internal match metadata from findings", () => {
    const payload = toMcpDecisionPayload(scanWith([HIGH]), "some text");
    expect(payload.findings).toHaveLength(1);
    const f = payload.findings[0]!;
    expect(f).not.toHaveProperty("match_start");
    expect(f).not.toHaveProperty("match_end");
    expect(f).not.toHaveProperty("match_text");
  });

  it("retains safe finding fields: type, severity, description, preview", () => {
    const payload = toMcpDecisionPayload(scanWith([HIGH]), "some text");
    const f = payload.findings[0]!;
    expect(f.type).toBe("API_KEY");
    expect(f.severity).toBe("HIGH");
    expect(f.description).toBe("OpenAI API Key");
    expect(f.preview).toBe("****");
  });

  it("strips internal metadata from all findings", () => {
    const payload = toMcpDecisionPayload(
      scanWith([HIGH, MEDIUM]),
      "some text",
    );
    for (const f of payload.findings) {
      expect(f).not.toHaveProperty("match_start");
      expect(f).not.toHaveProperty("match_end");
      expect(f).not.toHaveProperty("match_text");
    }
  });
});

// ─── originalContent never leaks ───────────────────────────────────────────

describe("toMcpDecisionPayload() — no content leakage", () => {
  it("never includes originalContent in the payload", () => {
    const payload = toMcpDecisionPayload(
      scanWith([HIGH]),
      "sk-proj-real-secret-key-value",
    );
    expect(payload).not.toHaveProperty("originalContent");
    // Also ensure the secret is not embedded anywhere
    const json = JSON.stringify(payload);
    expect(json).not.toContain("sk-proj-real-secret-key-value");
    expect(json).not.toContain("user@example.com");
  });
});

// ─── Metadata (label, file) ────────────────────────────────────────────────

describe("toMcpDecisionPayload() — metadata", () => {
  it("includes label when provided", () => {
    const payload = toMcpDecisionPayload(safeScan(), "hello", undefined, {
      label: "config.ts",
    });
    expect(payload.label).toBe("config.ts");
  });

  it("omits label when not provided", () => {
    const payload = toMcpDecisionPayload(safeScan(), "hello");
    expect(payload.label).toBeUndefined();
  });

  it("includes file when provided", () => {
    const payload = toMcpDecisionPayload(safeScan(), "hello", undefined, {
      file: "/repo/src/config.ts",
    });
    expect(payload.file).toBe("/repo/src/config.ts");
  });

  it("omits file when not provided", () => {
    const payload = toMcpDecisionPayload(safeScan(), "hello");
    expect(payload.file).toBeUndefined();
  });

  it("includes both label and file when provided", () => {
    const payload = toMcpDecisionPayload(
      safeScan(),
      "hello",
      undefined,
      { label: "config.ts", file: "/repo/src/config.ts" },
    );
    expect(payload.label).toBe("config.ts");
    expect(payload.file).toBe("/repo/src/config.ts");
  });
});

// ─── safePreview for CONFIRM decisions ─────────────────────────────────────

describe("toMcpDecisionPayload() — safePreview", () => {
  it("includes safePreview when findings have match metadata", () => {
    const content = "const apiKey = sk-proj-real-secret-key-value;";
    const payload = toMcpDecisionPayload(scanWith([HIGH]), content);
    expect(payload.safePreview).toBeDefined();
    // The safe preview should contain a placeholder, not the raw secret
    expect(payload.safePreview).toContain("[REDACTED_API_KEY]");
    expect(payload.safePreview).not.toContain("sk-proj-real-secret-key-value");
  });

  it("omits safePreview when findings lack match metadata", () => {
    const payload = toMcpDecisionPayload(scanWith([LOW]), "some text");
    // LOW finding has no match_start/match_end/match_text
    expect(payload.safePreview).toBeUndefined();
  });
});

// ─── Type shape validation ─────────────────────────────────────────────────

describe("toMcpDecisionPayload() — type shape", () => {
  it("conforms to McpDecisionPayload interface", () => {
    const payload = toMcpDecisionPayload(safeScan(), "hello", undefined, {
      label: "test",
    });
    const _typeCheck: McpDecisionPayload = payload;
    void _typeCheck;
    // If we reach here, the type check passed
    expect(true).toBe(true);
  });
});

// ─── redactedContent exclusion ───────────────────────────────────────────

describe("toMcpDecisionPayload() — redactedContent exclusion", () => {
  it("never includes redactedContent in MCP payload, even for CONFIRM/BLOCK", () => {
    const content = "const apiKey = sk-proj-real-secret-key-value;";
    const payload = toMcpDecisionPayload(scanWith([HIGH]), content);
    expect(payload.decision).toBe("CONFIRM");
    expect(payload.recommendedAction).toBe("BLOCK");
    // redactedContent must not be present — MCP consumers should call redact_text instead
    expect(payload).not.toHaveProperty("redactedContent");
  });

  it("never includes redactedContent for CONFIRM/REVIEW either", () => {
    const content = "contact: user@example.com";
    const payload = toMcpDecisionPayload(scanWith([MEDIUM]), content);
    expect(payload.decision).toBe("CONFIRM");
    expect(payload.recommendedAction).toBe("REVIEW");
    expect(payload).not.toHaveProperty("redactedContent");
  });

  it("does not include redactedContent for WARN or ALLOW", () => {
    const payloadWarn = toMcpDecisionPayload(scanWith([LOW]), "some text");
    expect(payloadWarn).not.toHaveProperty("redactedContent");

    const payloadAllow = toMcpDecisionPayload(safeScan(), "hello");
    expect(payloadAllow).not.toHaveProperty("redactedContent");
  });
});
