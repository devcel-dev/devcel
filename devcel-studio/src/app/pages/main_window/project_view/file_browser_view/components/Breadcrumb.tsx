import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

interface BreadcrumbProps {
  currentPath: string;
  onNavigate: (path: string) => void;
}

export function Breadcrumb({ currentPath, onNavigate }: BreadcrumbProps) {
  const pathParts = currentPath.split('/').filter(part => part !== '');
  
  if (pathParts.length === 0) {
    return null;
  }
  
  return (
    <div className="flex items-center gap-1 text-sm overflow-x-auto">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onNavigate('')}
        className="h-5 px-1.5 text-muted-foreground hover:text-foreground hover:bg-muted"
      >
        /
      </Button>
      {pathParts.map((part, index) => {
        const path = pathParts.slice(0, index + 1).join('/');
        const isLast = index === pathParts.length - 1;
        
        return (
          <div key={path} className="flex items-center">
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => !isLast && onNavigate(path)}
              className={`h-5 px-1.5 ${
                isLast 
                  ? 'font-semibold text-foreground cursor-default hover:bg-transparent' 
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
              disabled={isLast}
            >
              {part}
            </Button>
          </div>
        );
      })}
    </div>
  );
} 