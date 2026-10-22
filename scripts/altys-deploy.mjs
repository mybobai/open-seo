// Altys fork: deploy OpenSEO to seo.mybobai.com with wrangler.
//
// Pulumi (mybobai/backend, infra/) owns the Cloudflare resources: D1, KV, R2,
// and the Access application and service token in front of the hostname. This
// script ships only the code. It builds, points the generated worker configs
// at the Pulumi-owned resources in deploy/altys.config.json, applies D1
// migrations, and deploys the audit worker and then the app worker.
// Upstream's Alchemy deploy (pnpm deploy:selfhost) is not used.
//
// wrangler.jsonc keeps upstream's ids, which also name the local dev
// databases; the ids are swapped in the build output instead.
//
// Secrets are set once per worker, after the first deploy creates the
// workers, and survive later deploys:
//   pnpm exec wrangler secret put DATAFORSEO_API_KEY --name open-seo
//   pnpm exec wrangler secret put DATAFORSEO_API_KEY --name open-seo-audit
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const config = JSON.parse(
  readFileSync(resolve(root, "deploy/altys.config.json"), "utf8"),
);

const required = [
  "hostname",
  "d1DatabaseId",
  "d1DatabaseName",
  "kvNamespaceId",
  "oauthKvNamespaceId",
  "r2BucketName",
  "teamDomain",
  "policyAud",
  "serviceTokenClientId",
  "googleClientId",
];
const missing = required.filter((key) => !config[key]);
if (missing.length > 0) {
  throw new Error(
    `deploy/altys.config.json is missing ${missing.join(", ")} (Pulumi stack outputs).`,
  );
}

function run(command, args, env = {}) {
  execFileSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
}

function rewrite(path, edit) {
  const file = resolve(root, path);
  const worker = JSON.parse(readFileSync(file, "utf8"));
  edit(worker);
  writeFileSync(file, JSON.stringify(worker));
}

// Both workers share D1, KV and R2; OAUTH_KV is the app worker's only.
function pointAtPulumiResources(worker) {
  worker.d1_databases = [
    {
      binding: "DB",
      database_name: config.d1DatabaseName,
      database_id: config.d1DatabaseId,
      migrations_dir: resolve(root, "drizzle/sqlite"),
    },
  ];
  worker.r2_buckets = [{ binding: "R2", bucket_name: config.r2BucketName }];
  worker.kv_namespaces = worker.kv_namespaces.map((namespace) => ({
    ...namespace,
    id:
      namespace.binding === "OAUTH_KV"
        ? config.oauthKvNamespaceId
        : config.kvNamespaceId,
  }));
  worker.vars = {
    ...worker.vars,
    AUTH_MODE: "cloudflare_access",
    DATABASE_PROVIDER: "d1",
  };
}

run("pnpm", ["exec", "vite", "build"], { AUTH_MODE: "cloudflare_access" });

rewrite("dist/open_seo_audit/wrangler.json", (worker) => {
  pointAtPulumiResources(worker);
  // Browser Run for the site audit's "Render JavaScript" option.
  worker.browser = { binding: "BROWSER" };
});

rewrite("dist/server/wrangler.json", (worker) => {
  pointAtPulumiResources(worker);
  worker.vars = {
    ...worker.vars,
    TEAM_DOMAIN: config.teamDomain,
    POLICY_AUD: config.policyAud,
    ACCESS_SERVICE_TOKEN_CLIENT_ID: config.serviceTokenClientId,
    // Search Console and GA4 connections. GOOGLE_CLIENT_SECRET and
    // BETTER_AUTH_SECRET are worker secrets.
    GOOGLE_CLIENT_ID: config.googleClientId,
    AUDIT_BROWSER_RENDERING: "true",
  };
  // The Access application covers only the custom domain, so the
  // workers.dev and preview URLs stay off.
  worker.routes = [{ pattern: config.hostname, custom_domain: true }];
  worker.workers_dev = false;
  worker.preview_urls = false;
});

const wrangler = ["exec", "wrangler"];
run("pnpm", [
  ...wrangler,
  "d1",
  "migrations",
  "apply",
  "DB",
  "--remote",
  "-c",
  "dist/server/wrangler.json",
]);
// The app worker binds the audit worker's workflow cross-script, so the
// audit worker goes first.
run("pnpm", [...wrangler, "deploy", "-c", "dist/open_seo_audit/wrangler.json"]);
run("pnpm", [...wrangler, "deploy", "-c", "dist/server/wrangler.json"]);
