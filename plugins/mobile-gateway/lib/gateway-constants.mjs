// Shared gateway constants (leaf module: imports nothing from the gateway).
import fs from 'node:fs'

// lib/ sits next to index.mjs, so '../package.json' is still the package root.
export const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return 'unknown'
  }
})()

export const COMMAND_UI_OVERRIDES = Object.freeze({
  permission: Object.freeze({
    kind: 'select',
    optionsRequest: 'command-options',
    selectionRequest: 'command-select',
  }),
  model: Object.freeze({
    kind: 'select',
    optionsRequest: 'command-options',
    selectionRequest: 'command-select',
  }),
})
export const COMMAND_CATALOG_COPY = Object.freeze({
  zh: Object.freeze({
    locale: 'zh-CN',
    commandsTitle: '命令',
    skillsTitle: '技能',
    userOnly: '仅用户',
    modelDescription: '选择本会话使用的模型',
    hints: Object.freeze({
      plan: '描述你的任务以生成计划',
      goal: '输入目标，智能体将持续执行',
    }),
  }),
  en: Object.freeze({
    locale: 'en',
    commandsTitle: 'Commands',
    skillsTitle: 'Skills',
    userOnly: 'user-only',
    modelDescription: 'Select the model for this conversation',
    hints: Object.freeze({
      plan: 'describe your task to generate plan',
      goal: 'describe the objective for a long-running task',
    }),
  }),
})
