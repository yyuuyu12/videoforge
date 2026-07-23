// 规范一键回滚：把"skill 规范面"整体恢复到某个存档点（skill-* tag）。
// 用法：
//   node scripts/skill-rollback.mjs            → 列出所有存档点
//   node scripts/skill-rollback.mjs <tag>      → 回滚规范面到该存档点
// 安全性：不改写 git 历史——回滚以"新提交"的形式落盘（多设备同步安全）；
// 回滚后自动跑测试，红了会提示但不阻断（人来决定去留）。
import { execSync } from "node:child_process";

// 规范面清单：skills 快照（prompt/CHAPTER-CRAFT/EXEMPLARS/模板组件）+ 质量线规则。
// 整组回滚保证一致性——单文件回退可能出现规则与模板接口不匹配。
const SCOPE = [
  "skills/",
  "server/src/chapterLint.js",
  "server/src/cameraCheck.js",
  "server/src/cameraChoreographer.js",
  "server/src/effectScore.mjs",
  "server/src/effectScoreRunner.js",
  "server/src/subtitleCheck.js",
  "server/src/render.js",
];

const cwd = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const run = (cmd, opts = {}) => execSync(cmd, { encoding: "utf8", cwd, stdio: opts.inherit ? "inherit" : undefined, ...opts });

const tag = process.argv[2];
if (!tag) {
  const tags = run("git tag -l \"skill-*\" --sort=-creatordate").trim();
  console.log(tags ? `可用规范存档点（新→旧）：\n${tags}\n\n回滚：node scripts/skill-rollback.mjs <tag>` : "还没有存档点，先跑 node scripts/skill-checkpoint.mjs");
  process.exit(0);
}

try { run(`git rev-parse -q --verify refs/tags/${tag}`); } catch {
  console.error(`存档点不存在：${tag}（node scripts/skill-rollback.mjs 查看列表）`);
  process.exit(1);
}
const dirty = run(`git status --porcelain -- ${SCOPE.join(" ")}`).trim();
if (dirty) {
  console.error("规范面有未提交改动，回滚会覆盖它们。先提交或还原这些文件：\n" + dirty);
  process.exit(1);
}

run(`git checkout ${tag} -- ${SCOPE.join(" ")}`);
run(`git commit -m "rollback: 规范面整体回滚至 ${tag}" -- ${SCOPE.join(" ")}`);
console.log(`已回滚规范面到 ${tag}（以新提交落盘）。`);
try {
  run("npm test", { inherit: true });
} catch {
  console.warn("⚠ 回滚后测试未全绿——通常是规则文件与 server 其他代码的接口随版本漂移，需人工裁决。");
}
console.log("下一步：重启服务生效（powershell -File scripts/stop-videoforge.ps1 再 start-videoforge.ps1），并 git push。");
