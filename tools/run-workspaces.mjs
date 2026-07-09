import { execFileSync } from "node:child_process";
import process from "node:process";

const task = process.argv[2];
if (!task) {
  throw new Error("usage: node tools/run-workspaces.mjs <build|typecheck|test>");
}

const workspaceOrder = [
  "@casabio/jxl-core",
  "@casabio/jxl-capabilities",
  "@casabio/jxl-policy",
  "@casabio/jxl-cache",
  "@casabio/jxl-scheduler",
  "@casabio/jxl-wasm",
  "@casabio/pyramid-ingest",
  "@casabio/jxl-worker-browser",
  "@casabio/jxl-worker-node",
  "@casabio/jxl-stream",
  "@casabio/jxl-session",
  "@casabio/jxl-test-corpus",
];

if (!["build", "typecheck", "test"].includes(task)) {
  throw new Error(`unknown workspace task: ${task}`);
}

function runNpm(args) {
  const npmCli = process.env.npm_execpath;
  // npm sets npm_execpath to npm-cli.js (a JS file node can run). bun sets it to
  // the bun *binary*, which node cannot parse (PE header -> "Invalid token").
  // Only take the node path for a JS CLI; otherwise fall through to npm, which
  // understands the --workspace/--if-present flags below (bun does not).
  if (npmCli && /\.[cm]?js$/i.test(npmCli)) {
    execFileSync(process.execPath, [npmCli, ...args], { stdio: "inherit" });
    return;
  }
  execFileSync("cmd.exe", ["/d", "/s", "/c", "npm", ...args], { stdio: "inherit" });
}

for (const name of workspaceOrder) {
  console.log(`>> ${task} ${name}`);
  runNpm(["run", task, "--workspace", name, "--if-present"]);
}
