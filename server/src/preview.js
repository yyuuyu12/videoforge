import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve } from "node:path";
import { config } from "./config.js";
import { getJob, logEvent } from "./db.js";
import { devServerStatus, startDevServer, stopDevServer } from "./devServers.js";

const builds = new Map();
const STATIC_CONFIG = `import { defineConfig, mergeConfig } from "vite";
import original from "./vite.config.ts";

export default defineConfig(async (env) => {
  const baseConfig = typeof original === "function" ? await original(env) : original;
  return mergeConfig(baseConfig, {
    base: "./",
    build: { copyPublicDir: false },
  });
});
`;

function walkMetadata(root, base = root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return walkMetadata(path, base);
    const stat = statSync(path);
    return [`${relative(base, path).replace(/\\/g, "/")}|${stat.size}|${stat.mtimeMs}`];
  });
}

function presentationFingerprint(presDir) {
  const records = [
    ...walkMetadata(join(presDir, "src"), presDir),
    ...walkMetadata(join(presDir, "public"), presDir),
  ];
  for (const name of ["index.html", "package.json", "vite.config.ts", "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json"]) {
    const path = join(presDir, name);
    if (!existsSync(path)) continue;
    const stat = statSync(path);
    records.push(`${name}|${stat.size}|${stat.mtimeMs}`);
  }
  return createHash("sha256").update(records.sort().join("\n")).digest("hex");
}

function runNode(script, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, shell: false });
    let output = "";
    let settled = false;
    const append = (chunk) => { output = `${output}${chunk}`.slice(-30000); };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => finish({ ok: false, output: `${output}\n无法启动子进程：${error.message}`.trim() }));
    child.on("close", (code, signal) => {
      const detail = code === 0
        ? output
        : output || `子进程异常退出（退出码：${code ?? "无"}，终止信号：${signal ?? "无"}）`;
      finish({ ok: code === 0, output: detail });
    });
  });
}

function runtimeScripts(presDir) {
  const require = createRequire(join(presDir, "package.json"));
  const tsc = require.resolve("typescript/bin/tsc");
  const typescript = require("typescript");
  const vitePackage = require.resolve("vite/package.json");
  return { tsc, typescript, vite: join(vitePackage, "..", "bin", "vite.js") };
}

function checkTsConfig(ts, configPath) {
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error) return [loaded.error];
  const parsed = ts.parseJsonConfigFileContent(
    loaded.config,
    ts.sys,
    dirname(configPath),
    { noEmit: true },
    configPath,
  );
  if (parsed.errors.length) return parsed.errors;
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
  });
  return ts.getPreEmitDiagnostics(program);
}

function checkPresentationTypes(ts, presDir) {
  const diagnostics = ["tsconfig.app.json", "tsconfig.node.json"]
    .flatMap((name) => checkTsConfig(ts, join(presDir, name)));
  if (!diagnostics.length) return { ok: true, output: "" };
  const output = ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => presDir,
    getNewLine: () => "\n",
  });
  return { ok: false, output };
}

async function performBuild(job, fingerprint) {
  const presDir = join(job.workspace, "presentation");
  const distDir = join(presDir, "dist");
  const marker = join(distDir, ".build-fingerprint");
  if (existsSync(join(distDir, "index.html")) && existsSync(marker) && readFileSync(marker, "utf8").trim() === fingerprint) {
    return { built: false, fingerprint, url: `/preview/${job.id}/` };
  }

  const staticConfig = join(presDir, ".videoforge-static.vite.config.mjs");
  if (!existsSync(staticConfig) || readFileSync(staticConfig, "utf8") !== STATIC_CONFIG) writeFileSync(staticConfig, STATIC_CONFIG);

  let scripts;
  try {
    scripts = runtimeScripts(presDir);
  } catch (error) {
    throw new Error(`预览运行组件尚未安装：${error.message}`);
  }

  logEvent(job.id, "preview_build", "开始构建静态预览");
  const checked = await runNode(scripts.tsc, ["-b"], presDir);
  if (!checked.ok) throw new Error(`画面类型检查失败：${checked.output.slice(-1600)}`);
  const built = await runNode(scripts.vite, ["build", "--config", staticConfig], presDir);
  if (!built.ok) throw new Error(`静态预览构建失败：${built.output.slice(-1600)}`);

  mkdirSync(distDir, { recursive: true });
  writeFileSync(marker, `${fingerprint}\n`);
  logEvent(job.id, "preview_build", "静态预览构建完成");
  return { built: true, fingerprint, url: `/preview/${job.id}/` };
}

// 已知失败指纹缓存（2026-07-22 job-34 实证：生成期语法错的同一棵树被面板
// 轮询反复触发构建，同一 TS 错误刷了 12 条 error 事件 + 空烧 CPU，观感=卡死）。
// 同一指纹失败过就直接复抛缓存错误，等代码真正变更（指纹变化）再重试构建。
const failedBuilds = new Map();

/** 工作台模板契约文件自愈（2026-07-23 job-38 实证：修复 agent 把 useStepper.ts
 * 改出语法错、往 cameraCues 加 import——生成/修复模型偶发越界改模板文件，
 * 反复构建失败观感=卡死）。每次构建前把 hooks/components/styles/App/main
 * 与模板快照对齐：被改动即还原、模板新增文件补齐（保持组件集自洽）。
 * Subtitle.css 例外（流水线按字幕预设改写）；旧脚手架（无 avatar-mount:v1
 * 契约）不管——历史作品接口不同，强推会砸坏定制。 */
function restoreProtectedTemplateFiles(job, presDir) {
  const appPath = join(presDir, "src", "App.tsx");
  if (!existsSync(appPath)) return;
  try {
    if (!readFileSync(appPath, "utf8").includes("avatar-mount:v1")) return;
  } catch { return; }
  const templateSrc = join(config.skills.webVideoPresentation, "templates", "src");
  const SKIP = new Set(["components/Subtitle.css"]);
  let restored = 0;
  const walk = (rel) => {
    const src = join(templateSrc, rel);
    if (!existsSync(src)) return;
    if (statSync(src).isDirectory()) {
      for (const name of readdirSync(src)) walk(`${rel}/${name}`);
      return;
    }
    if (SKIP.has(rel)) return;
    const dst = join(presDir, "src", rel);
    const content = readFileSync(src, "utf8");
    try {
      if (existsSync(dst) && readFileSync(dst, "utf8") === content) return;
    } catch {}
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, content);
    restored += 1;
  };
  for (const root of ["hooks", "components", "styles", "App.tsx", "main.tsx"]) walk(root);
  if (restored) logEvent(job.id, "preview_build", `已还原/补齐工作台模板契约文件 ${restored} 个（模板文件禁止生成与修复模型改写）`, "warning");
}

export async function buildPresentation(job) {
  const presDir = join(job.workspace, "presentation");
  if (!existsSync(join(presDir, "package.json"))) throw new Error("画面工程尚未生成");
  restoreProtectedTemplateFiles(job, presDir);
  const fingerprint = presentationFingerprint(presDir);
  const failed = failedBuilds.get(job.id);
  if (failed && failed.fingerprint === fingerprint) throw new Error(failed.message);
  if (failed) failedBuilds.delete(job.id);
  const active = builds.get(job.id);
  if (active?.fingerprint === fingerprint) return active.promise;
  if (active) {
    await active.promise.catch(() => {});
    return buildPresentation(job);
  }

  const promise = performBuild(job, fingerprint)
    .catch((error) => {
      failedBuilds.set(job.id, { fingerprint, message: error.message });
      logEvent(job.id, "preview_build", error.message, "error");
      throw error;
    })
    .finally(() => {
      if (builds.get(job.id)?.promise === promise) builds.delete(job.id);
    });
  builds.set(job.id, { fingerprint, promise });
  return promise;
}

export async function typecheckPresentation(presDir, jobId, stage) {
  let scripts;
  try {
    scripts = runtimeScripts(presDir);
  } catch (error) {
    return { ok: false, output: "", note: `预览运行组件尚未安装：${error.message}` };
  }
  let result;
  try {
    result = checkPresentationTypes(scripts.typescript, presDir);
  } catch (error) {
    result = { ok: false, output: `TypeScript 检查器运行异常：${error.message}` };
  }
  logEvent(jobId, stage, `$ TypeScript 项目检查\n${result.output.slice(-1500)}`, result.ok ? "info" : "error");
  return { ...result, note: result.ok ? "" : `TypeScript 检查失败：${result.output.slice(-1200)}` };
}

export function previewStatus(job) {
  if (config.previewMode === "dev") return devServerStatus(job.id);
  const ready = existsSync(join(job.workspace, "presentation", "dist", "index.html"))
    && existsSync(join(job.workspace, "presentation", "dist", ".build-fingerprint"));
  return { running: ready, ...(ready ? { url: `/preview/${job.id}/` } : {}), mode: "static" };
}

export async function startPreview(job) {
  if (config.previewMode === "dev") return startDevServer(job.id, job.workspace);
  await buildPresentation(job);
  return previewStatus(job);
}

export function stopPreview(jobId) {
  return config.previewMode === "dev" ? stopDevServer(jobId) : { running: false, mode: "static" };
}

export async function preparePreview(job) {
  if (config.previewMode === "dev") {
    const status = await startDevServer(job.id, job.workspace);
    return status.url;
  }
  await buildPresentation(job);
  return `http://${config.host}:${config.port}/preview/${job.id}/`;
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel === "" || !rel.startsWith("..");
}

function htmlError(message) {
  const safe = String(message).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]);
  return `<!doctype html><meta charset="utf-8"><title>预览暂不可用</title><style>body{margin:0;display:grid;min-height:100vh;place-items:center;background:#18130f;color:#f8eee2;font:16px/1.7 system-ui}.box{max-width:720px;padding:32px}h1{font-size:24px}pre{white-space:pre-wrap;color:#d9b894}</style><div class="box"><h1>预览暂时没准备好</h1><p>画面构建没有通过，请根据下面的信息修复后重新加载。</p><pre>${safe}</pre></div>`;
}

export async function servePreview(req, res) {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).end();
  try {
    await buildPresentation(job);
  } catch (error) {
    return res.status(409).type("html").send(htmlError(error.message));
  }

  const presDir = join(job.workspace, "presentation");
  const distDir = resolve(presDir, "dist");
  const publicDir = resolve(presDir, "public");
  let requestPath;
  try { requestPath = decodeURIComponent(req.path || "/").replace(/^\/+/, ""); }
  catch { return res.status(400).end(); }
  if (!requestPath || requestPath.endsWith("/")) requestPath += "index.html";
  if (requestPath.split("/").some((part) => part === ".." || part.startsWith("."))) return res.status(403).end();

  for (const root of [distDir, publicDir]) {
    const file = resolve(root, requestPath);
    if (inside(root, file) && existsSync(file) && statSync(file).isFile()) {
      res.setHeader("Cache-Control", "no-cache");
      return res.sendFile(file);
    }
  }

  if (!extname(requestPath) || String(req.get("accept") || "").includes("text/html")) {
    res.setHeader("Cache-Control", "no-cache");
    return res.sendFile(join(distDir, "index.html"));
  }
  return res.status(404).end();
}
