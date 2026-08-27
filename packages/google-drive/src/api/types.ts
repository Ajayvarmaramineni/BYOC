/**
 * Schema for Google Drive v3 File Resource.
 */
export interface DriveFileResource {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  size?: string; // Google Drive returns file size as string in bytes
  createdTime?: string;
  modifiedTime?: string;
  md5Checksum?: string;
  trashed?: boolean;
  properties?: Record<string, string>;
  appProperties?: Record<string, string>;
}

/**
 * Schema for Google Drive v3 File List Response.
 */
export interface DriveFileListResponse {
  kind: string;
  nextPageToken?: string;
  incompleteSearch?: boolean;
  files: DriveFileResource[];
}

/**
 * Schema for Google Drive v3 About Resource.
 */
export interface DriveAboutResource {
  storageQuota?: {
    limit?: string; // Total limit in bytes
    usage?: string; // Used in bytes
    usageInDrive?: string;
    usageInDriveTrash?: string;
  };
  user?: {
    displayName?: string;
    emailAddress?: string;
  };
}
