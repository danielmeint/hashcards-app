import { parseFile as parseLog, serializeFile } from "../src/core/events";
import type { LinkEvent, ReviewLogEvent } from "../src/core/events";
import { compareEvents } from "../src/core/replay";
import { HC_DEVICE, monthFilePath, monthOf } from "../src/core/month-files";
import { CommandError } from "./command";
import { showFile } from "./git";
import type { TreeChanges } from "./git";

/**
 * The data branch files that `links` go into: `reviews/<month>.hc.jsonl`,
 * each month's file as it is at `tip` plus the new links, in replay order.
 * `hc` is a reserved writer name, so no device ever rebuilds these files —
 * which is what makes appending to them safe.
 */
export function linkFileChanges(repo: string, tip: string | null, links: readonly LinkEvent[]): TreeChanges {
  const byMonth = new Map<string, ReviewLogEvent[]>();
  for (const event of links) {
    const month = monthOf(event);
    byMonth.set(month, [...(byMonth.get(month) ?? []), event]);
  }
  const changes: TreeChanges = new Map();
  for (const [month, added] of byMonth) {
    const path = monthFilePath(month, HC_DEVICE);
    const existing = tip ? showFile(repo, tip, path) : null;
    const parsed = existing === null ? { events: [], errors: [] } : parseLog(existing);
    if (parsed.errors.length > 0) {
      throw new CommandError(`${path}:${parsed.errors[0].line}: ${parsed.errors[0].error}; not appending to it`);
    }
    const seen = new Set(parsed.events.map((e) => JSON.stringify(e)));
    const all = [...parsed.events, ...added.filter((e) => !seen.has(JSON.stringify(e)))];
    changes.set(path, serializeFile(all.sort(compareEvents)));
  }
  return changes;
}
