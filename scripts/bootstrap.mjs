#!/usr/bin/env node
// Clones the platform repositories of a manifest (bootstrap/repos.example.json) and
// writes a local plan. Installing the stack itself is ./install.sh's job.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";

const args = new Set(process.argv.slice(2));
const argValue = (name, fallback) => {
  const prefix = `${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
};

const mode = args.has("--apply") ? "apply" : "plan";
if (args.has("--start")) {
  console.error("--start was removed: the stack is installed by ./install.sh (docs/install-design.md).");
  process.exit(2);
}
const useDefaults = args.has("--defaults");
const reposPath = resolve(argValue("--repos", "bootstrap/repos.example.json"));

function question(rl, prompt, fallback = "") {
  const suffix = fallback ? ` [${fallback}]` : "";
  return new Promise((resolveAnswer) => {
    rl.question(`${prompt}${suffix}: `, (answer) => {
      resolveAnswer(answer.trim() || fallback);
    });
  });
}

function secretQuestion(prompt) {
  if (useDefaults) {
    return Promise.resolve("");
  }

  if (!input.isTTY) {
    return Promise.resolve("");
  }

  return new Promise((resolveAnswer) => {
    const rl = readline.createInterface({ input, output });
    const stdin = process.stdin;
    const onData = (char) => {
      char = char.toString();
      switch (char) {
        case "\n":
        case "\r":
        case "\u0004":
          stdin.removeListener("data", onData);
          break;
        default:
          output.clearLine(0);
          output.cursorTo(0);
          output.write(`${prompt}: ${"*".repeat(rl.line.length)}`);
          break;
      }
    };

    stdin.on("data", onData);
    rl.question(`${prompt}: `, (answer) => {
      rl.close();
      output.write("\n");
      resolveAnswer(answer.trim());
    });
  });
}

function run(command, commandArgs, options = {}) {
  if (mode !== "apply") {
    return;
  }
  execFileSync(command, commandArgs, { stdio: "inherit", ...options });
}

function safeClone(repo, workspaceDir, planLines) {
  const target = join(workspaceDir, repo.name);
  if (existsSync(target)) {
    planLines.push(`- Reuse existing repository: ${target}`);
    if (mode === "apply") {
      run("git", ["-C", target, "status", "--short"]);
    }
    return;
  }

  planLines.push(`- Clone ${repo.url} into ${target}`);
  if (mode === "apply") {
    mkdirSync(workspaceDir, { recursive: true });
    const cloneArgs = ["clone"];
    if (repo.branch) cloneArgs.push("--branch", repo.branch);
    cloneArgs.push(repo.url, target);
    run("git", cloneArgs);
  }
}

function loadRepos(path) {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.repositories)) {
    throw new Error(`Repository manifest must contain a repositories array: ${path}`);
  }
  return parsed.repositories;
}

function writeLocalConfig(config, adminPassword, plan) {
  mkdirSync("local", { recursive: true });
  const env = [
    `IHC_WORKSPACE_DIR=${config.workspaceDir}`,
    `IHC_GIT_BASE_URL=${config.gitBaseUrl}`,
    `IHC_GIT_OWNER=${config.gitOwner}`,
    `IHC_INTERNAL_DOMAIN=${config.internalDomain}`,
    `IHC_PORTAL_DOMAIN=${config.portalDomain}`,
    `IHC_TUNNEL_PROVIDER=${config.tunnelProvider}`,
    `IHC_REVERSE_PROXY=${config.reverseProxy}`,
    `IHC_AUTH_PROVIDER=${config.authProvider}`,
    `IHC_GIT_PROVIDER=${config.gitProvider}`,
    `IHC_CONTAINER_MANAGER=${config.containerManager}`,
    `IHC_HOST_MONITOR=${config.hostMonitor}`,
    `IHC_DATABASE=${config.database}`,
    `IHC_CACHE=${config.cache}`,
    `IHC_OBJECT_STORAGE=${config.objectStorage}`,
    `IHC_INITIAL_ADMIN_EMAIL=${config.adminEmail}`,
    `IHC_INITIAL_ADMIN_PASSWORD=${adminPassword}`,
    ""
  ].join("\n");

  const envPath = "local/bootstrap.env";
  const planPath = "local/bootstrap-plan.md";
  const planContent = [`# Bootstrap Plan`, "", ...plan].join("\n");

  if (mode === "apply") {
    writeFileSync(envPath, env, { mode: 0o600 });
  }
  writeFileSync(planPath, planContent);
}

async function main() {
  const repos = loadRepos(reposPath);

  const defaults = {
    workspaceDir: resolve("local/workspace"),
    gitBaseUrl: "https://git.example.com",
    gitOwner: "platform",
    internalDomain: "internal.example.com",
    portalDomain: "apps.internal.example.com",
    tunnelProvider: "cloudflared",
    reverseProxy: "nginx-proxy-manager",
    authProvider: "authentik",
    gitProvider: "gitea",
    containerManager: "portainer",
    hostMonitor: "glances",
    database: "postgres",
    cache: "redis",
    objectStorage: "none",
    adminEmail: "admin@example.com"
  };

  const config = {};
  if (useDefaults) {
    Object.assign(config, defaults);
  } else {
    const rl = readline.createInterface({ input, output });
    config.workspaceDir = resolve(await question(rl, "Workspace directory", defaults.workspaceDir));
    config.gitBaseUrl = await question(rl, "Git base URL", defaults.gitBaseUrl);
    config.gitOwner = await question(rl, "Git organization or owner", defaults.gitOwner);
    config.internalDomain = await question(rl, "Internal base domain", defaults.internalDomain);
    config.portalDomain = await question(rl, "Portal domain", defaults.portalDomain);
    config.tunnelProvider = await question(rl, "Tunnel provider", defaults.tunnelProvider);
    config.reverseProxy = await question(rl, "Reverse proxy", defaults.reverseProxy);
    config.authProvider = await question(rl, "Auth provider", defaults.authProvider);
    config.gitProvider = await question(rl, "Git server", defaults.gitProvider);
    config.containerManager = await question(rl, "Container manager", defaults.containerManager);
    config.hostMonitor = await question(rl, "Host monitor", defaults.hostMonitor);
    config.database = await question(rl, "Default database", defaults.database);
    config.cache = await question(rl, "Default cache", defaults.cache);
    config.objectStorage = await question(rl, "Object storage", defaults.objectStorage);
    config.adminEmail = await question(rl, "Initial admin email", defaults.adminEmail);
    rl.close();
  }

  const adminPassword = await secretQuestion("Initial admin password");

  const plan = [
    `Mode: ${mode}`,
    `Repository manifest: ${reposPath}`,
    `Workspace directory: ${config.workspaceDir}`,
    "",
    "## Single-box cloud",
    `- Ingress tunnel: ${config.tunnelProvider}`,
    `- Reverse proxy: ${config.reverseProxy}`,
    `- Auth gateway: ${config.authProvider}`,
    `- Git server: ${config.gitProvider}`,
    `- Container manager: ${config.containerManager}`,
    `- Host monitor: ${config.hostMonitor}`,
    `- Default database: ${config.database}`,
    `- Default cache: ${config.cache}`,
    `- Object storage: ${config.objectStorage}`,
    `- Entry path: ${config.tunnelProvider} -> ${config.reverseProxy} -> ${config.authProvider} -> app`,
    "",
    "## Repositories"
  ];

  for (const repo of repos) {
    safeClone(repo, config.workspaceDir, plan);
  }

  plan.push("");
  plan.push("## Local config");
  plan.push("- Write local/bootstrap.env with machine-local configuration.");
  plan.push("- Write local/bootstrap-plan.md with this plan.");
  plan.push("- Keep generated config out of Git.");

  plan.push("");
  plan.push("## Start services");
  plan.push("- Not done here. Install the stack with ./install.sh (plan, then apply).");

  writeLocalConfig(config, adminPassword, plan);

  output.write(`\nBootstrap ${mode} complete.\n`);
  output.write(`Plan written to local/bootstrap-plan.md\n`);
  if (mode === "plan") {
    output.write(`No repositories were cloned and no services were started. Re-run with --apply after review.\n`);
  }
  if (useDefaults) {
    output.write(`Defaults were used. Re-run without --defaults for interactive setup.\n`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
