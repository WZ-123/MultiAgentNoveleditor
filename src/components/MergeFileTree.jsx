import { User, Globe, Book, Pen, FileText, AlertCircle, AlertTriangle, Info, Check } from 'lucide-react';

const typeConfig = {
  character: { icon: User, label: '角色冲突', color: 'text-rose-400' },
  world: { icon: Globe, label: '世界观冲突', color: 'text-emerald-400' },
  outline: { icon: Book, label: '大纲冲突', color: 'text-blue-400' },
  style: { icon: Pen, label: '文风差异', color: 'text-purple-400' },
};

const severityIcon = {
  critical: AlertCircle,
  normal: AlertTriangle,
  minor: Info,
};

const severityColor = {
  critical: 'text-rose-400',
  normal: 'text-amber-400',
  minor: 'text-blue-400',
};

export function MergeFileTree({ items, activeItemId, onSelect, summary }) {
  // Group by type
  const groups = {};
  for (const item of items) {
    const key = item.type || 'other';
    groups[key] = groups[key] || [];
    groups[key].push(item);
  }

  return (
    <div className="text-xs">
      <div className="px-2 py-1.5 text-gray-500 font-bold uppercase tracking-wider border-b border-vscode-panel-border">
        冲突文件
        {summary && (
          <span className="text-gray-600 font-normal ml-1">
            ({summary.resolved}/{summary.total})
          </span>
        )}
      </div>
      <div className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 200px)' }}>
        {Object.entries(groups).map(([type, typeItems]) => {
          const cfg = typeConfig[type] || { icon: FileText, label: type };
          const Icon = cfg.icon;
          return (
            <div key={type}>
              <div className="px-2 py-1 text-gray-400 font-medium text-[10px] uppercase tracking-wide bg-vscode-sidebar/50 flex items-center gap-1">
                <Icon size={10} />
                {cfg.label}
                <span className="text-gray-600 font-normal">({typeItems.length})</span>
              </div>
              {typeItems.map((item) => {
                const SevIcon = severityIcon[item.severity] || Info;
                const sevColor = severityColor[item.severity] || 'text-gray-400';
                const isActive = item.id === activeItemId;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onSelect(item.id)}
                    className={`w-full flex items-center gap-1.5 px-2 py-1 text-left ${isActive ? 'bg-vscode-active-item text-gray-200' : 'text-gray-400 hover:bg-vscode-active-item/50 hover:text-gray-300'}`}
                  >
                    {item.status === 'resolved' ? (
                      <Check size={10} className="text-green-400 shrink-0" />
                    ) : (
                      <SevIcon size={10} className={`${sevColor} shrink-0`} />
                    )}
                    <span className="truncate flex-1">{item.label || item.id}</span>
                    {item.status === 'resolved' && (
                      <span className="text-[10px] text-green-500 shrink-0">已解决</span>
                    )}
                    {item.status === 'disputed' && (
                      <span className="text-[10px] text-amber-500 shrink-0">争议</span>
                    )}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
