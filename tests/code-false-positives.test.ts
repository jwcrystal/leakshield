import { describe, it, expect } from "vitest";
import { scanText } from "../src/scanner/engine.js";
import { createPseudonymizer } from "../src/decision/pseudonymization.js";
import type { GuardConfig } from "../src/types.js";

// Issue #49: built-in rules flagged ordinary source code as secrets.

const config: GuardConfig = {
  nda_keywords: [],
  private_domains: [],
  custom_rules: [],
  settings: { max_chars: 200000, show_line_numbers: false, preview_length: 60 },
};

const types = (text: string) => scanText(text, config).findings.map((f) => f.type);

describe("generic-secret — code expressions are not secrets", () => {
  it.each([
    "const password = process.env.DB_PASSWORD;",
    "const secret = import.meta.env.VITE_SECRET;",
    'secret = os.environ["DB_SECRET"]',
    'password = os.getenv("DB_PASSWORD")',
    "client_secret: config.clientSecret",
    "secret: settings.SECRET_KEY,",
    "this.password = this.options.password;",
    "password: z.string(),",
    "password: z.string().min(6),",
    "password = getPassword();",
  ])("does not flag %s", (text) => {
    expect(types(text)).not.toContain("SECRET");
  });

  it.each([
    'password: "changeme123"',
    "PASSWORD=hunter2.prod",
    "password=Tr0ub4dor&3xYz",
    "secret: abc.def.ghi.jkl",
    'password: bcrypt.hashSync("MyRealPass1")',
    'password = decrypt("hunter2hunter2")',
    // A code-shaped prefix must not hide a literal glued after it.
    "password=process.env.X;secret=realvalue123",
    // Template literals and keyword arguments are literals, not references.
    "password = bcrypt.hashSync(`MyRealPass1`)",
    "password = hash(pw=MyRealPass1)",
  ])("still flags %s", (text) => {
    expect(types(text)).toContain("SECRET");
  });
});

describe("credit-card — repeated digits and UUIDs are not cards", () => {
  it.each([
    'id = "00000000-0000-0000-0000-000000000000"',
    "uuid 12345678-1234-1234-1234-123456789012",
    "0000000000000000",
    "0000 0000 0000 0000",
  ])("does not flag %s", (text) => {
    expect(types(text)).not.toContain("PII_CREDIT_CARD");
  });

  it("still flags a Luhn-valid card", () => {
    expect(types("card 4111 1111 1111 1111")).toContain("PII_CREDIT_CARD");
    expect(types("card 4111-1111-1111-1111")).toContain("PII_CREDIT_CARD");
  });
});

describe("url-userinfo / db-connection — template placeholders are not credentials", () => {
  it.each([
    "mongodb://${string}:${string}@${string}:${number}",
    "mongodb://admin:${DB_PASS}@db.example.com/app",
    "postgres://<user>:<password>@localhost/db",
    "https://{{user}}:{{pass}}@example.com",
    "postgres://app:${cfg.db.password}@localhost/db",
    "https://{{ user }}:{{ pass }}@example.com",
  ])("does not flag %s", (text) => {
    const found = types(text);
    expect(found).not.toContain("SECRET");
    expect(found).not.toContain("DB_CONNECTION");
  });

  it.each([
    ["mongodb://admin:S3cr3tPass@db.example.com", "DB_CONNECTION"],
    ["https://u:realpass@host.com", "SECRET"],
    ["mongodb://u:${x}tail@h.example.com", "DB_CONNECTION"],
    ['mongodb://admin:${"S3cr3tPass"}@db.example.com/app', "DB_CONNECTION"],
    ["https://admin:${'S3cr3tPass'}@example.com", "SECRET"],
  ])("still flags %s", (text, type) => {
    expect(types(text)).toContain(type);
  });

  it("no longer refuses a template-literal type in transparent mode", () => {
    const created = createPseudonymizer({ ...config, settings: { ...config.settings, encoding_detection: true } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const text = "type Url = `mongodb://${string}:${string}@${string}:${number}/${string}`;";
    expect(created.protectText("s", text)).toEqual({ ok: true, text });
  });
});
