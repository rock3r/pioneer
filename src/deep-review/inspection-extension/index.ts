/**
 * Pioneer deep-review bundled inspection extension.
 * Loaded explicitly via `pi --extension` with discovery disabled.
 */

import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { Type } from "typebox";
import { resolveSourceDirectoryPath, resolveSourceFilePath } from "../source-access.js";

const MAX_TOOL_RESPONSE_BYTES = 64 * 1024;
const MAX_TOOL_CALLS = 200;
const MAX_CANDIDATE_READ_BYTES = 16 * 1024;
const MAX_SOURCE_FILE_READ_BYTES = 256 * 1024;

let toolCallCount = 0;

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function boundedText(text: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return text;
  return `${text.slice(0, maxBytes)}…[truncated]`;
}

function loadJson(pathValue: string): unknown {
  const raw = readFileSync(pathValue, "utf8");
  if (Buffer.byteLength(raw, "utf8") > 8 * 1024 * 1024) {
    throw new Error("Store file exceeds limit");
  }
  return JSON.parse(raw);
}

function readBoundedSourceText(absolute: string, maxBytes: number): string {
  const fd = openSync(absolute, "r");
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      throw new Error("Source path is not a regular file");
    }
    const bytesToRead = Math.min(stats.size, maxBytes);
    const buffer = Buffer.alloc(bytesToRead);
    let offset = 0;
    while (offset < bytesToRead) {
      const bytesRead = readSync(fd, buffer, offset, bytesToRead - offset, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

const MAX_SOURCE_FILE_SCAN_BYTES = 4 * 1024 * 1024;

function readSourceFileLines(absolute: string, startLine: number, lineLimit: number): string[] {
  const fd = openSync(absolute, "r");
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      throw new Error("Source path is not a regular file");
    }
    if (stats.size <= MAX_SOURCE_FILE_READ_BYTES && startLine === 1) {
      return readBoundedSourceText(absolute, MAX_SOURCE_FILE_READ_BYTES)
        .split("\n")
        .slice(startLine - 1, startLine - 1 + lineLimit);
    }

    let lineNumber = 0;
    let bytesScanned = 0;
    const lines: string[] = [];
    let carry = "";
    const chunkSize = 64 * 1024;

    while (bytesScanned < stats.size && lines.length < lineLimit) {
      const toRead = Math.min(chunkSize, stats.size - bytesScanned);
      const buffer = Buffer.alloc(toRead);
      const read = readSync(fd, buffer, 0, toRead, bytesScanned);
      if (read <= 0) break;
      bytesScanned += read;
      carry += buffer.subarray(0, read).toString("utf8");

      while (lines.length < lineLimit) {
        const newline = carry.indexOf("\n");
        if (newline === -1) {
          if (bytesScanned >= stats.size) {
            lineNumber += 1;
            if (lineNumber >= startLine) lines.push(carry);
            carry = "";
          }
          break;
        }
        const line = carry.slice(0, newline);
        carry = carry.slice(newline + 1);
        lineNumber += 1;
        if (lineNumber >= startLine) lines.push(line);
      }

      if (lineNumber < startLine - 1 && bytesScanned > MAX_SOURCE_FILE_SCAN_BYTES) {
        throw new Error("Source read exceeded scan budget");
      }
    }

    return lines;
  } finally {
    closeSync(fd);
  }
}

function assertToolBudget(): void {
  toolCallCount += 1;
  if (toolCallCount > MAX_TOOL_CALLS) {
    throw new Error("Inspection tool call limit exceeded");
  }
}

function textResult(text: string): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, never>;
} {
  return {
    content: [{ type: "text", text: boundedText(text, MAX_TOOL_RESPONSE_BYTES) }],
    details: {},
  };
}

export default function registerDeepReviewInspection(pi: {
  registerTool: (definition: unknown) => void;
}): void {
  const packetPath = env("PIONEER_DEEP_REVIEW_PACKET_PATH");
  const sourceRoot = env("PIONEER_DEEP_REVIEW_SOURCE_DIR");
  const candidateStorePath = process.env.PIONEER_DEEP_REVIEW_CANDIDATE_STORE;

  pi.registerTool({
    name: "get_pr_metadata",
    label: "PR metadata",
    description: "Return bounded PR metadata from the controller packet",
    parameters: Type.Object({}),
    async execute() {
      assertToolBudget();
      const packet = loadJson(packetPath) as Record<string, unknown>;
      const pullRequest = packet.pullRequest as Record<string, unknown>;
      const repository = packet.repository as Record<string, unknown>;
      return textResult(
        JSON.stringify({
          repository,
          pullRequest: {
            number: pullRequest.number,
            title: pullRequest.title,
            baseRef: pullRequest.baseRef,
            baseSha: pullRequest.baseSha,
            headSha: pullRequest.headSha,
          },
          packetDigest: packet.packetDigest,
          commitCount: Array.isArray(packet.commits) ? packet.commits.length : 0,
          fileCount: Array.isArray(packet.files) ? packet.files.length : 0,
        }),
      );
    },
  });

  pi.registerTool({
    name: "list_changed_files",
    label: "Changed files",
    description: "List changed files from the controller packet",
    parameters: Type.Object({}),
    async execute() {
      assertToolBudget();
      const packet = loadJson(packetPath) as Record<string, unknown>;
      const files = Array.isArray(packet.files) ? packet.files : [];
      return textResult(
        JSON.stringify(
          files.map((file) => {
            const record = file as Record<string, unknown>;
            return {
              path: record.path,
              previousPath: record.previousPath,
              status: record.status,
              contentKind: record.contentKind,
              additions: record.additions,
              deletions: record.deletions,
            };
          }),
        ),
      );
    },
  });

  pi.registerTool({
    name: "read_patch",
    label: "Read patch",
    description: "Read a bounded patch for one changed file",
    parameters: Type.Object({
      path: Type.String({ description: "Repository-relative file path" }),
    }),
    async execute(_id: string, params: { path: string }) {
      assertToolBudget();
      const packet = loadJson(packetPath) as Record<string, unknown>;
      const files = Array.isArray(packet.files) ? packet.files : [];
      const match = files.find((file) => (file as Record<string, unknown>).path === params.path);
      if (!match) throw new Error("Unknown file path");
      const record = match as Record<string, unknown>;
      return textResult(
        JSON.stringify({
          path: record.path,
          patch: record.patch ?? null,
          patchOmittedReason: record.patchOmittedReason ?? null,
        }),
      );
    },
  });

  pi.registerTool({
    name: "read_rule",
    label: "Read rule",
    description: "Read one repository rule from the packet",
    parameters: Type.Object({
      path: Type.String({ description: "Rule path" }),
    }),
    async execute(_id: string, params: { path: string }) {
      assertToolBudget();
      const packet = loadJson(packetPath) as Record<string, unknown>;
      const rules = Array.isArray(packet.rules) ? packet.rules : [];
      const match = rules.find((rule) => (rule as Record<string, unknown>).path === params.path);
      if (!match) throw new Error("Unknown rule path");
      return textResult(JSON.stringify(match));
    },
  });

  pi.registerTool({
    name: "read_previous_finding",
    label: "Previous finding",
    description: "Read one previous finding by comment ID",
    parameters: Type.Object({
      commentId: Type.String({ description: "Previous comment ID" }),
    }),
    async execute(_id: string, params: { commentId: string }) {
      assertToolBudget();
      const packet = loadJson(packetPath) as Record<string, unknown>;
      const findings = Array.isArray(packet.previousFindings) ? packet.previousFindings : [];
      const match = findings.find(
        (finding) => (finding as Record<string, unknown>).commentId === params.commentId,
      );
      if (!match) throw new Error("Unknown previous finding");
      return textResult(JSON.stringify(match));
    },
  });

  pi.registerTool({
    name: "read_source_file",
    label: "Read source",
    description: "Read a bounded portion of a repository source file",
    parameters: Type.Object({
      path: Type.String({ description: "Repository-relative path" }),
      offset: Type.Optional(Type.Number({ description: "1-based start line", minimum: 1 })),
      limit: Type.Optional(Type.Number({ description: "Maximum lines", minimum: 1, maximum: 500 })),
    }),
    async execute(_id: string, params: { path: string; offset?: number; limit?: number }) {
      assertToolBudget();
      const absolute = resolveSourceFilePath(sourceRoot, params.path);
      const offset = params.offset ?? 1;
      const limit = Math.min(params.limit ?? 200, 500);
      const slice = readSourceFileLines(absolute, offset, limit);
      return textResult(JSON.stringify({ path: params.path, offset, limit, lines: slice }));
    },
  });

  pi.registerTool({
    name: "list_source_directory",
    label: "List source directory",
    description: "List one repository-relative directory",
    parameters: Type.Object({
      path: Type.String({ description: "Repository-relative directory path" }),
    }),
    async execute(_id: string, params: { path: string }) {
      assertToolBudget();
      const absolute = resolveSourceDirectoryPath(sourceRoot, params.path || ".");
      const entries = readdirSync(absolute).slice(0, 500);
      return textResult(JSON.stringify({ path: params.path || ".", entries }));
    },
  });

  if (candidateStorePath) {
    pi.registerTool({
      name: "list_candidates",
      label: "List candidates",
      description: "List candidate IDs available to the president",
      parameters: Type.Object({}),
      async execute() {
        assertToolBudget();
        const store = loadJson(candidateStorePath) as Record<string, unknown>;
        const candidates = Array.isArray(store.candidates) ? store.candidates : [];
        return textResult(
          JSON.stringify(
            candidates.map((candidate) => {
              const record = candidate as Record<string, unknown>;
              return { candidateId: record.candidateId, memberId: record.memberId };
            }),
          ),
        );
      },
    });

    pi.registerTool({
      name: "read_candidate",
      label: "Read candidate",
      description: "Read one council candidate by ID",
      parameters: Type.Object({
        candidateId: Type.String({ description: "Controller-issued candidate ID" }),
      }),
      async execute(_id: string, params: { candidateId: string }) {
        assertToolBudget();
        const store = loadJson(candidateStorePath) as Record<string, unknown>;
        const candidates = Array.isArray(store.candidates) ? store.candidates : [];
        const match = candidates.find(
          (candidate) => (candidate as Record<string, unknown>).candidateId === params.candidateId,
        );
        if (!match) throw new Error("Unknown candidate ID");
        return textResult(boundedText(JSON.stringify(match), MAX_CANDIDATE_READ_BYTES));
      },
    });
  }
}
