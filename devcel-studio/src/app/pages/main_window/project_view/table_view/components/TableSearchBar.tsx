import { useI18n } from '@/app/i18n';
import { Search, X } from "lucide-react";

interface TableSearchBarProps {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  onSearch: (query: string) => void;
  onClear: () => void;
}

export function TableSearchBar({
  searchQuery,
  setSearchQuery,
  onSearch,
  onClear
}: TableSearchBarProps) {
  const { t } = useI18n();
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchQuery(value);
    onSearch(value);
  };

  const handleClear = () => {
    setSearchQuery('');
    onClear();
  };

  return (
    <div className="flex min-w-40 max-w-xs flex-1 items-center gap-2">
      <div className="relative min-w-0 flex-1">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <input data-table-search aria-keyshortcuts="Control+f Meta+f"
          type="text"
          placeholder={t('grid.searchTable')}
          value={searchQuery}
          onChange={handleInputChange}
          className="w-full pl-10 pr-10 h-[38px] text-sm border border-border rounded-lg focus:outline-hidden focus:ring-2 focus:ring-ring focus:border-transparent bg-muted hover:bg-background transition-colors"
        />
        {searchQuery && (
          <button
            onClick={handleClear}
            aria-label={t('grid.clearSearch')}
            className="absolute right-2 top-1/2 transform -translate-y-1/2 p-1 rounded hover:bg-muted transition-colors"
          >
            <X className="h-4 w-4 text-muted-foreground hover:text-muted-foreground" />
          </button>
        )}
      </div>
    </div>
  );
}