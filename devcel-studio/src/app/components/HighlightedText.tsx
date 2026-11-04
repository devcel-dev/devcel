interface HighlightedTextProps {
  text: string | null | undefined;
  searchQuery: string;
}

export function HighlightedText({ text, searchQuery }: HighlightedTextProps) {
  // Display normally if text or searchQuery is null, undefined, or empty
  if (!text || !searchQuery || !searchQuery.trim()) {
    return <span>{text || ''}</span>;
  }

  const regex = new RegExp(`(${searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  const parts = text.split(regex);

  return (
    <span>
      {parts.map((part, index) => 
        regex.test(part) ? (
          <mark 
            key={index} 
            className="bg-yellow-200 text-yellow-900"
            style={{ padding: 0, margin: 0 }}
          >
            {part}
          </mark>
        ) : (
          part
        )
      )}
    </span>
  );
}