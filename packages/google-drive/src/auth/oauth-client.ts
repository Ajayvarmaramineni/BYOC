import { BYOCErrorCode, StorageError } from "@byoc/core";
import {
  GoogleDriveScope,
  type AuthorizationUrlOptions,
  type ExchangeCodeOptions,
  type GoogleDriveAuthConfig,
  type GoogleDriveTokenSession,
  type GoogleTokenStorage
} from "./types.js";
import { InMemoryTokenStorage } from "./storage.js";
import { mapGoogleDriveError } from "../errors/mapper.js";

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

/**
 * GoogleOAuthClient — Manages OAuth 2.0 PKCE handshake, token refresh, and storage.
 */
export class GoogleOAuthClient {
  public readonly config: GoogleDriveAuthConfig;
  public readonly storage: GoogleTokenStorage;

  constructor(config: GoogleDriveAuthConfig) {
    if (!config || !config.clientId) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: "GoogleOAuthClient requires a valid 'clientId'.",
        provider: "google-drive",
        retryable: false
      });
    }

    this.config = {
      ...config,
      scopes: config.scopes && config.scopes.length > 0 ? config.scopes : [GoogleDriveScope.FILE]
    };

    this.storage = config.tokenStorage ?? new InMemoryTokenStorage(config.session);
  }

  /**
   * Generates the Google OAuth 2.0 consent URL.
   */
  public getAuthorizationUrl(options: AuthorizationUrlOptions = {}): string {
    const scopes = options.scopes ?? this.config.scopes ?? [GoogleDriveScope.FILE];
    const redirectUri = options.redirectUri ?? this.config.redirectUri;

    if (!redirectUri) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: "Cannot generate authorization URL: 'redirectUri' is required.",
        provider: "google-drive",
        retryable: false
      });
    }

    const url = new URL(GOOGLE_AUTH_ENDPOINT);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", scopes.join(" "));
    url.searchParams.set("access_type", options.accessType ?? "offline");
    url.searchParams.set("prompt", options.prompt ?? "consent");

    if (options.state) {
      url.searchParams.set("state", options.state);
    }

    if (options.codeChallenge) {
      url.searchParams.set("code_challenge", options.codeChallenge);
      url.searchParams.set("code_challenge_method", options.codeChallengeMethod ?? "S256");
    }

    return url.toString();
  }

  /**
   * Exchanges an authorization code for access and refresh tokens.
   */
  public async exchangeCode(options: ExchangeCodeOptions): Promise<GoogleDriveTokenSession> {
    const redirectUri = options.redirectUri ?? this.config.redirectUri;

    if (!redirectUri) {
      throw new StorageError({
        code: BYOCErrorCode.INVALID_INPUT,
        message: "Cannot exchange authorization code: 'redirectUri' is required.",
        provider: "google-drive",
        retryable: false
      });
    }

    const bodyParams = new URLSearchParams();
    bodyParams.set("client_id", this.config.clientId);
    if (this.config.clientSecret) {
      bodyParams.set("client_secret", this.config.clientSecret);
    }
    bodyParams.set("code", options.code);
    bodyParams.set("grant_type", "authorization_code");
    bodyParams.set("redirect_uri", redirectUri);

    if (options.codeVerifier) {
      bodyParams.set("code_verifier", options.codeVerifier);
    }

    try {
      const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: bodyParams.toString()
      });

      const data = (await response.json()) as any;

      if (!response.ok || data.error) {
        throw mapGoogleDriveError({
          status: response.status,
          data: { error: { message: data.error_description || data.error, code: response.status } }
        });
      }

      const session: GoogleDriveTokenSession = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        tokenType: data.token_type,
        scope: data.scope,
        expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : undefined
      };

      await this.storage.set(session);
      return session;
    } catch (err) {
      throw mapGoogleDriveError(err);
    }
  }

  /**
   * Retrieves a valid access token, automatically refreshing if expired.
   */
  public async getAccessToken(): Promise<string> {
    const session = await this.storage.get();

    if (!session || !session.accessToken) {
      throw new StorageError({
        code: BYOCErrorCode.AUTH_REQUIRED,
        message: "No active Google Drive session found. Please authenticate via connect().",
        provider: "google-drive",
        statusCode: 401,
        retryable: false
      });
    }

    // Check if token is expired with a 60-second safety margin
    const safetyMarginMs = 60 * 1000;
    const isExpired = session.expiresAt ? Date.now() + safetyMarginMs >= session.expiresAt : false;

    if (isExpired) {
      if (session.refreshToken) {
        const refreshed = await this.refreshAccessToken(session.refreshToken);
        return refreshed.accessToken;
      } else {
        throw new StorageError({
          code: BYOCErrorCode.TOKEN_EXPIRED,
          message: "Google Drive access token has expired and no refresh token is available. Re-authentication required.",
          provider: "google-drive",
          statusCode: 401,
          retryable: false
        });
      }
    }

    return session.accessToken;
  }

  /**
   * Refreshes an expired access token using the refresh token.
   */
  public async refreshAccessToken(refreshTokenOverride?: string): Promise<GoogleDriveTokenSession> {
    const currentSession = await this.storage.get();
    const refreshToken = refreshTokenOverride ?? currentSession?.refreshToken;

    if (!refreshToken) {
      throw new StorageError({
        code: BYOCErrorCode.AUTH_REQUIRED,
        message: "Cannot refresh token: No refresh token available in active session.",
        provider: "google-drive",
        statusCode: 401,
        retryable: false
      });
    }

    const bodyParams = new URLSearchParams();
    bodyParams.set("client_id", this.config.clientId);
    if (this.config.clientSecret) {
      bodyParams.set("client_secret", this.config.clientSecret);
    }
    bodyParams.set("refresh_token", refreshToken);
    bodyParams.set("grant_type", "refresh_token");

    try {
      const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: bodyParams.toString()
      });

      const data = (await response.json()) as any;

      if (!response.ok || data.error) {
        throw mapGoogleDriveError({
          status: response.status,
          data: { error: { message: data.error_description || data.error, code: response.status } }
        });
      }

      const updatedSession: GoogleDriveTokenSession = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? refreshToken, // Retain existing refresh token if not rotated
        tokenType: data.token_type ?? currentSession?.tokenType,
        scope: data.scope ?? currentSession?.scope,
        expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : undefined
      };

      await this.storage.set(updatedSession);
      return updatedSession;
    } catch (err) {
      throw mapGoogleDriveError(err);
    }
  }

  /**
   * Revokes the active access or refresh token with Google and clears stored session.
   */
  public async revoke(): Promise<void> {
    const session = await this.storage.get();
    const tokenToRevoke = session?.refreshToken ?? session?.accessToken;

    if (tokenToRevoke) {
      try {
        await fetch(`${GOOGLE_REVOKE_ENDPOINT}?token=${encodeURIComponent(tokenToRevoke)}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded"
          }
        });
      } catch {
        // Revocation network errors should not prevent local session cleanup
      }
    }

    await this.storage.clear();
  }

  /**
   * Sets an existing active session manually.
   */
  public async setSession(session: GoogleDriveTokenSession): Promise<void> {
    await this.storage.set(session);
  }

  /**
   * Checks if an active session exists.
   */
  public async hasValidSession(): Promise<boolean> {
    const session = await this.storage.get();
    if (!session || !session.accessToken) return false;
    if (session.expiresAt && Date.now() >= session.expiresAt) {
      return !!session.refreshToken;
    }
    return true;
  }
}
