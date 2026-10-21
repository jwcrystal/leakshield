/**
 * Git remote vs. mailbox classification (issue #34).
 *
 * An SSH remote (`user@host:path`, `ssh://user@host/…`) is byte-for-byte an
 * email address followed by a colon and a path. The email rule used to report
 * that span as PII, which pseudonymized a public host for no privacy gain and
 * mislabelled the credential half of `scheme://user:password@host`.
 *
 * These tests pin both directions: transport syntax stops producing PII_EMAIL,
 * and ordinary addresses — including ones followed by a colon, a port, or a
 * non-SSH scheme — keep doing so. Private hosts and path keywords are checked
 * in the same fixture so the exemption cannot quietly swallow them. Ambiguous
 * shapes stay on the reporting side, and the token-level cases (nested URLs,
 * long usernames, `@` inside a password) are the ones a suffix-only check got
 * wrong.
 *
 * Every address here is synthetic and uses the reserved `example.com` /
 * `example` names.
 */

import { describe, expect, it } from "vitest";
import { redactText, scanText } from "../src/scanner/engine.js";
import { classifyTransportSpan } from "../src/scanner/remotes.js";
import type { GuardConfig, FindingType } from "../src/types.js";

const config: GuardConfig = {
  nda_keywords: ["project-hermes"],
  private_domains: ["internal.corp"],
  custom_rules: [],
  settings: { max_chars: 200000, show_line_numbers: true, preview_length: 60 },
};

const ADDRESS = "alice@example.com";
const HOST = "git.example.com";

function types(text: string): FindingType[] {
  return scanText(text, config).findings.map((finding) => finding.type);
}

describe("email rule — SSH transport syntax", () => {
  it.each([
    ["scp-like", `git@${HOST}:team/repo.git`],
    ["scp-like in git remote -v", `origin\tgit@${HOST}:team/repo.git (fetch)`],
    ["ssh scheme", `ssh://git@${HOST}/team/repo.git`],
    ["ssh scheme without a path", `origin\tssh://git@${HOST} (fetch)`],
    ["ssh scheme with a port", `ssh://git@${HOST}:2222/team/repo.git`],
    ["git+ssh scheme", `git+ssh://git@${HOST}/team/repo.git`],
  ])("does not report a public remote host as PII_EMAIL (%s)", (_label, remote) => {
    const findings = scanText(remote, config).findings;
    expect(findings.some((finding) => finding.type === "PII_EMAIL")).toBe(false);
  });

  it("still applies private_domains inside a remote", () => {
    const findings = scanText("dev@git.internal.corp:team/repo.git", config).findings;
    expect(findings.some((finding) => finding.type === "PRIVATE_DOMAIN")).toBe(true);
    expect(findings.some((finding) => finding.type === "PII_EMAIL")).toBe(false);
  });

  it("still applies keyword rules to the repository path", () => {
    const findings = scanText(`git@${HOST}:clients/project-hermes.git`, config).findings;
    expect(findings.some((finding) => finding.type === "NDA_KEYWORD")).toBe(true);
    expect(findings.some((finding) => finding.type === "PII_EMAIL")).toBe(false);
  });

  it("does not extend an SSH authority past its closing bracket", () => {
    // The `)` closes the URL; the address after it belongs to prose and must
    // still be reported.
    const text = `(ssh://git@${HOST}),${ADDRESS}`;
    const emails = scanText(text, config).findings.filter((finding) => finding.type === "PII_EMAIL");
    expect(emails).toHaveLength(1);
  });

  it("does not read a host-only SSH URL and the next address as userinfo", () => {
    const text = `ssh://${HOST}",${ADDRESS}`;
    const emails = scanText(text, config).findings.filter((finding) => finding.type === "PII_EMAIL");
    expect(emails).toHaveLength(1);
  });

  it("stops at the comma that separates CSV fields", () => {
    const text = `ssh://git@${HOST},${ADDRESS}`;
    const emails = scanText(text, config).findings.filter((finding) => finding.type === "PII_EMAIL");
    expect(emails).toHaveLength(1);
  });

  it("stops at a non-ASCII separator", () => {
    const text = `ssh://git@${HOST}—${ADDRESS}`;
    const emails = scanText(text, config).findings.filter((finding) => finding.type === "PII_EMAIL");
    expect(emails).toHaveLength(1);
  });
});

describe("email rule — ordinary addresses", () => {
  it.each([
    ["bare address", ADDRESS],
    ["followed by a colon and a space", `${ADDRESS}: please review`],
    ["followed by a port", `${ADDRESS}:8080`],
    ["followed by a port and a closing bracket", `see (${ADDRESS}:8080)`],
    ["followed by a port at end of line", `${ADDRESS}:8080\nnext`],
    ["inside mailto", `mailto:${ADDRESS}`],
    ["inside an https URL without a password", `https://${ADDRESS}/profile`],
    ["inside the path of an unrelated URL", `https://public.example/contacts/${ADDRESS}:notes`],
    ["inside a parenthesised path", `https://public.example/contacts/(${ADDRESS}:notes)`],
    ["after a nested scheme", `https://ssh://${ADDRESS}/`],
    ["after a parenthesised nested scheme", `https://public.example/(ssh://${ADDRESS}/)`],
    ["in a run whose start is beyond the lookback", `https://public.example/${"x".repeat(520)}(${ADDRESS}:notes)`],
    ["after an invalid scheme prefix", `123ssh://${ADDRESS}/repo`],
  ])("keeps reporting %s", (_label, text) => {
    expect(types(text)).toContain("PII_EMAIL");
  });

  it("does not let an authority cross whitespace into the next run", () => {
    const text = `https://${ADDRESS} note:words@${HOST}`;
    const emails = scanText(text, config).findings.filter((finding) => finding.type === "PII_EMAIL");
    expect(emails).toHaveLength(2);
  });
});

describe("URL credentials", () => {
  it("reports the userinfo as a SECRET, not as an email", () => {
    const url = `https://deploy:s3cr3t-passphrase@${HOST}/team/repo.git`;
    const findings = scanText(url, config).findings;
    expect(findings.map((finding) => finding.type)).toEqual(["SECRET"]);
    expect(findings[0].severity).toBe("HIGH");
  });

  it("redacts the credential but leaves the scheme and host readable", () => {
    const url = `https://deploy:s3cr3t-passphrase@${HOST}/team/repo.git`;
    const redacted = redactText(url, config).redacted;
    expect(redacted).not.toContain("s3cr3t-passphrase");
    expect(redacted).toContain("https://");
    expect(redacted).toContain("git.example.com/team/repo.git");
  });

  it("covers a password that itself contains @", () => {
    const url = `https://deploy:pa@ssword@${HOST}/team/repo.git`;
    const findings = scanText(url, config).findings;
    expect(findings.map((finding) => finding.type)).toEqual(["SECRET"]);
    // The span must cover the whole userinfo; stopping at the first @ leaves
    // the password tail (`ssword`) outside the mask.
    expect(findings[0].match_text).toBe("deploy:pa@ssword@");
    expect(redactText(url, config).redacted).toBe(
      `https://[REDACTED_SECRET]${HOST}/team/repo.git`,
    );
  });

  it.each([
    ["parenthesised", "user:pa(ss)@"],
    ["quoted", "user:pa'ss@"],
  ])("covers a %s password without splitting the span", (_label, span) => {
    const url = `https://${span}${HOST}/repo`;
    const findings = scanText(url, config).findings;
    expect(findings.map((finding) => finding.type)).toEqual(["SECRET"]);
    expect(findings[0].match_text).toBe(span);
    expect(redactText(url, config).redacted).toBe(`https://[REDACTED_SECRET]${HOST}/repo`);
  });

  it("covers an empty username", () => {
    const url = `https://:shortpass@${HOST}/team/repo.git`;
    expect(types(url)).toEqual(["SECRET"]);
    expect(redactText(url, config).redacted).not.toContain("shortpass");
  });

  it("does not depend on a fixed lookback window", () => {
    const username = "a".repeat(70);
    const url = `https://${username}:longpass@${HOST}/team/repo.git`;
    const findings = scanText(url, config).findings;
    expect(findings.map((finding) => finding.type)).toEqual(["SECRET"]);
    expect(redactText(url, config).redacted).toContain("git.example.com");
  });

  it("treats a password in an ssh:// URL as a credential too", () => {
    const url = `ssh://deploy:s3cr3t-passphrase@${HOST}/team/repo.git`;
    expect(types(url)).toEqual(["SECRET"]);
  });

  it.each([
    ["a JSON field", `{"url":"https://deploy:s3cr3t-passphrase@${HOST}/repo"}`],
    ["an assignment", `url=https://deploy:s3cr3t-passphrase@${HOST}/repo`],
  ])("recognises a wrapped credential and leaves no email finding (%s)", (_label, text) => {
    const findings = scanText(text, config).findings;
    expect(findings.map((finding) => finding.type)).toEqual(["SECRET"]);
    expect(redactText(text, config).redacted).toContain("git.example.com");
  });

  it("does not backtrack quadratically on a colon run without @", () => {
    // A missing closing `@` once made the two wildcard groups repartition
    // every colon: 64k colons took ~1.8s and blocked the synchronous scanner.
    const text = `https://${":".repeat(128000)}localhost`;
    const started = Date.now();
    expect(types(text)).not.toContain("SECRET");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("keeps an SSH password with punctuation in the credential span", () => {
    const url = `ssh://deploy:pa'ss@${HOST}/repo`;
    const findings = scanText(url, config).findings;
    expect(findings.map((finding) => finding.type)).toEqual(["SECRET"]);
    expect(redactText(url, config).redacted).toContain("git.example.com");
  });

  it("does not rescan the whole run for every candidate", () => {
    const text = `https://public.example/contacts/${`${ADDRESS},`.repeat(5000)}`;
    const started = Date.now();
    for (const match of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
      classifyTransportSpan(text, match.index ?? 0, match[0].length);
    }
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("scans a very long token with no @ in linear time", () => {
    const text = `ssh://${"a".repeat(199000)}:${ADDRESS}`;
    const started = Date.now();
    scanText(text, config);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
