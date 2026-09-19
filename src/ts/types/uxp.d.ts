// Hand-written ambient types for the slice of the `uxp` module this plugin
// actually calls. No official/DefinitelyTyped package covers `uxp` itself
// (only `photoshop`), so this is scoped to exactly what's used rather than
// attempting a full API surface.
declare module "uxp" {
  export interface UxpEntryMetadata {
    size: number;
    dateCreated?: Date;
    dateModified?: Date;
  }

  export interface UxpFileEntry {
    readonly name: string;
    readonly nativePath: string;
    readonly isFile: true;
    readonly isFolder: false;
    read(options?: { format?: string }): Promise<string | ArrayBuffer>;
    write(data: string | ArrayBuffer, options?: { format?: string }): Promise<void>;
    delete(): Promise<void>;
    getMetadata(): Promise<UxpEntryMetadata>;
  }

  export interface UxpFolderEntry {
    readonly name: string;
    readonly nativePath: string;
    readonly isFile: false;
    readonly isFolder: true;
    getEntry(name: string): Promise<UxpFileEntry | UxpFolderEntry>;
    getEntries(): Promise<Array<UxpFileEntry | UxpFolderEntry>>;
    createFile(name: string, options?: { overwrite?: boolean }): Promise<UxpFileEntry>;
    createFolder(name: string): Promise<UxpFolderEntry>;
    delete(): Promise<void>;
  }

  export type UxpEntry = UxpFileEntry | UxpFolderEntry;

  export interface UxpFileFormats {
    utf8: string;
    binary: string;
  }

  export interface UxpLocalFileSystem {
    getDataFolder(): Promise<UxpFolderEntry>;
    getPluginFolder(): Promise<UxpFolderEntry>;
    getFileForSaving(
      suggestedName: string,
      options?: { types?: string[] }
    ): Promise<UxpFileEntry | null>;
  }

  export const storage: {
    localFileSystem: UxpLocalFileSystem;
    formats: UxpFileFormats;
  };

  export const shell: {
    openPath(path: string, message?: string): Promise<boolean>;
    openExternal(url: string): Promise<void>;
  };

  export interface UxpPanelEntrypoint {
    show?(event?: unknown): void | Promise<void>;
    hide?(event?: unknown): void | Promise<void>;
  }

  export const entrypoints: {
    setup(config: { panels?: Record<string, UxpPanelEntrypoint> }): void;
  };
}
