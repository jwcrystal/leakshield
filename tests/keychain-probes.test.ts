import { describe, expect, it } from "vitest";

const probes = (await import("../scripts/diagnostics/lib/keychain-probes.mjs")) as unknown as {
  makeRecordingProbe: (
    probe: { read: () => string | null; write: (hexKey: string) => void },
    options?: { allowCreate?: boolean },
  ) => {
    probe: { read: () => string | null; write: (hexKey: string) => void };
    state: {
      existedBefore: boolean | null;
      readFailed: boolean;
      refusedAbsence: boolean;
      writeAttempted: boolean;
      writeSucceeded: boolean;
      writeError: string | null;
    };
  };
  makeReadOnlyProbe: (probe: { read: () => string | null; write: (hexKey: string) => void }) => {
    read: () => string | null;
    write: (hexKey: string) => void;
  };
  keyCreationAttribution: (input: {
    existedBefore: boolean | null;
    writeAttempted: boolean;
    writeSucceeded: boolean;
  }) => boolean | null;
};

function fakeProbe(initial: string | null, options: { failWrite?: boolean; failRead?: boolean } = {}) {
  let value = initial;
  const calls = { reads: 0, writes: 0, written: [] as string[] };
  return {
    calls,
    probe: {
      read() {
        calls.reads += 1;
        if (options.failRead === true) throw new Error("keychain locked");
        return value;
      },
      write(hexKey: string) {
        calls.writes += 1;
        if (options.failWrite === true) throw new Error("write denied");
        calls.written.push(hexKey);
        value = hexKey;
      },
    },
  };
}

describe("makeRecordingProbe", () => {
  it("records an existing item and never writes", () => {
    const fake = fakeProbe("aa");
    const { probe, state } = probes.makeRecordingProbe(fake.probe, { allowCreate: false });
    expect(probe.read()).toBe("aa");
    expect(state.existedBefore).toBe(true);
    expect(state.writeAttempted).toBe(false);
    expect(fake.calls.writes).toBe(0);
  });

  it("refuses an absent item when creation was not allowed", () => {
    const fake = fakeProbe(null);
    const { probe, state } = probes.makeRecordingProbe(fake.probe, { allowCreate: false });
    expect(() => probe.read()).toThrow(/absent/);
    expect(state.refusedAbsence).toBe(true);
    expect(state.existedBefore).toBe(false);
    expect(fake.calls.writes).toBe(0);
  });

  it("lets creation through only when allowed, and records the write", () => {
    const fake = fakeProbe(null);
    const { probe, state } = probes.makeRecordingProbe(fake.probe, { allowCreate: true });
    expect(probe.read()).toBeNull();
    probe.write("bb");
    expect(state.existedBefore).toBe(false);
    expect(state.writeAttempted).toBe(true);
    expect(state.writeSucceeded).toBe(true);
    expect(fake.calls.written).toEqual(["bb"]);
  });

  it("records a failed write without claiming success", () => {
    const fake = fakeProbe(null, { failWrite: true });
    const { probe, state } = probes.makeRecordingProbe(fake.probe, { allowCreate: true });
    probe.read();
    expect(() => probe.write("bb")).toThrow(/denied/);
    expect(state.writeAttempted).toBe(true);
    expect(state.writeSucceeded).toBe(false);
    expect(state.writeError).toMatch(/denied/);
  });

  it("keeps the first read as the answer, even if the item appears later", () => {
    let value: string | null = null;
    const probe = {
      read: () => value,
      write: (hexKey: string) => {
        value = hexKey;
      },
    };
    const recording = probes.makeRecordingProbe(probe, { allowCreate: true });
    recording.probe.read();
    value = "cc";
    recording.probe.read();
    expect(recording.state.existedBefore).toBe(false);
  });

  it("records a failed read", () => {
    const fake = fakeProbe(null, { failRead: true });
    const { probe, state } = probes.makeRecordingProbe(fake.probe, { allowCreate: true });
    expect(() => probe.read()).toThrow(/locked/);
    expect(state.readFailed).toBe(true);
  });
});

describe("makeReadOnlyProbe", () => {
  it("passes reads through", () => {
    const fake = fakeProbe("dd");
    const probe = probes.makeReadOnlyProbe(fake.probe);
    expect(probe.read()).toBe("dd");
  });

  it("never writes, even when the ladder asks it to", () => {
    const fake = fakeProbe(null);
    const probe = probes.makeReadOnlyProbe(fake.probe);
    expect(() => probe.write("ee")).toThrow(/refusing/);
    expect(fake.calls.writes).toBe(0);
  });
});

describe("keyCreationAttribution", () => {
  it("is true only when our write succeeded", () => {
    expect(probes.keyCreationAttribution({ existedBefore: false, writeAttempted: true, writeSucceeded: true })).toBe(
      true,
    );
  });

  it("is false when the item existed and nothing was written", () => {
    expect(probes.keyCreationAttribution({ existedBefore: true, writeAttempted: false, writeSucceeded: false })).toBe(
      false,
    );
  });

  it("is null when the item appeared without our write", () => {
    expect(probes.keyCreationAttribution({ existedBefore: false, writeAttempted: false, writeSucceeded: false })).toBe(
      null,
    );
  });

  it("is null when a write was attempted and failed", () => {
    expect(probes.keyCreationAttribution({ existedBefore: false, writeAttempted: true, writeSucceeded: false })).toBe(
      null,
    );
  });

  it("is null when the first read failed", () => {
    expect(probes.keyCreationAttribution({ existedBefore: null, writeAttempted: false, writeSucceeded: false })).toBe(
      null,
    );
  });
});
