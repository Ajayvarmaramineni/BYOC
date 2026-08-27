/**
 * Permitted Google Drive OAuth scopes.
 * BYOC defaults strictly to `drive.file` to avoid Google Restricted Scope verification barriers.
 */
export const GoogleDriveScope = {
  /** Access only to files created or opened by this app (Standard Default) */
  FILE: "https://www.googleapis.com/auth/drive.file",
  /** Access to application data folder for hidden sync/indexes */
  APP_DATA: "https://www.googleapis.com/auth/drive.appdata",
  /** Read-only access to files created or opened by this app */
  FILE_READONLY: "https://www.googleapis.com/auth/drive.file.readonly"
} as const;

export type GoogleDriveScope = typeof GoogleDriveScope[keyof typeof GoogleDriveScope];

export interface GoogleDriveTokenSession {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // Unix timestamp in ms
  tokenType?: string;
  scope?: string;
}

export interface GoogleTokenStorage {
  get(): Promise<GoogleDriveTokenSession | null> | GoogleDriveTokenSession | null;
  set(session: GoogleDriveTokenSession): Promise<void> | void;
  clear(): Promise<void> | void;
}

export interface AuthorizationUrlOptions {
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: "S256" | "plain";
  redirectUri?: string;
  prompt?: "consent" | "select_account" | "none";
  accessType?: "offline" | "online";
  scopes?: GoogleDriveScope[];
}

export interface ExchangeCodeOptions {
  code: string;
  codeVerifier?: string;
  redirectUri?: string;
}

export interface GoogleDriveAuthConfig {
  clientId: string;
  clientSecret?: string;
  redirectUri?: string;
  scopes?: GoogleDriveScope[];
  tokenStorage?: GoogleTokenStorage;
  /** Existing active session (optional, for pre-authenticated clients) */
  session?: GoogleDriveTokenSession;
}

export interface GoogleDriveProviderConfig {
  auth: GoogleDriveAuthConfig;
  /** App root folder name in Drive (defaults to "BYOC") */
  rootFolderName?: string;
}
