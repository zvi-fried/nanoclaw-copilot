import fs from 'fs';
import path from 'path';

import {
  COPILOT_HOME,
  resolveCopilotExecutionPolicy,
  resolveCopilotInference,
  resolveCopilotMcpServers,
} from '../providers/copilot-config.js';
import { registerProviderContract } from '../providers/provider-registry.js';
import type { ProviderRuntimeContract } from './registry.js';

const provider = 'copilot';
// Pinned literal, not the core's constant: a core seam bump must fail this
// payload's version check until the payload is refreshed to match.
const RUNTIME_SEAM_VERSION = 1;

export const copilotRuntimeContract: ProviderRuntimeContract = {
  seamVersion: RUNTIME_SEAM_VERSION,
  configuration: {
    // The container and the credential gateway are the boundary; the stance is fixed.
    executionPolicy: { constant: resolveCopilotExecutionPolicy() },
    inference: resolveCopilotInference,
    // The hook itself: the provider runs it from the SDK's own session-start hook.
    memory: (hook) => ({ ...hook }),
    mcpServers: resolveCopilotMcpServers,
  },
  // The runtime keeps each session's event log on the copilot-home volume, which
  // resume reads, so there is nothing for core to archive.
  history: { readTrace: newestCopilotSessionLog },
  // Each completed assistant message (between tool calls too) is its own text segment.
  textDelivery: 'mid-turn-complete',
  commands: { formatting: 'xml' },
};

// Two-step registration: providers/copilot.ts registered the factory; this
// attaches the contract. Order-independent, and neither file imports the other.
registerProviderContract(provider, copilotRuntimeContract);

/** The newest session's event log, for `/upload-trace`. */
export function newestCopilotSessionLog(home = process.env.COPILOT_HOME || COPILOT_HOME): string | null {
  const root = path.join(home, 'session-state');
  let newest: { file: string; mtime: number } | null = null;
  try {
    for (const entry of fs.readdirSync(root)) {
      const file = path.join(root, entry, 'events.jsonl');
      try {
        const mtime = fs.statSync(file).mtimeMs;
        if (!newest || mtime > newest.mtime) newest = { file, mtime };
      } catch {
        /* A session directory without a log yet. */
      }
    }
  } catch {
    return null;
  }
  return newest?.file ?? null;
}
