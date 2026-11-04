import { appErrorException, localizedError, message } from '@/app/i18n';
import { flushMarkdownEdits } from '../utils/markdownSaveLifecycle';
import { invoke } from '@tauri-apps/api/core';
import { p2pApi } from '../api/p2p';
import { loadTable as ensureTable } from './tableCommands';

// An open instance changes even when the same project is opened again.
export type ProjectSession = {
  id: string;
  path: string;
  name: string;
  description: string;
  header_color: string;
};

export async function getProjectSession(): Promise<ProjectSession | null> {
  return await invoke<ProjectSession | null>('get_project_session');
}

export type ProjectCreateDetails = {
    path: string;           // Folder path
    name: string;           // Project name
    description: string;    // Project description
    headerColor: string;    // Header color
  };

export type TableReference = {
  path: string;
  uuid: string;
}

export type ProjectEntry = {
  path: string;
  entry_type: 'Directory' | 'Project' | 'Table' | 'Interface' | 'Markdown' | 'Other';
  modified?: number; // Unix milliseconds; unavailable timestamps sort last
  uuid?: string; // UUID for interfaces
}

export async function createProject(details : ProjectCreateDetails) {
    let result = await invoke("create_project",
    {
      name: details.name,
      path: details.path,
      description: details.description,
      headerColor: details.headerColor
    });
    if (result !== "ok") throw appErrorException(result);
    if(result === "ok") {
      // create_project opens the project locally without starting a P2P session,
      // so reopen the created project in P2P mode to bring it online
      try {
        const projectPath = await getProjectPath();
        await p2pApi.openProjectP2P(projectPath);
      } catch (err) {
        // Continue if P2P startup fails because the project itself was created successfully
        console.error("Failed to start P2P session after project creation:", err);
      }
    }
  }

  export async function hasProject() {
    return await invoke("has_project") as boolean;
  }

  export async function getProjectPath() {
    return await invoke("get_project_path") as string;
  }

  export async function getProjectName() {
    return await invoke("get_project_name") as string;
  }

  export async function getProjectDescription() {
    return await invoke("get_project_description") as string;
  }

  export async function getProjectHeaderColor() {
    return await invoke("get_project_header_color") as string;
  }

  export async function getProjectInfo() {
    const session = await getProjectSession();
    if (!session) throw localizedError(message('grid.loading.noProject'));
    return { name: session.name, description: session.description, headerColor: session.header_color, path: session.path, sessionId: session.id };
  }

  export async function updateProjectInfo(description: string, headerColor: string, expectedProjectSession: string) {
    await invoke('update_project_info', { description, color: headerColor, expectedProjectSession });
  }

  export async function saveProject(expectedProjectSession?: string) {
    const session = await getProjectSession();
    if (!session) throw localizedError(message('grid.loading.noProject'));
    if (expectedProjectSession && session.id !== expectedProjectSession) throw localizedError(message('grid.loading.sessionChanged'));
    await flushMarkdownEdits(session.id);
    const result = await invoke("save_project", { expectedProjectSession: session.id }) as string;
    if (result !== "ok") {
      throw new Error(result);
    }
  }

export async function openProject(path: string) {
    try {
      // Open in P2P mode, opening the project and connecting P2P together
      await p2pApi.openProjectP2P(path);
    } catch (err) {
      console.error("Failed to open project:", err);
      throw err;
    }
  }

// Use the regular loadTable command
  export async function loadTable(path: string, expectedProjectSession: string) {
    const result = await ensureTable(path, expectedProjectSession);
    if (result !== "ok") {
      throw new Error(result);
    }
    return result;
  }

export async function closeProject() {
    const result = await invoke<string>("close_project");
    if (result !== "ok") throw new Error(result);
  }

  export async function getTableList(expectedProjectSession: string) {
    return await invoke("get_table_list", { expectedProjectSession }) as TableReference[];
  }

  export async function getProjectEntries(expectedProjectSession: string) {
    return await invoke("get_project_entries", { expectedProjectSession }) as ProjectEntry[];
  }


  // Record operation commands
  export async function setRecordLabel(tableUuid: string, recordUuid: string, newLabel: string, expectedProjectSession: string) {
    const result = await invoke("set_record_label", {
      tableUuid: tableUuid,
      recordUuid: recordUuid,
      newLabel: newLabel, expectedProjectSession
    }) as string;
    if (result !== "ok") {
      throw new Error(result);
    }
  }

  export async function setRecordMemoText(tableUuid: string, recordUuid: string, columnUuid: string, newMemoText: string) {
    const result = await invoke("set_record_memo_text", {
      tableUuid: tableUuid,
      recordUuid: recordUuid,
      columnUuid: columnUuid,
      newMemoText: newMemoText
    }) as string;
    if (result !== "ok") {
      throw new Error(result);
    }
  }

  export async function setRecordMinVersion(tableUuid: string, recordUuid: string, newMinVersion: number) {
    const result = await invoke("set_record_min_version", {
      tableUuid: tableUuid,
      recordUuid: recordUuid,
      newMinVersion: newMinVersion
    }) as string;
    if (result !== "ok") {
      throw new Error(result);
    }
  }

  export async function setRecordParentUuid(tableUuid: string, recordUuid: string, newParentUuid: string) {
    const result = await invoke("set_record_parent_uuid", {
      tableUuid: tableUuid,
      recordUuid: recordUuid,
      newParentUuid: newParentUuid
    }) as string;
    if (result !== "ok") {
      throw new Error(result);
    }
  }

  export async function addRecordTag(tableUuid: string, recordUuid: string, tag: string) {
    const result = await invoke("add_record_tag", {
      tableUuid: tableUuid,
      recordUuid: recordUuid,
      tag: tag
    }) as string;
    if (result !== "ok") {
      throw new Error(result);
    }
  }

  export async function removeRecordTag(tableUuid: string, recordUuid: string, tag: string) {
    const result = await invoke("remove_record_tag", {
      tableUuid: tableUuid,
      recordUuid: recordUuid,
      tag: tag
    }) as string;
    if (result !== "ok") {
      throw new Error(result);
    }
  }

  // Column operation commands
  export async function setColumnColor(tableUuid: string, columnUuid: string, newColor: string) {
    const result = await invoke("set_column_color", {
      tableUuid: tableUuid,
      columnUuid: columnUuid,
      newColor: newColor
    }) as string;
    if (result !== "ok") {
      throw new Error(result);
    }
  }

  // Validation functions
  export async function validateDataName(name: string): Promise<{ isValid: boolean; errorMessage?: string }> {
    try {
      await invoke("validate_data_name_command", { name: name });
      return { isValid: true };
    } catch (error) {
      return { isValid: false, errorMessage: error as string };
    }
  }


export interface ProjectTagState { presets: string[]; revision: string; project_session: string }
export interface ProjectTagProgress { project_session: string; phase: 'scanning' | 'saving' | 'complete'; scanned_tables: number; total_tables: number }
export async function getProjectTags(expectedProjectSession: string): Promise<ProjectTagState> {
  return invoke('get_project_tags', { expectedProjectSession });
}
export async function updateProjectTag(operation: 'add' | 'rename' | 'delete', name: string, newName: string | undefined, state: ProjectTagState): Promise<{state: ProjectTagState; scanned_tables: number; changed_tables: number; changed_rows: number; changed_columns: number}> {
  return invoke('update_project_tag', { operation, name, newName, expectedRevision: state.revision, expectedProjectSession: state.project_session });
}
