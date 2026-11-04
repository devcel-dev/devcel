import { invoke } from '@tauri-apps/api/core';
import type { CreatedFile, MovedFile, FileOperation, FileOperationResult } from '@/types/fileOperation';

type CreateOperation = Extract<FileOperation, { type: 'Create' }>;
type MoveOperation = Extract<FileOperation, { type: 'Move' }>;

export function fileOperation(operation: CreateOperation, expectedProjectSession: string): Promise<CreatedFile>;
export function fileOperation(operation: MoveOperation, expectedProjectSession: string): Promise<MovedFile | void>;
export function fileOperation(operation: Exclude<FileOperation, CreateOperation | MoveOperation>, expectedProjectSession: string): Promise<void>;
export async function fileOperation(operation: FileOperation, expectedProjectSession: string): Promise<CreatedFile | MovedFile | void> {
  const result = await invoke<FileOperationResult>('file_operation', { operation, expectedProjectSession });
  if (operation.type === 'Create' && result.type === 'Created' && result.entry.file_type === operation.file_type) return result.entry;
  if (operation.type === 'Move' && result.type === 'Moved' && result.entry.file_type === operation.file_type) return result.entry;
  if (operation.type !== 'Create' && result.type === 'Completed') return;
  throw new Error('Unexpected file operation result');
}
