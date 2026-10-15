import { EXIT } from "../command";
import type { Command } from "../command";

/**
 * Commands that belong to later milestones. They exist now so `hc --help`
 * shows the whole shape of the tool and the names are taken; each milestone
 * replaces its stub with a module of its own in `commands/`.
 */
function notYet(name: string, summary: string, milestone: string, positionals = 0): Command {
  return {
    name,
    summary: `${summary} (not yet: ${milestone})`,
    help: `Usage: hc ${name}\n\n${summary}. Not implemented yet: see PLAN-1.0.md ${milestone}.`,
    options: {},
    positionals,
    async run(ctx) {
      const message = `hc ${name} is not implemented yet, see PLAN-1.0.md ${milestone}`;
      if (ctx.json) ctx.emit({ ok: false, error: message });
      else ctx.io.stderr(message + "\n");
      return EXIT.error;
    },
  };
}

export const fit = notYet("fit", "fit FSRS parameters to the review history", "M7");
