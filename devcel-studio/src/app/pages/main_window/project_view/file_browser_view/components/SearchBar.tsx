import { useI18n, t } from '@/app/i18n';
import { Button } from "@/components/ui/button";
import { Search, X, Filter, Regex } from "lucide-react";

interface SearchBarProps {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  filterType: 'all' | 'folder' | 'table';
  setFilterType: (type: 'all' | 'folder' | 'table') => void;
  useRegex: boolean;
  setUseRegex: (use: boolean) => void;
}

export function SearchBar({
  searchQuery,
  setSearchQuery,
  filterType,
  setFilterType,
  useRegex,
  setUseRegex
}: SearchBarProps) {
  useI18n();
  return (
    <div className="flex gap-2">
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <input data-file-search aria-keyshortcuts="Control+f Meta+f"
          type="text"
          placeholder={t('common.searchPlaceholder')}
          value={searchQuery}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
          className="w-full pl-10 pr-10 h-9 text-sm border border-border rounded-lg focus:outline-hidden focus:ring-2 focus:ring-ring focus:border-transparent bg-muted hover:bg-background transition-colors"
        />
        {searchQuery && (
          <button
            onClick={() => setSearchQuery('')}
            className="absolute right-2 top-1/2 transform -translate-y-1/2 p-1 rounded hover:bg-muted transition-colors"
          >
            <X className="h-4 w-4 text-muted-foreground hover:text-muted-foreground" />
          </button>
        )}
      </div>
      
      <div className="relative">
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value as 'all' | 'folder' | 'table')}
          className="h-9 pl-10 pr-4 text-sm border border-border rounded-lg focus:outline-hidden focus:ring-2 focus:ring-ring focus:border-transparent appearance-none bg-muted hover:bg-background transition-colors cursor-pointer"
        >
          <option value="all">{t('common.all')}</option>
          <option value="folder">{t('common.folder')}</option>
          <option value="table">{t('common.table')}</option>
        </select>
        <Filter className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
      </div>
      
      <Button
        variant={useRegex ? "default" : "outline"}
        size="sm"
        onClick={() => setUseRegex(!useRegex)}
        className={useRegex ? "h-9 bg-primary hover:bg-primary/90" : "h-9 hover:bg-muted border-border"}
        title={t('file.regex')}
      >
        <Regex className="h-4 w-4" />
      </Button>
    </div>
  );
} 