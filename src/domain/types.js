/**
 * @typedef {'plot_direction' | 'user_outline'} UserOutlineMode
 */

/**
 * @typedef {'mobility' | 'information'} TimelineIssueKind
 */

/**
 * @typedef {'character_world' | 'timeline'} BlockingAgent
 */

/**
 * Agent 2: user resolution when character/world conflict
 * @typedef {'auto_plot_first' | 'auto_setting_first' | 'user_patch' | 'force_continue'} Agent2Resolution
 */

/**
 * Agent 3: user resolution when timeline/information conflict
 * @typedef {'edit_plot' | 'extend_world' | 'ignore'} Agent3Resolution
 */

/**
 * @typedef {Object} Skin
 * @property {string} name - 皮肤/形态名称
 * @property {string} [outfit] - 妆造描述
 * @property {string} [story] - 皮肤背景故事
 * @property {string} [scenario] - 适用场景
 */

/**
 * @typedef {Object} Character
 * @property {string} id
 * @property {string} name
 * @property {string[]} [aliases] - 别名
 * @property {'男'|'女'|string} [gender]
 * @property {string|number} [age]
 * @property {string} [role] - 角色定位（主角/配角等）
 * @property {string} [faction] - 所属势力
 * @property {string} [appearance] - 外貌描述
 * @property {string} [hairColor]
 * @property {string} [eyeColor]
 * @property {string} [height]
 * @property {string} [figure] - 体型
 * @property {string} [personality] - 性格
 * @property {string} [background] - 背景故事
 * @property {string} [moeTraits] - 萌点
 * @property {string} [quotes] - 代表性台词
 * @property {Skin[]} [skins] - 皮肤/形态列表
 * @property {boolean} [isOriginal] - 是否原创角色
 * @property {string} [sourceWork] - 原作名（同人角色）
 * @property {string} [originalName] - 原作中名称
 * @property {object[]} [relationships] - 关系列表
 * @property {object} [relationship] - 关系描述（导入格式兼容）
 * @property {string} [storyArc] - 故事弧线
 * @property {number} [schemaVersion]
 * @property {string} [_enrichmentStatus] - 联网补全状态
 * @property {string} [_enrichmentSource] - 补全数据来源
 * @property {string} [protagonist]
 */

/**
 * @typedef {Object} OutlineIssue
 * @property {string} id
 * @property {BlockingAgent} sourceAgent
 * @property {string} summary
 * @property {string} [detail]
 * @property {TimelineIssueKind} [timelineKind]
 * @property {string[]} [affectedOutlineNodeIds]
 */

/**
 * @typedef {Object} OutlineNode
 * @property {string} id
 * @property {string} title
 * @property {string} summary
 * @property {string[]} [characters] - 本场景出现的角色ID列表
 * @property {string} [outfit] - 角色着装标记，如"泳装-夏日"或皮肤名
 * @property {string} [setting] - 场景设置标签，如"战斗/日常/室内/室外"
 * @property {boolean} [needBackground] - 是否需要包含角色背景故事
 * @property {string} [pov] - 视角角色ID
 * @property {string} [location] - 地点
 * @property {number} [volumeIndex] - 所属卷索引（用于层级文件路由，从1开始）
 * @property {number} [sectionIndex] - 所属节索引（用于层级文件路由，从1开始）
 * @property {number} [chapterIndex] - 所属章索引（用于层级文件路由，从1开始）
 */

/**
 * @typedef {Object} OutlineMasterItem
 * @property {string} id
 * @property {string} title
 * @property {string} summary
 * @property {number} volumeIndex
 */

/**
 * @typedef {Object} OutlineVolumeItem
 * @property {string} id
 * @property {string} title
 * @property {string} summary
 * @property {number} volumeIndex
 * @property {number[]} [sectionIndices]
 */

/**
 * @typedef {Object} OutlineSectionItem
 * @property {string} id
 * @property {string} title
 * @property {string} summary
 * @property {number} volumeIndex
 * @property {number} sectionIndex
 * @property {number[]} [chapterIndices]
 */

/**
 * @typedef {Object} OutlineChapter
 * @property {number} chapterIndex
 * @property {string} title
 * @property {OutlineNode[]} scenes - 场景级节点（最详细）
 * @property {string} [writingNotes] - 写作指导
 */

/**
 * @typedef {Object} HierarchicalVolume
 * @property {number} volumeIndex
 * @property {OutlineVolumeItem} metadata
 * @property {HierarchicalSection[]} sections
 */

/**
 * @typedef {Object} HierarchicalSection
 * @property {number} sectionIndex
 * @property {OutlineSectionItem} metadata
 * @property {OutlineChapter[]} chapterOutlines
 */

/**
 * @typedef {Object} HierarchicalOutline
 * @property {string} id
 * @property {number} version
 * @property {OutlineMasterItem[]} master - 总大纲：所有卷的概要
 * @property {HierarchicalVolume[]} volumes - 逐卷详细大纲
 */

/**
 * @typedef {Object} OutlineArtifact
 * @property {string} id
 * @property {OutlineNode[]} nodes
 * @property {string} rawMarkdown
 * @property {number} version
 */

/**
 * @typedef {'idle' | 'collecting_input' | 'agent1' | 'blocking_review' | 'confirmed' | 'cancelled'} OutlinePhase
 */

/**
 * @typedef {Object} OutlineSessionState
 * @property {OutlinePhase} phase
 * @property {UserOutlineMode} mode
 * @property {string} userText
 * @property {OutlineArtifact | null} artifact
 * @property {OutlineIssue[]} blockingIssues
 * @property {string | null} lastError
 */

/**
 * @typedef {Object} HierarchicalWritingContext
 * @property {number} volumeIndex
 * @property {number} sectionIndex
 * @property {number} chapterIndex
 * @property {string} [chapterTitle]
 * @property {string} [masterOutline]
 * @property {string} [volumeOutline]
 */

/**
 * @typedef {'idle' | 'requirements' | 'remote_draft' | 'agent4' | 'agent5' | 'ready_to_save' | 'agent6' | 'done'} WritingPhase
 */
 * @typedef {Object} WritingRequirements
 * @property {number} targetWordCount
 * @property {number} chapterCount
 * @property {string} [extraNotes]
 */

/**
 * @typedef {Object} ParagraphRef
 * @property {string} id
 * @property {number} index
 * @property {string} text
 */

/**
 * @typedef {Object} StyleAnnotation
 * @property {string} id
 * @property {string} paragraphId
 * @property {number} start
 * @property {number} end
 * @property {string} reason
 */

/**
 * Agent 4 action
 * @typedef {'unify_style' | 'update_style_memory' | 'pass'} StyleUserAction
 */

/**
 * @typedef {Object} QualityAnnotation
 * @property {string} id
 * @property {string} paragraphId
 * @property {string} kind
 * @property {string} note
 */

/**
 * @typedef {'keep' | 'rewrite'} QualityUserChoice
 */

/**
 * @typedef {Object} ChapterNamingConfig
 * @property {string} rule - 命名规则模板，如 "第{n}章"、"Chapter {n}"、"章节{n}"。{n} = 阿拉伯数字, {cn} = 中文数字
 * @property {string} [separator] - 标题分隔符，默认 "："
 */

/**
 * @typedef {Object} ChapterEntry
 * @property {string} id
 * @property {string} fileName - 内部文件名，如 "chapter-001.md"
 * @property {string} content
 * @property {string} [_title] - 从 Markdown # 标题提取的章节名
 * @property {string} [displayName] - 计算后的显示名，如 "第一章：苟利国家生死以"
 */

/**
 * @typedef {Object} SkillSpec
 * @property {string} id - 唯一标识
 * @property {string} name - 显示名
 * @property {string} [description] - 描述
 * @property {string} content - Markdown 正文
 * @property {string[]} [tags] - 分类标签
 * @property {string[]} [assignedSubagentIds] - 关联的 subagent ID 列表
 * @property {number} [schemaVersion]
 */

/**
 * @typedef {Object} PeekSession
 * @property {string} paragraphId
 * @property {string} original
 * @property {string} candidate
 * @property {'idle' | 'pending' | 'done'} status
 */

export const OUTLINE_PHASE = {
  IDLE: 'idle',
  COLLECTING_INPUT: 'collecting_input',
  AGENT1: 'agent1',
  BLOCKING_REVIEW: 'blocking_review',
  CONFIRMED: 'confirmed',
  CANCELLED: 'cancelled',
};

export const WRITING_PHASE = {
  IDLE: 'idle',
  REQUIREMENTS: 'requirements',
  REMOTE_DRAFT: 'remote_draft',
  AGENT4: 'agent4',
  AGENT5: 'agent5',
  READY_TO_SAVE: 'ready_to_save',
  AGENT6: 'agent6',
  DONE: 'done',
};

export const TIMELINE_ISSUE_KIND = {
  MOBILITY: 'mobility',
  INFORMATION: 'information',
};
