// 规范存档点：给当前"skill 规范面"打 git tag，供 skill-rollback.mjs 一键回退。
// 用法：node scripts/skill-checkpoint.mjs [标签备注]
// 纪律：每次改动规范面（skills/ 或质量线规则文件）前先打点；验证通过后再打一个。
import { execSync } from "node:child_process";

const note = (process.argv[2] || "").replace(/[^\w一-鿿-]/g, "-").slice(0, 40);
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").slice(0, 12);
const tag = `skill-${stamp}${note ? `-${note}` : ""}`;

const run = (cmd) => execSync(cmd, { encoding: "utf8", cwd: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") }).trim();

const dirty = run("git status --porcelain -- skills/ server/src/chapterLint.js server/src/cameraCheck.js server/src/cameraChoreographer.js server/src/effectScore.mjs server/src/effectScoreRunner.js server/src/subtitleCheck.js server/src/render.js");
if (dirty) {
  console.error("规范面有未提交改动，先提交再打存档点：\n" + dirty);
  process.exit(1);
}
run(`git tag ${tag}`);
try { run(`git push origin ${tag}`); } catch { console.warn("(tag 推送失败，仅本地存档——联网后 git push origin --tags)"); }
console.log(`规范存档点已创建：${tag}`);
console.log(`回滚用：node scripts/skill-rollback.mjs ${tag}`);
