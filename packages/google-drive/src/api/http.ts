import { withRetry, type StorageObject } from "@byoc/core";
import { GoogleOAuthClient } from "../auth/oauth-client.js";
import { mapGoogleDriveError } from "../errors/mapper.js";
import type {
  DriveFileResource,
  DriveFileListResponse,
  DriveAboutResource
} from "./types.js";
import { Readable } from "node:stream";

export const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
export const DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";

/**
 * DriveHttpClient — Handles low-level authenticated REST requests to the Google Drive API v3.
 */
export class DriveHttpClient {
  constructor(public readonly oauth: GoogleOAuthClient) {}

  /**
   * Executes an authenticated JSON request with automatic exponential backoff.
   */
  public async request<T>(
    url: string,
    options: RequestInit = {}
  ): Promise<T> {
    return withRetry(async () => {
      const accessToken = await this.oauth.getAccessToken();
      const headers = new Headers(options.headers || {});
      headers.set("Authorization", `Bearer ${accessToken}`);

      const response = await fetch(url, {
        ...options,
        headers
      });

      if (!response.ok) {
        let errorData: unknown;
        try {
          errorData = await response.json();
        } catch {
          errorData = await response.text();
        }
        throw mapGoogleDriveError({ status: response.status, data: errorData });
      }

      if (response.status === 204) {
        return undefined as unknown as T;
      }

      return (await response.json()) as T;
    }, {
      maxRetries: 3,
      baseDelayMs: 500
    });
  }

  /**
   * Performs a multipart upload (metadata + media) in a single HTTP request.
   */
  public async uploadMultipart(
    boundary: string,
    body: Uint8Array
  ): Promise<DriveFileResource> {
    const url = `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,mimeType,size,parents,createdTime,modifiedTime,md5Checksum,trashed`;

    return withRetry(async () => {
      const accessToken = await this.oauth.getAccessToken();
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": `multipart/related; boundary=${boundary}`,
          "Content-Length": String(body.byteLength)
        },
        body: body as any
      });

      if (!response.ok) {
        let errorData: unknown;
        try {
          errorData = await response.json();
        } catch {
          errorData = await response.text();
        }
        throw mapGoogleDriveError({ status: response.status, data: errorData });
      }

      return (await response.json()) as DriveFileResource;
    }, {
      maxRetries: 3,
      baseDelayMs: 500
    });
  }

  /**
   * Downloads the raw binary media for a file ID.
   */
  public async downloadMedia(fileId: string): Promise<{
    stream: Readable | ReadableStream;
    arrayBuffer: () => Promise<ArrayBuffer>;
    text: () => Promise<string>;
  }> {
    const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`;

    return withRetry(async () => {
      const accessToken = await this.oauth.getAccessToken();
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      });

      if (!response.ok) {
        let errorData: unknown;
        try {
          errorData = await response.json();
        } catch {
          errorData = await response.text();
        }
        throw mapGoogleDriveError({ status: response.status, data: errorData });
      }

      const stream = (response.body ?? Readable.from([])) as any;

      return {
        stream,
        arrayBuffer: async () => response.arrayBuffer(),
        text: async () => response.text()
      };
    }, {
      maxRetries: 3,
      baseDelayMs: 500
    });
  }

  /**
   * Retrieves metadata for a file ID.
   */
  public async getFile(fileId: string): Promise<DriveFileResource> {
    const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,parents,createdTime,modifiedTime,md5Checksum,trashed,appProperties`;
    return this.request<DriveFileResource>(url, { method: "GET" });
  }

  /**
   * Queries files matching a Drive query string.
   */
  public async listFiles(
    query?: string,
    pageSize: number = 100,
    pageToken?: string
  ): Promise<DriveFileListResponse> {
    const url = new URL(`${DRIVE_API_BASE}/files`);
    url.searchParams.set("pageSize", String(pageSize));
    url.searchParams.set(
      "fields",
      "nextPageToken,files(id,name,mimeType,size,parents,createdTime,modifiedTime,md5Checksum,trashed,appProperties)"
    );

    if (query) {
      url.searchParams.set("q", query);
    }
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }

    return this.request<DriveFileListResponse>(url.toString(), { method: "GET" });
  }

  /**
   * Creates a folder node in Google Drive.
   */
  public async createFolder(name: string, parentId?: string): Promise<DriveFileResource> {
    const url = `${DRIVE_API_BASE}/files?fields=id,name,mimeType,parents,createdTime,modifiedTime`;
    const metadata: Record<string, unknown> = {
      name,
      mimeType: "application/vnd.google-apps.folder"
    };

    if (parentId) {
      metadata.parents = [parentId];
    }

    return this.request<DriveFileResource>(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(metadata)
    });
  }

  /**
   * Copies a file server-side in Google Drive without redownloading.
   */
  public async copyFile(
    fileId: string,
    newName?: string,
    parentFolderId?: string
  ): Promise<DriveFileResource> {
    const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/copy?fields=id,name,mimeType,size,parents,createdTime,modifiedTime`;
    const body: Record<string, unknown> = {};
    if (newName) body.name = newName;
    if (parentFolderId) body.parents = [parentFolderId];

    return this.request<DriveFileResource>(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  /**
   * Updates file metadata / parents server-side in Google Drive (instantaneous server-side move).
   */
  public async moveFile(
    fileId: string,
    newParentId: string,
    oldParentId?: string,
    newName?: string
  ): Promise<DriveFileResource> {
    const url = new URL(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`);
    url.searchParams.set("addParents", newParentId);
    if (oldParentId) {
      url.searchParams.set("removeParents", oldParentId);
    }
    url.searchParams.set("fields", "id,name,parents,modifiedTime");

    const body: Record<string, unknown> = {};
    if (newName) body.name = newName;

    return this.request<DriveFileResource>(url.toString(), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  /**
   * Sends a file or folder to Google Drive Trash (soft-delete).
   */
  public async trashFile(fileId: string): Promise<DriveFileResource> {
    const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?fields=id,trashed`;
    return this.request<DriveFileResource>(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true })
    });
  }

  /**
   * Permanently deletes a file or folder in Google Drive.
   */
  public async deleteFile(fileId: string): Promise<void> {
    const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`;
    await this.request<void>(url, { method: "DELETE" });
  }

  /**
   * Retrieves account storage quota.
   */
  public async getAboutQuota(): Promise<DriveAboutResource> {
    const url = `${DRIVE_API_BASE}/about?fields=storageQuota,user`;
    return this.request<DriveAboutResource>(url, { method: "GET" });
  }

  /**
   * Helper to format a DriveFileResource into a standard StorageObject.
   */
  public toStorageObject(resource: DriveFileResource, virtualPath: string): StorageObject {
    const isFolder = resource.mimeType === "application/vnd.google-apps.folder";

    return {
      id: `gdrive_${resource.id}`,
      path: virtualPath,
      name: resource.name,
      provider: "google-drive",
      providerId: resource.id,
      type: isFolder ? "folder" : "file",
      size: resource.size ? Number(resource.size) : undefined,
      mimeType: resource.mimeType,
      checksum: resource.md5Checksum,
      createdAt: resource.createdTime ? new Date(resource.createdTime) : undefined,
      updatedAt: resource.modifiedTime ? new Date(resource.modifiedTime) : undefined,
      metadata: resource.appProperties
    };
  }
}
