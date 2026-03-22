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
 * @typedef {'idle' | 'requirements' | 'remote_draft' | 'agent4' | 'agent5' | 'ready_to_save' | 'agent6' | 'done'} WritingPhase
 */

/**
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
