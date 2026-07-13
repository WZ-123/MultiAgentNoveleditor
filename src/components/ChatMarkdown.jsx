import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const markdownComponents = {
  table({ node: _node, ...props }) {
    return (
      <div className="mana-chat-table-wrap" tabIndex={0}>
        <table {...props} />
      </div>
    );
  },
};

export function ChatMarkdown({ content }) {
  return (
    <div className="mana-chat-markdown" data-testid="chat-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {String(content ?? '')}
      </ReactMarkdown>
    </div>
  );
}
