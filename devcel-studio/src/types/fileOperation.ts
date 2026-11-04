// Unified file operation type definitions

export type FileType = 'Table' | 'Interface' | 'Markdown' | 'Directory';

export type FileOperation = 
  | {
      type: 'Create';
      file_type: FileType;
      path: string;
      content?: string;
    }
  | {
      type: 'Delete';
      file_type: FileType;
      path: string;
    }
  | {
      type: 'Move';
      file_type: FileType;
      old_path: string;
      new_path: string;
    }
  | {
      type: 'Rename';
      file_type: FileType;
      old_path: string;
      new_name: string;
    }
  | {
      type: 'Duplicate';
      file_type: FileType;
      source_path: string;
      dest_path: string;
    };

/** Authoritative identity of the entry actually created by the backend. */
export type CreatedFile =
  | { file_type: 'Table' | 'Interface'; path: string; uuid: string }
  | { file_type: 'Markdown' | 'Directory'; path: string; uuid: null };

/** A moved table can also be an unparseable file with no loaded UUID. */
export type MovedFile = { file_type: 'Table'; path: string; uuid: string | null };

export type FileOperationResult =
  | { type: 'Created'; entry: CreatedFile }
  | { type: 'Moved'; entry: MovedFile }
  | { type: 'Completed' };
