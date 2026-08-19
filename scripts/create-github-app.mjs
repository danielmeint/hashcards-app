#!/usr/bin/env node
/**
 * Create the GitHub App that "Sign in with GitHub" needs, through GitHub's App
 * Manifest flow.
 *
 * The alternative is filling in ten fields at github.com/settings/apps/new,
 * where a missed checkbox produces an app that authenticates fine and then
 * fails in a way that points nowhere near the cause — user tokens that never
 * expire, or an OAuth step that is never offered at install time. Everything
 * here comes from one reviewed object instead.
 *
 * It serves a page that posts that manifest to GitHub, catches the redirect
 * back, and exchanges the one-time code for the app's identifiers. The client
 * secret and private key go straight to disk at 0600 and are never printed.
 *
 *   node scripts/create-github-app.mjs --name "My Hashcards"
 *
 * See README "Sign-in setup" for what to do with the output.
 */
import http from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULTS = {
  name: "Hashcards",
  url: "https://hashcards.dev",
  out: ".github-app",
  port: 8765,
};

/**
 * What the app is allowed to do, in one object.
 *
 * `contents: write` covers both halves of sync — reading the card files and
 * writing `hashcards-state.json` back. `request_oauth_on_install` is what makes
 * installing and signing in a single trip rather than two. There is no webhook,
 * so none is declared. `public` lets accounts other than the owner's install
 * it, which is the entire point of replacing the token wall.
 *
 * Note that user-token expiry is *not* here: GitHub exposes it only as a
 * checkbox on the app's settings page. New apps default to expiring tokens,
 * which is what the refresh handling in `src/auth.ts` expects — but it is worth
 * confirming, and `verifyUrl()` below points at the page that shows it.
 */
export function buildManifest({ name, url, port }) {
  return {
    name,
    url,
    description:
      "Spaced repetition flashcards from Markdown files in your GitHub repo.",
    // Where GitHub returns the browser once the app exists, carrying a
    // one-time code. Local, because it is only ever used by this script.
    redirect_url: `http://localhost:${port}/created`,
    // Where the OAuth authorize step may return to. Both are needed:
    // production, and `wrangler pages dev` for local work on the Function.
    callback_urls: [`${url.replace(/\/$/, "")}/`, "http://localhost:8788/"],
    request_oauth_on_install: true,
    setup_on_update: false,
    public: true,
    default_events: [],
    default_permissions: { contents: "write", metadata: "read" },
  };
}

export function installUrl(slug) {
  return `https://github.com/apps/${slug}/installations/new`;
}

/** The settings page that shows whether user tokens expire. */
export function verifyUrl(slug) {
  return `https://github.com/settings/apps/${slug}`;
}

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (key === "help" || key === "h") return null;
    if (!(key in options)) throw new Error(`Unknown option: ${argv[i]}`);
    if (argv[i + 1] === undefined) throw new Error(`${argv[i]} needs a value`);
    options[key] = key === "port" ? Number(argv[i + 1]) : argv[i + 1];
  }
  return options;
}

const USAGE = `Create the Hashcards GitHub App via GitHub's App Manifest flow.

  node scripts/create-github-app.mjs [options]

  --name  App name, globally unique across GitHub  (default "${DEFAULTS.name}")
  --url   Production origin of your deployment     (default "${DEFAULTS.url}")
  --out   Directory for the results, gitignored    (default "${DEFAULTS.out}")
  --port  Local port for the one-shot server       (default ${DEFAULTS.port})
`;

const page = (body) => `<!doctype html><meta charset="utf-8">
<title>Create a GitHub App</title>
<style>
  body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.5rem;color:#111}
  code{background:#f2f2f2;padding:.1em .35em;border-radius:3px}
  .ok{color:#16a34a}.err{color:#dc2626}
  @media (prefers-color-scheme:dark){body{background:#111;color:#eee}code{background:#222}}
</style>${body}`;

function serve({ name, url, out, port }) {
  const manifest = buildManifest({ name, url, port });
  const state = randomBytes(16).toString("hex");
  const outDir = resolve(out);

  const server = http.createServer(async (req, res) => {
    const here = new URL(req.url, `http://localhost:${port}`);

    if (here.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        page(`<h1>Creating “${name}”…</h1>
          <p>Handing you to GitHub. Review the settings and press
          <strong>Create GitHub App</strong>.</p>
          <form id="f" method="post" action="https://github.com/settings/apps/new?state=${state}">
            <input type="hidden" name="manifest" value='${JSON.stringify(
              manifest
            ).replace(/'/g, "&apos;")}'>
            <button type="submit">Continue to GitHub</button>
          </form>
          <script>document.getElementById("f").submit()</script>`)
      );
      return;
    }

    if (here.pathname !== "/created") {
      res.writeHead(404).end("not found");
      return;
    }

    const code = here.searchParams.get("code");
    // A redirect without the state this run generated did not come from it.
    if (here.searchParams.get("state") !== state || !code) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(
        page(`<h1 class="err">Could not verify that redirect.</h1>
          <p>Start again from <code>http://localhost:${port}/</code>.</p>`)
      );
      return;
    }

    const conversion = await fetch(
      `https://api.github.com/app-manifests/${code}/conversions`,
      { method: "POST", headers: { Accept: "application/vnd.github+json" } }
    );
    if (!conversion.ok) {
      const detail = `${conversion.status} ${conversion.statusText}`;
      res.writeHead(502, { "Content-Type": "text/html" });
      res.end(
        page(`<h1 class="err">GitHub refused the exchange (${detail}).</h1>
          <p>The code is single-use and expires after an hour — start again from
          <code>http://localhost:${port}/</code>.</p>`)
      );
      console.error(`Conversion failed: ${detail}`);
      server.close();
      process.exitCode = 1;
      return;
    }

    const app = await conversion.json();
    mkdirSync(outDir, { recursive: true });

    // Public identifiers. These belong in the repo, via src/github-app.ts.
    writeFileSync(
      resolve(outDir, "github-app.public.json"),
      JSON.stringify(
        {
          id: app.id,
          slug: app.slug,
          name: app.name,
          client_id: app.client_id,
          owner: app.owner?.login,
          html_url: app.html_url,
        },
        null,
        2
      ) + "\n"
    );

    // No trailing newline, so it can be piped straight into
    // `wrangler pages secret put` without ever being opened or echoed.
    writeFileSync(resolve(outDir, "github-app.secret"), app.client_secret, {
      mode: 0o600,
    });

    // Unused by this app — user-to-server OAuth needs only the client secret —
    // but discarding the only copy would be rude. Same rule: nothing reads it.
    writeFileSync(resolve(outDir, "github-app.private-key.pem"), app.pem, {
      mode: 0o600,
    });

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      page(`<h1 class="ok">“${app.name}” created.</h1>
        <p>Client ID <code>${app.client_id}</code>, slug <code>${app.slug}</code>.</p>
        <p>You can close this tab and go back to the terminal.</p>`)
    );

    console.log(`
Created ${app.name} — ${app.html_url}

  Client ID  ${app.client_id}
  Slug       ${app.slug}

Written to ${outDir}/ (secret and key are 0600, and nothing here prints them):
  github-app.public.json
  github-app.secret
  github-app.private-key.pem

Next:
  1. Put the client ID and slug in src/github-app.ts.
  2. Push the secret to your Pages project, without it passing through a shell:
       npx wrangler pages secret put GITHUB_CLIENT_SECRET \\
         --project-name <project> < ${out}/github-app.secret
       npx wrangler pages secret put GITHUB_CLIENT_ID \\
         --project-name <project>
  3. Install it on your card repo:  ${installUrl(app.slug)}
  4. Confirm user tokens expire at  ${verifyUrl(app.slug)}
`);
    server.close();
  });

  server.listen(port, () => {
    console.log(`Open http://localhost:${port}/ to create “${name}”.`);
  });
}

// Importing this for its manifest builder must not start a server.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n\n${USAGE}`);
    process.exit(1);
  }
  if (!options) {
    console.log(USAGE);
  } else {
    serve(options);
  }
}
