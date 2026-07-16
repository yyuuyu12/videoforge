import test from "node:test";
import assert from "node:assert/strict";
import { classifyFeedback } from "./feedbackRouter.js";

test("同步/时序类反馈路由到媒体管线阶段", () => {
  assert.equal(classifyFeedback("口型和声音对不上", "数字人").route, "pipeline");
  assert.equal(classifyFeedback("口型和声音对不上", "数字人").stage, "avatar_media");
  assert.equal(classifyFeedback("数字人视频有断续感", "数字人").stage, "avatar_media");
  assert.equal(classifyFeedback("字幕出现得比声音晚", "配音字幕").stage, "subtitle_cues");
  assert.equal(classifyFeedback("音画不同步", "逐页生成").stage, "audio_synth");
  assert.equal(classifyFeedback("第三章配音缺了一段", "配音字幕").stage, "audio_synth");
});

test("全局风格类反馈路由到配置路径", () => {
  assert.equal(classifyFeedback("帮我换一个主题", "逐页生成").route, "global");
  assert.equal(classifyFeedback("整体风格太暗了全部调亮", "逐页生成").route, "global");
});

test("视觉/文案类反馈仍走 Agent", () => {
  assert.equal(classifyFeedback("第三页标题改成'先看数据'", "逐页生成").route, "agent");
  assert.equal(classifyFeedback("这一页图表颜色太浅了加深一点", "逐页生成").route, "agent");
  assert.equal(classifyFeedback("开场那句话不够有力", "口播稿审阅").route, "agent");
});

test("稿件阶段永远走 Agent（无媒体管线可言）", () => {
  assert.equal(classifyFeedback("音画不同步", "口播稿审阅").route, "agent");
  assert.equal(classifyFeedback("字幕时间不对", "原文确认").route, "agent");
});
