import React, { useState } from 'react';
import { FileText, Settings, Search, GitBranch, MessageSquare, BookOpen } from 'lucide-react';
import { WorkflowPanel } from '@/components/WorkflowPanel.jsx';

function App() {
  const [activeSidebarItem, setActiveSidebarItem] = useState('explorer');
  const [bottomTab, setBottomTab] = useState('workflow');

  return (
    <div className="flex h-screen w-screen bg-vscode-bg text-vscode-text overflow-hidden">
      
      {/* Activity Bar (Leftmost narrow sidebar) */}
      <div className="w-12 bg-vscode-activity-bar flex flex-col items-center py-2 justify-between border-r border-vscode-panel-border z-10">
        <div className="flex flex-col gap-2 w-full">
          <ActivityBarItem 
            icon={<FileText size={24} />} 
            active={activeSidebarItem === 'explorer'} 
            onClick={() => setActiveSidebarItem('explorer')} 
            label="Explorer"
          />
          <ActivityBarItem 
            icon={<Search size={24} />} 
            active={activeSidebarItem === 'search'} 
            onClick={() => setActiveSidebarItem('search')} 
            label="Search"
          />
          <ActivityBarItem 
            icon={<GitBranch size={24} />} 
            active={activeSidebarItem === 'source-control'} 
            onClick={() => setActiveSidebarItem('source-control')} 
            label="Source Control"
          />
          <ActivityBarItem 
            icon={<BookOpen size={24} />} 
            active={activeSidebarItem === 'novel-structure'} 
            onClick={() => setActiveSidebarItem('novel-structure')} 
            label="Novel Structure"
          />
        </div>
        <div className="flex flex-col gap-2 w-full mb-2">
           <ActivityBarItem 
            icon={<Settings size={24} />} 
            active={activeSidebarItem === 'settings'} 
            onClick={() => setActiveSidebarItem('settings')} 
            label="Settings"
          />
        </div>
      </div>

      {/* Sidebar (File explorer, etc.) */}
      <div className="w-64 bg-vscode-sidebar flex flex-col border-r border-vscode-panel-border">
        <div className="h-9 px-4 flex items-center text-xs font-bold tracking-wide uppercase text-gray-400">
          {activeSidebarItem === 'explorer' && 'Explorer'}
          {activeSidebarItem === 'search' && 'Search'}
          {activeSidebarItem === 'source-control' && 'Source Control'}
          {activeSidebarItem === 'novel-structure' && 'Novel Structure'}
          {activeSidebarItem === 'settings' && 'Settings'}
        </div>
        
        {/* Sidebar Content Area */}
        <div className="flex-1 overflow-y-auto p-2">
             {activeSidebarItem === 'explorer' && (
                <div className="text-sm">
                    <div className="font-bold mb-2 px-2 text-gray-400">OPEN EDITORS</div>
                    <div className="px-2 py-1 bg-vscode-active-item cursor-pointer text-white flex items-center gap-2">
                        <span className="text-yellow-400 text-xs">JS</span>
                        chapter1.txt
                    </div>
                     <div className="font-bold mt-4 mb-2 px-2 text-gray-400">MY NOVEL</div>
                    <div className="pl-4 cursor-pointer hover:bg-vscode-active-item py-1">Chapter 1: The Beginning</div>
                    <div className="pl-4 cursor-pointer hover:bg-vscode-active-item py-1">Chapter 2: The Middle</div>
                    <div className="pl-4 cursor-pointer hover:bg-vscode-active-item py-1">Chapter 3: The End</div>
                </div>
             )}
             {activeSidebarItem === 'novel-structure' && (
                 <div className="text-sm px-2">
                     <p>Plot outlines, character sheets, and world building info will be here.</p>
                 </div>
             )}
        </div>
      </div>

      {/* Main Editor Area */}
      <div className="flex-1 flex flex-col bg-vscode-editor-bg min-w-0">
        
        {/* Tabs */}
        <div className="flex bg-vscode-sidebar border-b border-vscode-panel-border overflow-x-auto h-9">
            <TabItem title="chapter1.txt" active={true} />
            <TabItem title="scene_outline.md" active={false} />
            <TabItem title="character_sheet.json" active={false} />
        </div>

        {/* Editor Content (Placeholder for now) */}
        <div className="flex-1 p-4 font-mono text-sm overflow-auto text-gray-300">
          <p className="mb-2"><span className="text-blue-400"># Chapter 1: The Beginning</span></p>
          <p className="mb-2">It was a dark and stormy night. The AI assistant was ready to help write the next bestseller.</p>
          <p className="mb-2">...</p>
          <p className="text-gray-500 italic">// Start typing your story here...</p>
        </div>

        {/* AI Assistant Panel (Bottom or Right - Let's put it on the right for now like Copilot Chat or a Terminal) */}
        <div className="h-1/3 border-t border-vscode-panel-border flex flex-col bg-vscode-panel-bg">
             <div className="h-8 border-b border-vscode-panel-border flex items-center px-4 justify-between shrink-0">
                <div className="flex gap-4 text-xs font-bold text-gray-400">
                    <button
                      type="button"
                      className={`cursor-pointer pb-1 border-b-2 ${bottomTab === 'workflow' ? 'text-white border-white' : 'border-transparent hover:text-gray-200'}`}
                      onClick={() => setBottomTab('workflow')}
                    >
                      Workflow
                    </button>
                    <button
                      type="button"
                      className={`cursor-pointer pb-1 border-b-2 ${bottomTab === 'chat' ? 'text-white border-white' : 'border-transparent hover:text-gray-200'}`}
                      onClick={() => setBottomTab('chat')}
                    >
                      AI Chat
                    </button>
                    <span className="cursor-pointer hover:text-gray-200">Terminal</span>
                    <span className="cursor-pointer hover:text-gray-200">Output</span>
                </div>
             </div>
             <div className="flex-1 p-4 overflow-y-auto min-h-0">
                 {bottomTab === 'workflow' && <WorkflowPanel />}
                 {bottomTab === 'chat' && (
                   <div className="flex gap-2 mb-4">
                     <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center text-xs">AI</div>
                     <div className="bg-vscode-active-item p-2 rounded max-w-[80%] text-sm">
                         Hello! I&apos;m your AI writing assistant. How can I help you with your novel today?
                     </div>
                   </div>
                 )}
             </div>
             <div className="p-2 border-t border-vscode-panel-border">
                 <div className="flex gap-2 bg-vscode-sidebar border border-vscode-panel-border rounded p-1">
                     <input type="text" placeholder="Ask AI..." className="bg-transparent border-none outline-none flex-1 px-2 text-sm text-white" />
                     <button className="p-1 hover:bg-vscode-active-item rounded"><MessageSquare size={16}/></button>
                 </div>
             </div>
        </div>
      </div>

      {/* Status Bar */}
      <div className="h-6 bg-vscode-status-bar text-white text-xs flex items-center px-2 justify-between absolute bottom-0 w-full z-20">
          <div className="flex gap-4">
              <span className="flex items-center gap-1"><GitBranch size={12} /> main</span>
              <span>0 errors, 0 warnings</span>
          </div>
          <div className="flex gap-4">
              <span>Ln 3, Col 15</span>
              <span>UTF-8</span>
              <span>Markdown</span>
          </div>
      </div>

    </div>
  );
}

function ActivityBarItem({ icon, active, onClick, label }) {
    return (
        <div 
            onClick={onClick}
            className={`cursor-pointer p-3 w-full flex justify-center border-l-2 ${active ? 'border-white text-white' : 'border-transparent text-gray-500 hover:text-white'}`}
            title={label}
        >
            {icon}
        </div>
    )
}

function TabItem({ title, active }) {
    return (
        <div className={`px-3 py-1.5 min-w-[120px] flex items-center gap-2 border-r border-vscode-panel-border cursor-pointer text-sm ${active ? 'bg-vscode-editor-bg text-white border-t-2 border-t-blue-500' : 'bg-vscode-sidebar text-gray-400 hover:bg-[#2a2d2e]'}`}>
            <span className="truncate">{title}</span>
            {active && <span className="ml-auto hover:bg-gray-600 rounded-full w-4 h-4 flex items-center justify-center text-xs">×</span>}
        </div>
    )
}

export default App;
