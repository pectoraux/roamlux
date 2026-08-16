// Architecture Dependency Tests.
// These tests FAIL if forbidden imports are introduced. They enforce the
// architectural boundary invariants at the CI level.
//
// Rules:
//   protocol/**   must NOT import: prisma, next/*, adapters/*
//   kernel/**     must NOT import: adapters/mikrotik, adapters/esim, prisma
//   control-plane must NOT import: adapters/*, prisma, next/*
//   protocol/**   must NOT import: @/lib/db
import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const SRC = join(import.meta.dir, "..", "src");

function listFiles(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(full, ext));
    } else if (entry.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

function fileContent(path: string): string {
  return readFileSync(path, "utf-8");
}

function importLines(content: string): string[] {
  const lines: string[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("import ") && trimmed.includes(" from ")) {
      lines.push(trimmed);
    }
  }
  return lines;
}

describe("Protocol layer boundary", () => {
  const protocolDir = join(SRC, "domain", "protocol");
  const files = listFiles(protocolDir, ".ts");
  test("protocol directory has files", () => {
    expect(files.length).toBeGreaterThan(0);
  });
  for (const file of files) {
    const rel = relative(SRC, file);
    test(`${rel} has no forbidden imports`, () => {
      const content = fileContent(file);
      const imports = importLines(content);
      for (const imp of imports) {
        // Protocol must not import Prisma, Next.js, db, or adapters.
        expect(imp).not.toContain("@prisma/client");
        expect(imp).not.toContain("@/lib/db");
        expect(imp).not.toContain("next/");
        expect(imp).not.toContain("@/domain/adapters");
        // Protocol may only import from itself (relative ./) or foundational types.
        if (imp.includes("from \"@/")) {
          expect(imp).toContain("@/domain/protocol");
        }
      }
    });
  }
});

describe("Kernel layer boundary", () => {
  const kernelDir = join(SRC, "domain", "kernel");
  const files = listFiles(kernelDir, ".ts");
  for (const file of files) {
    const rel = relative(SRC, file);
    test(`${rel} has no forbidden imports`, () => {
      const content = fileContent(file);
      const imports = importLines(content);
      for (const imp of imports) {
        expect(imp).not.toContain("@prisma/client");
        expect(imp).not.toContain("@/lib/db");
        expect(imp).not.toContain("@/domain/adapters");
        expect(imp).not.toContain("next/");
        // Kernel may import from protocol only (and its own relative files).
        if (imp.includes("from \"@/")) {
          expect(imp).toContain("@/domain/protocol");
        }
      }
    });
  }
});

describe("Control plane boundary", () => {
  const cpDir = join(SRC, "domain", "control-plane");
  const files = listFiles(cpDir, ".ts");
  for (const file of files) {
    const rel = relative(SRC, file);
    test(`${rel} has no forbidden imports`, () => {
      const content = fileContent(file);
      const imports = importLines(content);
      for (const imp of imports) {
        expect(imp).not.toContain("@prisma/client");
        expect(imp).not.toContain("@/lib/db");
        expect(imp).not.toContain("@/domain/adapters");
        expect(imp).not.toContain("next/");
        if (imp.includes("from \"@/")) {
          expect(imp).toContain("@/domain/protocol");
        }
      }
    });
  }
});

describe("No provider code leaks into kernel/protocol", () => {
  test("protocol does not import provider SDKs or adapter implementations", () => {
    const files = listFiles(join(SRC, "domain", "protocol"), ".ts");
    for (const file of files) {
      const imports = importLines(fileContent(file));
      for (const imp of imports) {
        // Protocol must not import provider-specific adapter modules.
        expect(imp).not.toContain("adapters/mikrotik");
        expect(imp).not.toContain("adapters/esim");
        expect(imp).not.toContain("adapters/mock");
      }
    }
  });
  test("kernel does not import provider SDKs or adapter implementations", () => {
    const files = listFiles(join(SRC, "domain", "kernel"), ".ts");
    for (const file of files) {
      const imports = importLines(fileContent(file));
      for (const imp of imports) {
        expect(imp).not.toContain("adapters/mikrotik");
        expect(imp).not.toContain("adapters/esim");
        expect(imp).not.toContain("adapters/mock");
      }
    }
  });
});
