/** @type {Record<string, { id: string; title: string; summary: string }>} */
export const AGENTS = {
  agent1: {
    id: 'agent1',
    title: '剧情丰满（人物/势力）',
    summary:
      '基于人设、势力与世界观，在用户提供的大纲或剧情走向下推演行为并丰满剧情。',
  },
  agent2: {
    id: 'agent2',
    title: '人设 / 世界观一致性',
    summary: '检查大纲是否违背人设或世界观；冲突时暂停并等待用户选择处理策略。',
  },
  agent3: {
    id: 'agent3',
    title: '时空与信息传播',
    summary:
      '校验时间、地点、移动合理性，以及信息传播速度与通讯方式（电报/电话/手机等）是否与设定一致。',
  },
  agent4: {
    id: 'agent4',
    title: '文风一致性',
    summary: '对照文风记忆标蓝冲突并备注原因；用户可统一文风、更新记忆或直接通过。',
  },
  agent5: {
    id: 'agent5',
    title: '流畅度与句式质量',
    summary:
      '标红机械、不连贯段落及过度「不是……而是」类句式；支持逐段或批量保留/重写与 Peek 重写。',
  },
  agent6: {
    id: 'agent6',
    title: '本章总结与设定回写',
    summary: '存档后总结本章并补充更新出场人物、势力与世界观条目。',
  },
};

export const OUTLINE_PIPELINE_AGENTS = ['agent1', 'agent2', 'agent3'];

export const WRITING_PIPELINE_AGENTS = ['agent4', 'agent5', 'agent6'];
